use super::Configuration;
use crate::media::preset::EncodingPreset;

pub(super) struct Settings {
    pub level: u32,
    pub tuning: u32,
    pub spatial_aq: u32,
    pub quarter_pass: bool,
}

impl Settings {
    pub fn buffer_bits(&self, config: Configuration) -> u32 {
        let budget = if self.quarter_pass {
            config.bitrate
        } else {
            config.bitrate_limit
        };
        (budget / config.fps.max(1)).max(1)
    }
}

pub(super) fn settings(preset: EncodingPreset) -> Settings {
    // SDK tuning values: 2 = low latency, 3 = ultra-low latency. Every mode
    // retains zero B frames/lookahead and CBR in the native bridge.
    match preset {
        EncodingPreset::Balanced => Settings {
            level: 3,
            tuning: 3,
            spatial_aq: 0,
            quarter_pass: true,
        },
        EncodingPreset::Quality => Settings {
            level: 4,
            tuning: 2,
            spatial_aq: 5,
            quarter_pass: true,
        },
        EncodingPreset::Latency => Settings {
            level: 1,
            tuning: 3,
            spatial_aq: 0,
            quarter_pass: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_select_frame_analysis_and_latency_tuning() {
        let current = settings(EncodingPreset::default());
        assert_eq!(
            (current.level, current.tuning, current.spatial_aq),
            (3, 3, 0)
        );
        let fast = settings(EncodingPreset::Latency);
        let quality = settings(EncodingPreset::Quality);
        assert!(fast.level < current.level && current.level < quality.level);
        assert_eq!((fast.tuning, fast.spatial_aq), (3, 0));
        assert_eq!((quality.tuning, quality.spatial_aq), (2, 5));
        assert!(current.quarter_pass && quality.quarter_pass);
        assert!(!fast.quarter_pass);
    }
}
