//! Optional driver quality/speed control. Never advertise an unverified setting.
use crate::media::{latency::CodecControl, preset::EncodingPreset};
use windows::Win32::{Media::MediaFoundation::*, System::Variant::VARIANT};

pub(super) fn quality_vs_speed(preset: EncodingPreset) -> u32 {
    match preset {
        EncodingPreset::Balanced => 33, // Retain the existing real-time default.
        EncodingPreset::Quality => 67,
        EncodingPreset::Latency => 0,
    }
}

pub(super) fn confirmed(control: &CodecControl) -> bool {
    control.accepted && control.actual == Some(control.requested)
}

pub(super) fn read(api: &ICodecAPI) -> Option<u32> {
    unsafe { api.GetValue(&CODECAPI_AVEncCommonQualityVsSpeed) }
        .ok()
        .and_then(|v| u32::try_from(&v).ok())
}

pub(super) fn apply(api: &ICodecAPI, preset: EncodingPreset) -> CodecControl {
    let requested = quality_vs_speed(preset);
    let result = unsafe {
        api.SetValue(
            &CODECAPI_AVEncCommonQualityVsSpeed,
            &VARIANT::from(requested),
        )
    };
    let actual = read(api);
    CodecControl {
        name: "qualityVsSpeed".into(),
        requested,
        actual,
        accepted: result.is_ok(),
        error: result.err().map(|e| e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn optional_controls_must_accept_and_read_back_the_requested_value() {
        let mut control = CodecControl {
            name: "qualityVsSpeed".into(),
            requested: 67,
            actual: Some(67),
            accepted: true,
            error: None,
        };
        assert!(confirmed(&control));
        for actual in [None, Some(33), Some(0)] {
            control.actual = actual;
            assert!(!confirmed(&control));
        }
        control.actual = Some(67);
        control.accepted = false;
        assert!(!confirmed(&control));
        assert_eq!(quality_vs_speed(EncodingPreset::Balanced), 33);
        assert!(quality_vs_speed(EncodingPreset::Latency) < 33);
        assert!(quality_vs_speed(EncodingPreset::Quality) > 33);
    }
}
