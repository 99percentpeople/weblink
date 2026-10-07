//! A two-contact touchpad gesture. Displacement is cumulative CSS pixels, with
//! positive axes meaning that content follows the fingers right/down.
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Pan {
    Start,
    Update {
        x: f64,
        y: f64,
        /// Contact-distance ratio; older viewers send only centroid displacement.
        #[serde(default = "unit_scale")]
        scale: f64,
    },
    End,
    Cancel,
}
impl Pan {
    pub fn valid(self) -> bool {
        match self {
            Self::Update { x, y, scale } => {
                x.is_finite()
                    && y.is_finite()
                    && x.abs() <= 2048.0
                    && y.abs() <= 2048.0
                    && scale.is_finite()
                    && (0.1..=4.0).contains(&scale)
            }
            _ => true,
        }
    }
}

fn unit_scale() -> f64 {
    1.0
}

#[cfg(test)]
mod tests {
    use super::Pan;

    #[test]
    fn older_viewers_without_scale_keep_the_original_contact_distance() {
        let gesture: Pan = serde_json::from_str(r#"{"phase":"update","x":10,"y":-20}"#).unwrap();
        assert_eq!(
            gesture,
            Pan::Update {
                x: 10.0,
                y: -20.0,
                scale: 1.0
            }
        );
        assert!(gesture.valid());
    }
}
