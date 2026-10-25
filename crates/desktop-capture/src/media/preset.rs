//! User-facing intent, independent of backend-specific preset numbering.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EncodingPreset {
    #[default]
    Balanced,
    Quality,
    Latency,
}

impl EncodingPreset {
    pub const ALL: [Self; 3] = [Self::Balanced, Self::Quality, Self::Latency];

    /// Stable values used by numeric codec-control diagnostics.
    pub fn code(self) -> u32 {
        match self {
            Self::Balanced => 0,
            Self::Quality => 1,
            Self::Latency => 2,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_three_preset_contract_defaults_to_balanced() {
        assert_eq!(EncodingPreset::default(), EncodingPreset::Balanced);
        for (name, value) in [
            ("balanced", EncodingPreset::Balanced),
            ("quality", EncodingPreset::Quality),
            ("latency", EncodingPreset::Latency),
        ] {
            assert_eq!(serde_json::to_value(value).unwrap(), name);
            assert_eq!(
                serde_json::from_value::<EncodingPreset>(name.into()).unwrap(),
                value
            );
        }
        assert!(serde_json::from_str::<EncodingPreset>("\"unknown\"").is_err());
    }
}
