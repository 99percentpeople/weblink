//! Raw local presentation, independent of RTP and encoder feedback.
use serde::Serialize;

pub const BUFFER_SIZE: usize = 3840 * 2160 * 4;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFrame {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub timestamp: f64,
    pub color_space: super::color::ColorDescription,
    pub format: &'static str,
}

#[cfg(test)]
pub(crate) fn pack_i420(
    target: &mut [u8],
    width: usize,
    height: usize,
    planes: [(&[u8], usize); 3],
) -> crate::Result<()> {
    pack_planar(target, width, height, planes, false)
}

#[cfg(any(windows, test))]
pub(crate) fn pack_planar(
    target: &mut [u8],
    width: usize,
    height: usize,
    planes: [(&[u8], usize); 3],
    full_chroma: bool,
) -> crate::Result<()> {
    if width == 0 || height == 0 || !width.is_multiple_of(2) || !height.is_multiple_of(2) {
        return Err("Invalid preview dimensions".into());
    }
    let required = width
        .checked_mul(height)
        .and_then(|n| n.checked_mul(3))
        .map(|n| if full_chroma { n } else { n / 2 });
    if required.is_none_or(|n| n > target.len() || n > BUFFER_SIZE) {
        return Err("Preview exceeds shared buffer".into());
    }
    // Validate all planes before writing anything, including padded source strides.
    for (index, (source, stride)) in planes.iter().enumerate() {
        let (w, h) = if index == 0 || full_chroma {
            (width, height)
        } else {
            (width / 2, height / 2)
        };
        if *stride < w
            || stride
                .checked_mul(h - 1)
                .and_then(|n| n.checked_add(w))
                .is_none_or(|n| n > source.len())
        {
            return Err("Invalid preview plane".into());
        }
    }
    let mut offset = 0;
    for (index, (source, stride)) in planes.iter().enumerate() {
        let (w, h) = if index == 0 || full_chroma {
            (width, height)
        } else {
            (width / 2, height / 2)
        };
        for row in 0..h {
            target[offset..offset + w].copy_from_slice(&source[row * stride..row * stride + w]);
            offset += w;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_chroma_packs_every_pixel_and_checks_the_full_plane_bounds() {
        let mut output = [99; 12];
        pack_planar(
            &mut output,
            2,
            2,
            [
                (&[1, 2, 99, 3, 4], 3),
                (&[5, 6, 7, 8], 2),
                (&[9, 10, 11, 12], 2),
            ],
            true,
        )
        .unwrap();
        assert_eq!(output, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        assert!(pack_planar(
            &mut output,
            2,
            2,
            [(&[0; 4], 2), (&[0; 4], 2), (&[0; 3], 2)],
            true
        )
        .is_err());
        assert_eq!(output[0], 1);
        assert!(pack_planar(&mut output[..6], 2, 2, [(&[0; 4], 2); 3], true).is_err());
    }
    #[test]
    fn packs_padded_planes_and_rejects_invalid_frames_without_partial_writes() {
        let mut output = [0; 12];
        pack_i420(
            &mut output,
            4,
            2,
            [
                (&[1, 2, 3, 4, 99, 5, 6, 7, 8], 5),
                (&[9, 10, 99], 3),
                (&[11, 12, 99], 3),
            ],
        )
        .unwrap();
        assert_eq!(output, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        assert!(pack_i420(
            &mut output,
            4,
            2,
            [(&[0; 8], 4), (&[0; 2], 2), (&[0; 1], 2)]
        )
        .is_err());
        assert_eq!(output[0], 1);
        assert!(pack_i420(
            &mut output[..8],
            4,
            2,
            [(&[0; 8], 4), (&[0; 2], 2), (&[0; 2], 2)]
        )
        .is_err());
        assert!(pack_i420(
            &mut output,
            3,
            2,
            [(&[0; 8], 4), (&[0; 2], 2), (&[0; 2], 2)]
        )
        .is_err());
    }
}
