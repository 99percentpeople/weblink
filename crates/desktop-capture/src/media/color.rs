//! SDR desktop pixels use sRGB primaries/transfer; YUV matrix and range are explicit.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorMatrix {
    #[default]
    Auto,
    Bt601,
    Bt709,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorRange {
    #[default]
    Limited,
    Full,
}

/// WebCodecs-compatible metadata describing the converted pixels.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorDescription {
    matrix: &'static str,
    primaries: &'static str,
    transfer: &'static str,
    full_range: bool,
}

impl super::MediaOptions {
    pub fn color_space(&self) -> ColorDescription {
        // Unrestricted software offers may negotiate VP8, which requires BT.601.
        let bt709 = match self.color_matrix {
            ColorMatrix::Auto => self.codec.as_deref().is_some_and(|c| c != "video/vp8"),
            ColorMatrix::Bt601 => false,
            ColorMatrix::Bt709 => true,
        };
        ColorDescription {
            matrix: if bt709 { "bt709" } else { "smpte170m" },
            primaries: "bt709",
            transfer: "iec61966-2-1",
            full_range: self.color_range == ColorRange::Full,
        }
    }

    pub(crate) fn vp8_color_compatible(&self) -> bool {
        self.color_matrix != ColorMatrix::Bt709 && self.color_range == ColorRange::Limited
    }
}

#[cfg(windows)]
impl ColorDescription {
    pub(crate) fn yuv_matrix(self) -> libwebrtc::native::yuv_helper::YuvMatrix {
        use libwebrtc::native::yuv_helper::YuvMatrix::*;
        match (self.matrix, self.full_range) {
            ("bt709", true) => Bt709Full,
            ("bt709", false) => Bt709Limited,
            (_, true) => Bt601Full,
            (_, false) => Bt601Limited,
        }
    }

    pub(crate) fn rtc(self) -> libwebrtc::video_source::VideoColorSpace {
        libwebrtc::video_source::VideoColorSpace {
            primaries: 1,
            transfer: 13,
            matrix: if self.matrix == "bt709" { 1 } else { 6 },
            full_range: self.full_range,
        }
    }

    pub(crate) fn apply_mf(
        self,
        media: &windows::Win32::Media::MediaFoundation::IMFMediaType,
    ) -> windows::core::Result<()> {
        use windows::Win32::Media::MediaFoundation::*;
        // SAFETY: IMFMediaType owns its attribute store; only documented enum values are written.
        unsafe {
            media.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
            media.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_sRGB.0 as u32)?;
            media.SetUINT32(
                &MF_MT_YUV_MATRIX,
                if self.matrix == "bt709" {
                    MFVideoTransferMatrix_BT709
                } else {
                    MFVideoTransferMatrix_BT601
                }
                .0 as u32,
            )?;
            media.SetUINT32(
                &MF_MT_VIDEO_NOMINAL_RANGE,
                if self.full_range {
                    MFNominalRange_0_255
                } else {
                    MFNominalRange_16_235
                }
                .0 as u32,
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn automatic_matrix_keeps_vp8_compatible_and_metadata_matches_conversion() {
        for (codec, matrix) in [
            (None, "smpte170m"),
            (Some("video/vp8"), "smpte170m"),
            (Some("video/h265"), "bt709"),
        ] {
            let options = super::super::MediaOptions {
                codec: codec.map(str::to_owned),
                ..Default::default()
            };
            let description = serde_json::to_value(options.color_space()).unwrap();
            assert_eq!(description["matrix"], matrix);
            assert_eq!(description["transfer"], "iec61966-2-1");
            assert_eq!(description["fullRange"], false);
        }
    }

    #[test]
    fn rejects_unknown_colour_values_and_incompatible_vp8_requests() {
        assert!(
            serde_json::from_str::<super::super::MediaOptions>(r#"{"colorMatrix":"bt2020"}"#)
                .is_err()
        );
        assert!(
            serde_json::from_str::<super::super::MediaOptions>(r#"{"colorRange":"hdr"}"#).is_err()
        );
        for (color_matrix, color_range) in [
            (ColorMatrix::Bt709, ColorRange::Limited),
            (ColorMatrix::Bt601, ColorRange::Full),
        ] {
            let options = super::super::MediaOptions {
                codec: Some("video/vp8".into()),
                color_matrix,
                color_range,
                ..Default::default()
            };
            assert!(options.validate().is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn colour_bars_and_gray_ramp_match_the_declared_matrix_and_range() {
        use libwebrtc::{native::yuv_helper::argb_to_i420_with_matrix, video_frame::I420Buffer};
        for color_matrix in [ColorMatrix::Bt601, ColorMatrix::Bt709] {
            for color_range in [ColorRange::Limited, ColorRange::Full] {
                let options = super::super::MediaOptions {
                    color_matrix,
                    color_range,
                    ..Default::default()
                };
                let description = options.color_space();
                let full = color_range == ColorRange::Full;
                let (kr, kb) = if color_matrix == ColorMatrix::Bt709 {
                    (0.2126, 0.0722)
                } else {
                    (0.299, 0.114)
                };
                let mut lumas = std::collections::BTreeSet::new();
                for [r, g, b] in [
                    [255, 0, 0],
                    [0, 255, 0],
                    [0, 0, 255],
                    [255, 255, 0],
                    [0, 255, 255],
                    [255, 0, 255],
                ]
                .into_iter()
                .chain((0..=255).map(|n| [n, n, n]))
                {
                    let pixels = [b, g, r, 255].repeat(4);
                    let mut output = I420Buffer::new(2, 2);
                    argb_to_i420_with_matrix(&pixels, 8, &mut output, description.yuv_matrix());
                    let (y, u, v) = output.data();
                    let luma =
                        (kr * f64::from(r) + (1.0 - kr - kb) * f64::from(g) + kb * f64::from(b))
                            / 255.0;
                    let chroma = if full { 255.0 } else { 224.0 };
                    let expected = [
                        if full {
                            255.0 * luma
                        } else {
                            16.0 + 219.0 * luma
                        },
                        128.0 + chroma * (f64::from(b) / 255.0 - luma) / (2.0 * (1.0 - kb)),
                        128.0 + chroma * (f64::from(r) / 255.0 - luma) / (2.0 * (1.0 - kr)),
                    ];
                    for (actual, reference) in [y[0], u[0], v[0]].into_iter().zip(expected) {
                        assert!((f64::from(actual) - reference.clamp(0.0, 255.0)).abs() <= 2.0, "{color_matrix:?} {color_range:?}: {:?}, actual={actual}, expected={reference}", [r, g, b]);
                    }
                    if r == g && g == b {
                        lumas.insert(y[0]);
                    }
                }
                assert_eq!(lumas.len(), if full { 256 } else { 220 });
            }
        }
    }
}
