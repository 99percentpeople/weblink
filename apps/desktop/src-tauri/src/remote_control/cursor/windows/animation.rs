//! Optional Windows animation metadata. Missing/unsupported metadata never adds
//! a hard import dependency; unsupported animations keep the captured cursor.
use super::{bitmap_shape, Shape};
use crate::remote_control::cursor::{
    assets::{MAX_BYTES, MAX_FRAMES, MAX_PIXELS},
    Frame,
};
use std::{collections::HashMap, sync::OnceLock};
use windows::{
    core::{s, w},
    Win32::{
        System::LibraryLoader::{GetModuleHandleW, GetProcAddress},
        UI::WindowsAndMessaging::HCURSOR,
    },
};

// This user32 export is not in the public SDK. Its ABI and step/rate semantics
// are also exercised by Wine's user32 cursoricon tests. Returned frame handles
// are borrowed: bitmap_shape copies them, and we never destroy Windows' frames.
type FrameInfo = unsafe extern "system" fn(HCURSOR, usize, u32, *mut u32, *mut u32) -> HCURSOR;
fn api() -> Option<FrameInfo> {
    static API: OnceLock<Option<FrameInfo>> = OnceLock::new();
    *API.get_or_init(|| unsafe {
        let module = GetModuleHandleW(w!("user32.dll")).ok()?;
        let proc = GetProcAddress(module, s!("GetCursorFrameInfo"))?;
        Some(std::mem::transmute::<
            unsafe extern "system" fn() -> isize,
            FrameInfo,
        >(proc))
    })
}

pub(super) fn read(cursor: HCURSOR, scale: u32) -> Option<Shape> {
    let get_frame = api()?;
    let mut rate = 0;
    let mut steps = 0;
    let first = unsafe { get_frame(cursor, 0, 0, &mut rate, &mut steps) };
    if first.is_invalid() || steps <= 1 {
        return None;
    }
    // Some cursors expose sentinel counts instead of a usable sequence.
    if steps as usize > MAX_FRAMES {
        return Some(Shape::Unknown);
    }
    let animation = (|| {
        let mut frames = Vec::with_capacity(steps as usize);
        let mut bytes = 0;
        let mut pixels = 0;
        let mut images = HashMap::new();
        for index in 0..steps {
            let mut count = 0;
            let frame = unsafe { get_frame(cursor, 0, index, &mut rate, &mut count) };
            if frame.is_invalid() || count != steps || rate > 600 {
                return None;
            }
            let image = images.entry(frame.0 as usize);
            let image = match image {
                std::collections::hash_map::Entry::Occupied(image) => image.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let image = bitmap_shape(frame, scale)?;
                    let Shape::Image {
                        png, width, height, ..
                    } = &image
                    else {
                        return None;
                    };
                    bytes += png.len();
                    pixels += (*width as usize) * (*height as usize);
                    if bytes > MAX_BYTES.div_ceil(3) * 4 || pixels > MAX_PIXELS {
                        return None;
                    }
                    entry.insert(image)
                }
            };
            frames.push(Frame {
                image: image.clone(),
                duration_ms: if rate == 0 {
                    100
                } else {
                    (rate * 1000 + 30) / 60
                },
            });
        }
        Some(Shape::Animation { frames })
    })();
    // Never silently freeze an animation whose frames cannot all be represented.
    Some(animation.unwrap_or(Shape::Unknown))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::{
        core::PCWSTR,
        Win32::UI::WindowsAndMessaging::{DestroyCursor, LoadCursorFromFileW},
    };

    fn chunk(tag: &[u8; 4], data: Vec<u8>) -> Vec<u8> {
        let mut result = tag.to_vec();
        result.extend_from_slice(&(data.len() as u32).to_le_bytes());
        result.extend(data);
        if result.len() % 2 != 0 {
            result.push(0);
        }
        result
    }
    fn words(values: &[u32]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }
    fn frame(color: [u8; 4], hotspot: u16) -> Vec<u8> {
        // A self-contained 32x32 CUR file containing a BGRA DIB and its AND mask.
        let mut dib = words(&[40, 32, 64]);
        dib.extend_from_slice(&1u16.to_le_bytes());
        dib.extend_from_slice(&32u16.to_le_bytes());
        dib.extend(words(&[0, 0, 0, 0, 0, 0]));
        for _ in 0..32 * 32 {
            dib.extend_from_slice(&color);
        }
        dib.extend([0u8; 128]);
        let mut cur = vec![0, 0, 2, 0, 1, 0, 32, 32, 0, 0];
        cur.extend_from_slice(&hotspot.to_le_bytes());
        cur.extend_from_slice(&hotspot.to_le_bytes());
        cur.extend(words(&[dib.len() as u32, 22]));
        cur.extend(dib);
        chunk(b"icon", cur)
    }
    #[test]
    fn extracts_real_windows_animation_order_timing_hotspots_and_dpi_without_installing_it() {
        let file = tempfile::Builder::new()
            .suffix(".ani")
            .tempfile()
            .unwrap()
            .into_temp_path();
        let mut body = b"ACON".to_vec();
        body.extend(chunk(b"anih", words(&[36, 2, 3, 0, 0, 0, 0, 6, 3])));
        body.extend(chunk(b"rate", words(&[3, 6, 9])));
        body.extend(chunk(b"seq ", words(&[1, 0, 1])));
        let mut frames = b"fram".to_vec();
        frames.extend(frame([0, 0, 255, 255], 4));
        frames.extend(frame([255, 0, 0, 255], 8));
        body.extend(chunk(b"LIST", frames));
        std::fs::write(&file, chunk(b"RIFF", body)).unwrap();
        let path: Vec<u16> = file.to_str().unwrap().encode_utf16().chain([0]).collect();
        let cursor = unsafe { LoadCursorFromFileW(PCWSTR(path.as_ptr())) }.unwrap();
        let shape = super::super::cursor_shape(cursor, 200);
        unsafe { DestroyCursor(cursor) }.unwrap();
        let Shape::Animation { frames } = shape else {
            panic!("animation was not extracted: {shape:?}");
        };
        assert_eq!(
            frames.iter().map(|f| f.duration_ms).collect::<Vec<_>>(),
            [50, 100, 150]
        );
        assert_eq!(frames[0].image, frames[2].image);
        assert_ne!(frames[0].image, frames[1].image);
        for (frame, hotspot) in frames.iter().zip([8, 4, 8]) {
            let Shape::Image {
                width,
                height,
                hotspot_x,
                hotspot_y,
                source_scale,
                ..
            } = frame.image
            else {
                panic!("missing bitmap");
            };
            assert_eq!(
                (width, height, hotspot_x, hotspot_y),
                (32, 32, hotspot, hotspot)
            );
            assert_eq!(source_scale, 200);
        }
    }
}
