//! Bounded pointer wire contract and cross-channel ordering; contains no transport or OS calls.
use crate::{
    input::{Button, Event, Position},
    protocol::{valid_id, MAX_MESSAGE_BYTES},
};
use serde::Deserialize;
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Packet {
    pub grant_id: String,
    pub generation: String,
    pub geometry_revision: String,
    pub input_epoch: String,
    pub sequence: u64,
    #[serde(default)]
    pub after: u64,
    pub event: PointerEvent,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PointerEvent {
    Activate,
    Pause,
    Move {
        x: f64,
        y: f64,
    },
    Button {
        x: f64,
        y: f64,
        button: u8,
        down: bool,
    },
    Wheel {
        x: f64,
        y: f64,
        horizontal: i32,
        vertical: i32,
    },
}
impl PointerEvent {
    fn valid(&self) -> bool {
        let position = |x: f64, y: f64| {
            x.is_finite() && y.is_finite() && (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)
        };
        match *self {
            Self::Activate | Self::Pause => true,
            Self::Move { x, y } => position(x, y),
            Self::Button { x, y, button, .. } => position(x, y) && button <= 4,
            Self::Wheel {
                x,
                y,
                horizontal,
                vertical,
            } => {
                position(x, y)
                    && (-1200..=1200).contains(&horizontal)
                    && (-1200..=1200).contains(&vertical)
            }
        }
    }
    fn input(&self) -> Event {
        match *self {
            Self::Activate | Self::Pause => Event::ReleaseAll,
            Self::Move { x, y } => Event::Move(Position { x, y }),
            Self::Button { x, y, button, down } => Event::Button {
                position: Position { x, y },
                button: match button {
                    0 => Button::Left,
                    1 => Button::Middle,
                    2 => Button::Right,
                    3 => Button::Back,
                    _ => Button::Forward,
                },
                down,
            },
            Self::Wheel {
                x,
                y,
                horizontal,
                vertical,
            } => Event::Wheel {
                position: Position { x, y },
                horizontal,
                vertical,
            },
        }
    }
}
pub fn parse(data: &[u8]) -> Option<Packet> {
    if data.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    // Match the shared JS parser's last-key-wins semantics.
    let value: serde_json::Value = serde_json::from_slice(data).ok()?;
    if value.get("type")?.as_str()? != "input" {
        return None;
    }
    let p: Packet = serde_json::from_value(value).ok()?;
    ([
        &p.grant_id,
        &p.generation,
        &p.geometry_revision,
        &p.input_epoch,
    ]
    .into_iter()
    .all(|s| valid_id(s))
        && (1..=MAX_SEQUENCE).contains(&p.sequence)
        && p.after <= MAX_SEQUENCE
        && p.event.valid())
    .then_some(p)
}

/// A grant starts paused. A fresh activation epoch is required after every pause.
/// Reliable packets must be contiguous; moves have independent latest-only sequence numbers.
pub struct Sequencer {
    grant: String,
    generation: String,
    revision: String,
    epoch: Option<String>,
    used: HashSet<String>,
    reliable: u64,
    movement: u64,
    pending: Option<(Packet, Instant)>,
    active: bool,
}
impl Sequencer {
    pub fn new(grant: String, generation: String, revision: String) -> Self {
        Self {
            grant,
            generation,
            revision,
            epoch: None,
            used: HashSet::new(),
            reliable: 0,
            movement: 0,
            pending: None,
            active: false,
        }
    }
    pub fn active(&self) -> bool {
        self.active
    }
    pub fn accept(&mut self, p: Packet, movement: bool) -> Vec<Event> {
        self.accept_at(p, movement, Instant::now())
    }
    pub fn accept_at(&mut self, p: Packet, movement: bool, received: Instant) -> Vec<Event> {
        if received.elapsed() > Duration::from_millis(100) {
            return vec![];
        }
        if p.grant_id != self.grant
            || p.generation != self.generation
            || p.geometry_revision != self.revision
        {
            return vec![];
        }
        if matches!(p.event, PointerEvent::Activate) {
            if movement
                || self.active
                || self.used.contains(&p.input_epoch)
                || self.used.len() >= 256
                || p.sequence != 1
                || p.after != 0
            {
                return vec![];
            }
            self.used.insert(p.input_epoch.clone());
            self.epoch = Some(p.input_epoch);
            self.reliable = 1;
            self.movement = 0;
            self.pending = None;
            self.active = true;
            return vec![Event::ReleaseAll];
        }
        if !self.active || self.epoch.as_ref() != Some(&p.input_epoch) {
            return vec![];
        }
        if movement {
            if !matches!(p.event, PointerEvent::Move { .. }) || p.sequence <= self.movement {
                return vec![];
            }
            self.movement = p.sequence;
            if p.after < self.reliable {
                return vec![];
            }
            if p.after > self.reliable {
                self.pending = Some((p, received));
                return vec![];
            }
            return vec![p.event.input()];
        }
        if matches!(p.event, PointerEvent::Move { .. })
            || p.sequence != self.reliable + 1
            || p.after != 0
        {
            return vec![];
        }
        self.reliable = p.sequence;
        let mut events = vec![p.event.input()];
        if matches!(p.event, PointerEvent::Pause) {
            self.active = false;
            self.pending = None;
            return events;
        }
        if let Some((pending, received)) = self.pending.take() {
            if received.elapsed() > Duration::from_millis(100) {
                return events;
            }
            if pending.after == self.reliable {
                events.push(pending.event.input());
            } else if pending.after > self.reliable {
                self.pending = Some((pending, received));
            }
        }
        events
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn packet(sequence: u64, event: PointerEvent) -> Packet {
        Packet {
            grant_id: "grant".into(),
            generation: "connection".into(),
            geometry_revision: "geometry".into(),
            input_epoch: "epoch".into(),
            sequence,
            after: 0,
            event,
        }
    }
    fn sequencer() -> Sequencer {
        Sequencer::new("grant".into(), "connection".into(), "geometry".into())
    }
    #[test]
    fn moves_wait_for_button_and_old_barriers_cannot_move_a_drag_backwards() {
        let mut s = sequencer();
        s.accept(packet(1, PointerEvent::Activate), false);
        let mut m = packet(1, PointerEvent::Move { x: 0.8, y: 0.7 });
        m.after = 2;
        assert!(s.accept(m, true).is_empty());
        let events = s.accept(
            packet(
                2,
                PointerEvent::Button {
                    x: 0.2,
                    y: 0.3,
                    button: 0,
                    down: true,
                },
            ),
            false,
        );
        assert!(matches!(
            events.as_slice(),
            [
                Event::Button { down: true, .. },
                Event::Move(Position { x: 0.8, .. })
            ]
        ));
        let mut m = packet(2, PointerEvent::Move { x: 0.1, y: 0.1 });
        m.after = 1;
        assert!(s.accept(m, true).is_empty());
    }
    #[test]
    fn pause_releases_and_requires_unseen_epoch_and_exact_grant() {
        let mut s = sequencer();
        s.accept(packet(1, PointerEvent::Activate), false);
        assert!(matches!(
            s.accept(packet(2, PointerEvent::Pause), false).as_slice(),
            [Event::ReleaseAll]
        ));
        assert!(s
            .accept(packet(1, PointerEvent::Activate), false)
            .is_empty());
        let mut p = packet(1, PointerEvent::Activate);
        p.input_epoch = "next".into();
        p.grant_id = "old".into();
        assert!(s.accept(p.clone(), false).is_empty());
        p.grant_id = "grant".into();
        assert_eq!(s.accept(p, false).len(), 1);
        assert!(s
            .accept(
                packet(
                    3,
                    PointerEvent::Button {
                        x: 0.2,
                        y: 0.3,
                        button: 0,
                        down: true
                    }
                ),
                false
            )
            .is_empty());
    }
    #[test]
    fn wire_rejects_invalid_coordinates_huge_sequences_and_channel_confusion() {
        let base = serde_json::json!({"type":"input","grantId":"g","generation":"c","geometryRevision":"r","inputEpoch":"e","sequence":1,"event":{"type":"move","x":0.5,"y":0.5}});
        assert!(parse(base.to_string().as_bytes()).is_some());
        let mut value = base.clone();
        value["event"]["x"] = serde_json::json!(1.1);
        assert!(parse(value.to_string().as_bytes()).is_none());
        let mut value = base;
        value["sequence"] = serde_json::json!(MAX_SEQUENCE + 1);
        assert!(parse(value.to_string().as_bytes()).is_none());
        let mut s = sequencer();
        assert!(s.accept(packet(1, PointerEvent::Activate), true).is_empty());
    }
    #[test]
    fn stale_queued_packets_and_pending_moves_are_not_replayed() {
        let mut s = sequencer();
        let stale = Instant::now() - Duration::from_millis(101);
        assert!(s
            .accept_at(packet(1, PointerEvent::Activate), false, stale)
            .is_empty());
        s.accept(packet(1, PointerEvent::Activate), false);
        let mut movement = packet(1, PointerEvent::Move { x: 0.9, y: 0.9 });
        movement.after = 2;
        assert!(s.accept(movement, true).is_empty());
        s.pending.as_mut().unwrap().1 = stale;
        assert!(matches!(
            s.accept(
                packet(
                    2,
                    PointerEvent::Button {
                        x: 0.2,
                        y: 0.3,
                        button: 0,
                        down: true
                    }
                ),
                false
            )
            .as_slice(),
            [Event::Button { down: true, .. }]
        ));
    }
}
