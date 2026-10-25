//! Stable video profiles and bandwidth buckets shared by native encoder consumers.
use super::MediaOptions;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct EncodingProfile {
    pub encoder: String,
    pub codec: Option<String>,
    width: u32,
    height: u32,
    fps: u32,
    limit: u64,
    matrix: super::color::ColorMatrix,
    range: super::color::ColorRange,
    preset: super::preset::EncodingPreset,
    // Local compatibility receivers must not share network adaptation.
    preview: bool,
}
impl EncodingProfile {
    pub fn new(encoder: &str, options: &MediaOptions, preview: bool) -> Self {
        Self {
            encoder: encoder.into(),
            codec: options.codec.clone(),
            width: options.max_width,
            height: options.max_height,
            fps: options.frame_rate,
            limit: options.max_bitrate,
            matrix: options.color_matrix,
            range: options.color_range,
            preset: options.encoding_preset,
            preview,
        }
    }
}

/// Round down, so a shared stream never exceeds any member's allocated bitrate.
/// Nearby connections reuse an encoder instead of reconfiguring on every BWE sample.
pub(crate) fn bitrate_bucket(target: u64, limit: u64) -> u32 {
    let target = target.min(limit).min(u32::MAX as u64);
    if target < 150_000 {
        return target as u32;
    }
    let mut bucket = 150_000u64;
    while bucket.saturating_mul(3) / 2 <= target {
        bucket = bucket * 3 / 2;
    }
    bucket as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn groups_nearby_allocations_without_exceeding_either_budget() {
        assert_eq!(
            bitrate_bucket(510_000, 2_000_000),
            bitrate_bucket(650_000, 2_000_000)
        );
        assert_ne!(
            bitrate_bucket(200_000, 2_000_000),
            bitrate_bucket(650_000, 2_000_000)
        );
        for target in (0..3_000_000).step_by(7919) {
            assert!(u64::from(bitrate_bucket(target, 2_000_000)) <= target.min(2_000_000));
        }
        assert_eq!(bitrate_bucket(0, 2_000_000), 0);
        assert_eq!(
            bitrate_bucket(3_000_000, 2_000_000),
            bitrate_bucket(1_999_999, 2_000_000)
        );
        assert_eq!(
            bitrate_bucket(300_000, 300_000),
            bitrate_bucket(288_000, 300_000)
        );
    }
    #[test]
    fn profiles_separate_formats_pixels_backends_and_preview_but_not_audio() {
        let options = MediaOptions::default();
        let profile = EncodingProfile::new("mf:a", &options, false);
        assert_ne!(profile, EncodingProfile::new("mf:b", &options, false));
        assert_ne!(profile, EncodingProfile::new("mf:a", &options, true));
        for changed in [
            MediaOptions {
                encoding_preset: super::super::preset::EncodingPreset::Quality,
                ..options.clone()
            },
            MediaOptions {
                codec: Some("video/h265".into()),
                ..options.clone()
            },
            MediaOptions {
                max_width: 1280,
                ..options.clone()
            },
            MediaOptions {
                frame_rate: 60,
                ..options.clone()
            },
            MediaOptions {
                color_range: super::super::color::ColorRange::Full,
                ..options.clone()
            },
        ] {
            assert_ne!(profile, EncodingProfile::new("mf:a", &changed, false));
        }
        assert_eq!(
            profile,
            EncodingProfile::new(
                "mf:a",
                &MediaOptions {
                    audio: true,
                    audio_codec: Some("audio/pcma".into()),
                    ..options
                },
                false
            )
        );
    }
}
