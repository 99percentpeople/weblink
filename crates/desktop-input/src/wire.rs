//! Bounded input wire contract and cross-channel ordering; contains no transport or OS calls.
use crate::{
    input::{Button, Event, Position, ScanCode},
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
    Text {
        text: String,
    },
    Key {
        #[serde(rename = "scanCode")]
        scan_code: u16,
        extended: bool,
        down: bool,
    },
    Trackpad {
        action: crate::trackpad::Event,
    },
    Touch {
        contacts: Vec<crate::touch::Contact>,
    },
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
            Self::Text { ref text } => crate::input::valid_text(text),
            Self::Key {
                scan_code,
                extended,
                ..
            } => ScanCode::new(scan_code, extended).is_some(),
            Self::Trackpad { action } => action.valid(),
            Self::Touch { ref contacts } => crate::touch::valid_frame(contacts),
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
            Self::Text { ref text } => Event::Text(text.clone()),
            Self::Key {
                scan_code,
                extended,
                down,
            } => Event::Key {
                key: ScanCode::new(scan_code, extended).expect("validated scan code"),
                down,
            },
            Self::Trackpad { action } => Event::Trackpad(action),
            Self::Touch { ref contacts } => Event::Touch(contacts.clone()),
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
    pub fn epoch(&self) -> Option<&str> {
        self.epoch.as_deref()
    }
    pub fn suspend(&mut self) {
        self.active = false;
        self.pending = None;
    }
    pub fn active(&self) -> bool {
        self.active
    }
    pub fn accept(&mut self, p: Packet, movement: bool) -> Vec<Event> {
        self.accept_at(p, movement, Instant::now())
    }
    pub fn accept_at(&mut self, p: Packet, movement: bool, received: Instant) -> Vec<Event> {
        if received.elapsed() > Duration::from_millis(100) || !p.event.valid() {
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
                || self.used.contains(&p.input_epoch)
                || self.used.len() >= 256
                || p.sequence != 1
                || p.after != 0
            {
                return vec![];
            }
            // A fresh reliable activation can replace an unacknowledged epoch.
            // Always release its input first; previously used epochs remain rejected.
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
    fn text_is_bounded_unicode_on_the_current_reliable_input_epoch() {
        let mut value = serde_json::json!({"type":"input","grantId":"grant","generation":"connection","geometryRevision":"geometry","inputEpoch":"epoch","sequence":2,"event":{"type":"text","text":"中😀"}});
        let p = parse(value.to_string().as_bytes()).unwrap();
        let mut s = sequencer();
        assert!(s.accept(p.clone(), false).is_empty());
        s.accept(packet(1, PointerEvent::Activate), false);
        assert!(s.accept(p.clone(), true).is_empty());
        let mut stale = p.clone();
        stale.input_epoch = "retired".into();
        assert!(s.accept(stale, false).is_empty());
        assert_eq!(s.accept(p.clone(), false), vec![Event::Text("中😀".into())]);
        assert!(s.accept(p, false).is_empty());
        for text in [
            "".to_string(),
            "a\n".into(),
            "\t".into(),
            "\u{0085}".into(),
            "a".repeat(65),
            "😀".repeat(33),
        ] {
            value["event"]["text"] = serde_json::json!(text);
            assert!(parse(value.to_string().as_bytes()).is_none());
        }
        value["event"]["text"] = serde_json::json!("😀".repeat(32));
        assert!(parse(value.to_string().as_bytes()).is_some());
        let malformed = value.to_string().replace(&"😀".repeat(32), "\\ud800");
        assert!(parse(malformed.as_bytes()).is_none());
    }
    #[test]
    fn keyboard_packets_validate_scan_codes_and_require_ordered_authorized_input() {
        let value = serde_json::json!({"type":"input","grantId":"grant","generation":"connection","geometryRevision":"geometry","inputEpoch":"epoch","sequence":2,"event":{"type":"key","scanCode":29,"extended":true,"down":true}});
        let key = parse(value.to_string().as_bytes()).unwrap();
        let mut s = sequencer();
        assert!(s.accept(key.clone(), false).is_empty());
        s.accept(packet(1, PointerEvent::Activate), false);
        assert!(s.accept(key.clone(), true).is_empty());
        let mut stale = key.clone();
        stale.grant_id = "retired".into();
        assert!(s.accept(stale, false).is_empty());
        assert_eq!(
            s.accept(key.clone(), false),
            vec![Event::Key {
                key: ScanCode::new(29, true).unwrap(),
                down: true
            }]
        );
        assert!(s.accept(key.clone(), false).is_empty());
        let mut repeated = key;
        repeated.sequence = 3;
        assert_eq!(
            s.accept(repeated, false),
            vec![Event::Key {
                key: ScanCode::new(29, true).unwrap(),
                down: true
            }]
        );
        assert_eq!(
            s.accept(packet(4, PointerEvent::Pause), false),
            vec![Event::ReleaseAll]
        );
        assert!(s
            .accept(
                packet(
                    5,
                    PointerEvent::Key {
                        scan_code: 29,
                        extended: true,
                        down: false
                    }
                ),
                false
            )
            .is_empty());
        for event in [
            serde_json::json!({"type":"key","scanCode":0,"extended":false,"down":true}),
            serde_json::json!({"type":"key","scanCode":30,"extended":true,"down":true}),
            serde_json::json!({"type":"key","scanCode":65536,"extended":false,"down":true}),
            serde_json::json!({"type":"key","scanCode":1.5,"extended":false,"down":true}),
            serde_json::json!({"type":"key","scanCode":30,"extended":false}),
            serde_json::json!({"type":"key","scanCode":30,"extended":false,"down":"true"}),
        ] {
            let mut invalid = value.clone();
            invalid["event"] = event;
            assert!(parse(invalid.to_string().as_bytes()).is_none());
        }
        let mut s = sequencer();
        s.accept(packet(1, PointerEvent::Activate), false);
        // Public callers also cannot bypass validation or panic the conversion.
        assert!(s
            .accept(
                packet(
                    2,
                    PointerEvent::Key {
                        scan_code: 0,
                        extended: false,
                        down: true
                    }
                ),
                false
            )
            .is_empty());
    }
    #[test]
    fn relative_gestures_are_bounded_and_reliable_only() {
        let mut value = serde_json::json!({"type":"input","grantId":"grant","generation":"connection","geometryRevision":"geometry","inputEpoch":"epoch","sequence":2,"event":{"type":"trackpad","action":{"type":"move","x":-0.1,"y":0.2}}});
        let p = parse(value.to_string().as_bytes()).unwrap();
        let mut s = sequencer();
        s.accept(packet(1, PointerEvent::Activate), false);
        assert!(s.accept(p.clone(), true).is_empty());
        assert!(
            matches!(s.accept(p.clone(), false).as_slice(), [Event::Trackpad(crate::trackpad::Event::Move {x, ..})] if *x == -0.1)
        );
        assert!(s.accept(p, false).is_empty());
        for action in [
            serde_json::json!({"type":"move","x":1.01,"y":0}),
            serde_json::json!({"type":"button","button":5,"down":true}),
            serde_json::json!({"type":"wheel","vertical":1201,"horizontal":0}),
        ] {
            value["event"]["action"] = action;
            assert!(parse(value.to_string().as_bytes()).is_none());
        }
    }
    #[test]
    fn native_interruption_rejects_the_old_epoch_and_accepts_a_fresh_activation() {
        let mut s = sequencer();
        s.accept(packet(1, PointerEvent::Activate), false);
        s.suspend();
        assert_eq!(s.epoch(), Some("epoch"));
        assert!(s
            .accept(
                packet(
                    2,
                    PointerEvent::Button {
                        x: 0.5,
                        y: 0.5,
                        button: 0,
                        down: true
                    }
                ),
                false
            )
            .is_empty());
        assert!(s
            .accept(packet(1, PointerEvent::Activate), false)
            .is_empty());
        let mut resume = packet(1, PointerEvent::Activate);
        resume.input_epoch = "fresh".into();
        assert_eq!(s.accept(resume, false), vec![Event::ReleaseAll]);
        assert!(s.active());
    }
    #[test]
    fn lost_activation_ack_can_recover_without_replaying_the_old_epoch() {
        let mut s = sequencer();
        let first = packet(1, PointerEvent::Activate);
        assert_eq!(s.accept(first.clone(), false), vec![Event::ReleaseAll]);
        let mut next = first.clone();
        next.input_epoch = "retry".into();
        assert_eq!(s.accept(next, false), vec![Event::ReleaseAll]);
        assert!(s.accept(first, false).is_empty());
        assert!(s.accept(packet(2, PointerEvent::Pause), false).is_empty());
        assert!(s.active());
        assert_eq!(s.epoch(), Some("retry"));
    }
    #[test]
    fn native_pan_is_bounded_and_reliable_only() {
        let mut s = sequencer();
        s.accept(packet(1, PointerEvent::Activate), false);
        for (i, gesture) in [
            serde_json::json!({"phase":"start"}),
            serde_json::json!({"phase":"update","x":0.25,"y":-32.5}),
            serde_json::json!({"phase":"end"}),
        ]
        .into_iter()
        .enumerate()
        {
            let mut action = gesture;
            action["type"] = serde_json::json!("pan");
            let value = serde_json::json!({"type":"input","grantId":"grant","generation":"connection","geometryRevision":"geometry","inputEpoch":"epoch","sequence":i+2,"event":{"type":"trackpad","action":action}});
            let p = parse(value.to_string().as_bytes()).unwrap();
            assert!(s.accept(p.clone(), true).is_empty());
            assert!(matches!(
                s.accept(p.clone(), false).as_slice(),
                [Event::Trackpad(crate::trackpad::Event::Pan { .. })]
            ));
            assert!(s.accept(p, false).is_empty());
        }
        for action in [
            serde_json::json!({"type":"pan","phase":"update","x":2049,"y":0}),
            serde_json::json!({"type":"pan","phase":"update","x":0}),
            serde_json::json!({"type":"pan","phase":"unknown"}),
        ] {
            let value = serde_json::json!({"type":"input","grantId":"grant","generation":"connection","geometryRevision":"geometry","inputEpoch":"epoch","sequence":5,"event":{"type":"trackpad","action":action}});
            assert!(parse(value.to_string().as_bytes()).is_none());
        }
    }
    #[test]
    fn touch_frames_are_bounded_ordered_and_cannot_use_the_motion_channel() {
        let mut value = serde_json::json!({"type":"input","grantId":"grant","generation":"connection","geometryRevision":"geometry","inputEpoch":"epoch","sequence":2,"event":{"type":"touch","contacts":[{"id":1,"x":0.2,"y":0.3,"phase":"down"}]}});
        let p = parse(value.to_string().as_bytes()).unwrap();
        let mut s = sequencer();
        s.accept(packet(1, PointerEvent::Activate), false);
        assert!(s.accept(p.clone(), true).is_empty());
        assert!(matches!(s.accept(p.clone(), false).as_slice(), [Event::Touch(c)] if c.len() == 1));
        assert!(s.accept(p, false).is_empty());
        let c = value["event"]["contacts"][0].clone();
        for contacts in [
            serde_json::json!([]),
            serde_json::json!([c, c]),
            serde_json::json!([{"id":11,"x":0.5,"y":0.5,"phase":"down"}]),
            serde_json::json!([{"id":1,"x":1.1,"y":0.5,"phase":"down"}]),
        ] {
            value["event"]["contacts"] = contacts;
            assert!(parse(value.to_string().as_bytes()).is_none());
        }
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
