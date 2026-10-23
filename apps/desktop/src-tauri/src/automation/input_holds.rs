//! Ownership and one safety deadline shared by held keys and mouse buttons.
use super::*;
use weblink_desktop_input::input::{Button, Event, Held, ScanCode};

pub(super) const HOLD_LIMIT: Duration = Duration::from_secs(30);
struct Owned {
    principal: String,
    lease: String,
    inputs: Vec<Held>,
    deadline: Instant,
}
#[derive(Default)]
pub(super) struct Holds(Option<Owned>);
impl Holds {
    fn inputs(&self, lease: &str) -> &[Held] {
        self.0
            .as_ref()
            .filter(|h| h.lease == lease)
            .map(|h| h.inputs.as_slice())
            .unwrap_or_default()
    }
    pub fn any(&self, lease: &str) -> bool {
        !self.inputs(lease).is_empty()
    }
    pub fn buttons(&self, lease: &str) -> Vec<Button> {
        self.inputs(lease)
            .iter()
            .filter_map(|h| match h {
                Held::Button(b) => Some(*b),
                _ => None,
            })
            .collect()
    }
    pub fn keys(&self, lease: &str) -> Vec<ScanCode> {
        self.inputs(lease)
            .iter()
            .filter_map(|h| match h {
                Held::Key(k) => Some(*k),
                _ => None,
            })
            .collect()
    }
    pub fn clear(&mut self, lease: &str) {
        if self.0.as_ref().is_some_and(|h| h.lease == lease) {
            self.0 = None;
        }
    }
    pub fn clear_principal(&mut self, principal: &str) {
        if self.0.as_ref().is_some_and(|h| h.principal == principal) {
            self.0 = None;
        }
    }
    pub fn update(&mut self, principal: &str, lease: &str, events: &[Event], now: Instant) {
        for event in events {
            let (input, down) = match event {
                Event::Key { key, down } => (Held::Key(*key), *down),
                Event::Button { button, down, .. } => (Held::Button(*button), *down),
                _ => continue,
            };
            if down {
                if self.0.as_ref().is_none_or(|h| h.lease != lease) {
                    self.0 = Some(Owned {
                        principal: principal.into(),
                        lease: lease.into(),
                        inputs: vec![],
                        deadline: now + HOLD_LIMIT,
                    });
                }
                let owned = self.0.as_mut().unwrap();
                if !owned.inputs.contains(&input) {
                    owned.inputs.push(input);
                }
            } else if let Some(owned) = self.0.as_mut().filter(|h| h.lease == lease) {
                owned.inputs.retain(|h| *h != input);
                if owned.inputs.is_empty() {
                    self.0 = None;
                }
            }
        }
    }
    pub fn expired(&mut self, now: Instant, interrupted: bool) -> Option<(String, String)> {
        if self
            .0
            .as_ref()
            .is_some_and(|h| interrupted || h.deadline <= now)
        {
            self.0.take().map(|h| (h.principal, h.lease))
        } else {
            None
        }
    }
    pub fn live(&self, lease: &str) -> bool {
        self.0
            .as_ref()
            .is_none_or(|h| h.lease != lease || h.deadline > Instant::now())
    }
    pub fn result(&self, lease: &str) -> Value {
        let buttons: Vec<_> = self
            .buttons(lease)
            .iter()
            .map(|b| match b {
                Button::Left => "left",
                Button::Right => "right",
                Button::Middle => "middle",
                Button::Back => "back",
                Button::Forward => "forward",
            })
            .collect();
        let keys: Vec<_> = self.keys(lease).into_iter().map(keyboard::name).collect();
        let expires = self.0.as_ref().filter(|h| h.lease == lease).map(|h| {
            h.deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u64
        });
        json!({"heldKeys":keys,"heldButtons":buttons,"holdExpiresInMs":expires})
    }
}
