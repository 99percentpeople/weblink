//! A two-contact touchpad gesture. Displacement is cumulative CSS pixels, with
//! positive axes meaning that content follows the fingers right/down.
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Pan {
    Start,
    Update { x: f64, y: f64 },
    End,
    Cancel,
}
impl Pan {
    pub fn valid(self) -> bool {
        match self {
            Self::Update { x, y } => {
                x.is_finite() && y.is_finite() && x.abs() <= 2048.0 && y.abs() <= 2048.0
            }
            _ => true,
        }
    }
}
