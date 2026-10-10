//! Standard-layout gamepad state, independent of browser/OS representations.
use serde::Deserialize;
use std::time::Duration;

pub const MAX_GAMEPADS: u8 = 4;
pub const STALE_AFTER: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rumble {
    pub strong: u8,
    pub weak: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Feedback {
    pub grant: crate::authorization::Grant,
    pub slot: u8,
    pub id: String,
    pub rumble: Rumble,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// Standard Gamepad API button indices (0..=16), not Windows flags.
    pub buttons: u32,
    pub axes: [f32; 4],
    pub triggers: [f32; 2],
}
impl State {
    pub fn valid(&self) -> bool {
        self.buttons < (1 << 17)
            && self
                .axes
                .iter()
                .all(|v| v.is_finite() && (-1.0..=1.0).contains(v))
            && self
                .triggers
                .iter()
                .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
    }
}
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Event {
    Connect { slot: u8, id: String },
    State { slot: u8, id: String, state: State },
    Disconnect { slot: u8, id: String },
}
impl Event {
    pub fn valid(&self) -> bool {
        let (slot, id) = self.identity();
        slot < MAX_GAMEPADS
            && crate::protocol::valid_id(id)
            && match self {
                Self::State { state, .. } => state.valid(),
                _ => true,
            }
    }
    pub fn identity(&self) -> (u8, &str) {
        match self {
            Self::Connect { slot, id }
            | Self::State { slot, id, .. }
            | Self::Disconnect { slot, id } => (*slot, id),
        }
    }
}
