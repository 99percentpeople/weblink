//! Media Foundation's optional screen-content hint, shared by AVC and HEVC.
use crate::{
    damage::{Damage, DirtyRect},
    media::latency::CodecControl,
};
use windows::Win32::{Media::MediaFoundation::*, System::Variant::VARIANT};

pub(super) fn configure(api: &ICodecAPI) -> CodecControl {
    let result = unsafe {
        api.IsSupported(&CODECAPI_AVEncVideoDirtyRectEnabled)
            .and_then(|_| api.SetValue(&CODECAPI_AVEncVideoDirtyRectEnabled, &VARIANT::from(1_u32)))
    };
    CodecControl {
        name: "dirtyRegions".into(),
        requested: 1,
        accepted: result.is_ok(),
        actual: unsafe { api.GetValue(&CODECAPI_AVEncVideoDirtyRectEnabled) }
            .ok()
            .and_then(|v| u32::try_from(&v).ok()),
        error: result.err().map(|e| e.to_string()),
    }
}

/// DIRTYRECT_INFO is two UINTs followed by NumDirtyRects RECTs. Write the
/// variable-length blob explicitly; never expose Rust padding or a dangling slice.
pub(super) fn blob(frame_number: u32, size: (u32, u32), regions: Option<&[DirtyRect]>) -> Vec<u8> {
    let damage = Damage::from_rects(regions, size);
    let full = [DirtyRect {
        left: 0,
        top: 0,
        right: size.0 as i32,
        bottom: size.1 as i32,
    }];
    let regions = damage.rects().unwrap_or(&full);
    let mut bytes = Vec::with_capacity(8 + regions.len() * 16);
    bytes.extend_from_slice(&frame_number.to_le_bytes());
    bytes.extend_from_slice(&(regions.len() as u32).to_le_bytes());
    for rect in regions {
        for value in [rect.left, rect.top, rect.right, rect.bottom] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sample_blob_distinguishes_unknown_unchanged_and_partial_frames() {
        let words = |bytes: Vec<u8>| {
            bytes
                .chunks_exact(4)
                .map(|v| i32::from_le_bytes(v.try_into().unwrap()))
                .collect::<Vec<_>>()
        };
        assert_eq!(words(blob(7, (100, 80), None)), vec![7, 1, 0, 0, 100, 80]);
        assert_eq!(words(blob(8, (100, 80), Some(&[]))), vec![8, 0]);
        assert_eq!(
            words(blob(
                9,
                (100, 80),
                Some(&[DirtyRect {
                    left: 10,
                    top: 20,
                    right: 30,
                    bottom: 40
                }])
            )),
            vec![9, 1, 10, 20, 30, 40]
        );
    }
}
