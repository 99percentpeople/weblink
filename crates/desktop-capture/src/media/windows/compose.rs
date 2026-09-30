//! Normalize rotated desktop textures and composite DXGI's separate pointer.
use crate::surface::{Cursor, CursorShape, Rotation};

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(super) fn compose(
    input: &[u8],
    stride: usize,
    width: u32,
    height: u32,
    rotation: Rotation,
    cursor: Option<&Cursor>,
    output: &mut Vec<u8>,
) {
    compose_with_cursor_scale(
        input,
        stride,
        width,
        height,
        rotation,
        cursor,
        (1.0, 1.0),
        output,
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn compose_with_cursor_scale(
    input: &[u8],
    stride: usize,
    width: u32,
    height: u32,
    rotation: Rotation,
    cursor: Option<&Cursor>,
    cursor_scale: (f64, f64),
    output: &mut Vec<u8>,
) {
    let (w, h) = match rotation {
        Rotation::Clockwise90 | Rotation::Clockwise270 => (height as usize, width as usize),
        _ => (width as usize, height as usize),
    };
    output.resize(w * h * 4, 0);
    if rotation == Rotation::Identity {
        for y in 0..h {
            output[y * w * 4..(y + 1) * w * 4]
                .copy_from_slice(&input[y * stride..y * stride + w * 4]);
        }
    } else {
        for y in 0..height as usize {
            for x in 0..width as usize {
                let (dx, dy) = match rotation {
                    Rotation::Clockwise90 => (height as usize - 1 - y, x),
                    Rotation::Clockwise180 => (width as usize - 1 - x, height as usize - 1 - y),
                    Rotation::Clockwise270 => (y, width as usize - 1 - x),
                    Rotation::Identity => (x, y),
                };
                let src = y * stride + x * 4;
                let dst = (dy * w + dx) * 4;
                output[dst..dst + 4].copy_from_slice(&input[src..src + 4]);
            }
        }
    }
    let Some(cursor) = cursor.filter(|c| c.visible) else {
        return;
    };
    let pitch = cursor.pitch as usize;
    let data = &cursor.bytes;
    let (sx, sy) = cursor_scale;
    for y in 0..(cursor.height as f64 * sy).ceil() as usize {
        for x in 0..(cursor.width as f64 * sx).ceil() as usize {
            let (dx, dy) = (
                (cursor.x as f64 * sx).floor() as i64 + x as i64,
                (cursor.y as f64 * sy).floor() as i64 + y as i64,
            );
            let x = ((x as f64 / sx) as usize).min(cursor.width.saturating_sub(1) as usize);
            let y = ((y as f64 / sy) as usize).min(cursor.height.saturating_sub(1) as usize);
            if dx < 0 || dy < 0 || dx >= w as i64 || dy >= h as i64 {
                continue;
            }
            let dst = (dy as usize * w + dx as usize) * 4;
            match cursor.shape {
                CursorShape::Monochrome => {
                    let and = y * pitch + x / 8;
                    let xor = and + cursor.height as usize * pitch;
                    if xor >= data.len() {
                        continue;
                    }
                    let mask = 0x80 >> (x % 8);
                    let and = if data[and] & mask != 0 { 255 } else { 0 };
                    let xor = if data[xor] & mask != 0 { 255 } else { 0 };
                    for c in 0..3 {
                        output[dst + c] = (output[dst + c] & and) ^ xor;
                    }
                }
                CursorShape::Color | CursorShape::MaskedColor => {
                    let src = y * pitch + x * 4;
                    if src + 4 > data.len() {
                        continue;
                    }
                    for c in 0..3 {
                        output[dst + c] = if cursor.shape == CursorShape::MaskedColor {
                            if data[src + 3] != 0 {
                                output[dst + c] ^ data[src + c]
                            } else {
                                data[src + c]
                            }
                        } else {
                            // Match DXGI's SRC_ALPHA / INV_SRC_ALPHA cursor blending.
                            let alpha = data[src + 3] as u32;
                            ((data[src + c] as u32 * alpha
                                + output[dst + c] as u32 * (255 - alpha)
                                + 127)
                                / 255) as u8
                        };
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gpu_scaled_cursor_uses_scaled_position_and_samples_source_pixels() {
        let mut output = vec![];
        let cursor = Cursor {
            visible: true,
            x: 2,
            y: 2,
            width: 2,
            height: 2,
            pitch: 8,
            shape: CursorShape::Color,
            bytes: std::sync::Arc::new(vec![
                200, 100, 50, 255, 1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255,
            ]),
        };
        compose_with_cursor_scale(
            &[0; 4 * 4 * 4],
            16,
            4,
            4,
            Rotation::Identity,
            Some(&cursor),
            (0.5, 0.5),
            &mut output,
        );
        assert_eq!(&output[20..23], &[200, 100, 50]);
        assert_eq!(&output[24..27], &[0, 0, 0]);
    }
    #[test]
    fn color_cursor_blends_alpha_and_masked_cursor_xors() {
        let input = vec![40; 8];
        let mut output = Vec::new();
        let mut cursor = Cursor {
            visible: true,
            width: 2,
            height: 1,
            pitch: 8,
            bytes: std::sync::Arc::new(vec![200, 200, 200, 128, 100, 100, 100, 0]),
            ..Default::default()
        };
        compose(
            &input,
            8,
            2,
            1,
            Rotation::Identity,
            Some(&cursor),
            &mut output,
        );
        assert_eq!((output[0], output[4]), (120, 40));
        cursor.shape = CursorShape::MaskedColor;
        compose(
            &input,
            8,
            2,
            1,
            Rotation::Identity,
            Some(&cursor),
            &mut output,
        );
        assert_eq!((output[0], output[4]), (40 ^ 200, 100));
    }
    #[test]
    fn rotates_pixels_and_clips_pointer_in_display_coordinates() {
        let input: Vec<_> = [1, 2, 3, 4, 5, 6]
            .into_iter()
            .flat_map(|v| [v, v, v, 255])
            .collect();
        let mut output = Vec::new();
        compose(&input, 12, 3, 2, Rotation::Clockwise90, None, &mut output);
        assert_eq!(
            output.chunks(4).map(|p| p[0]).collect::<Vec<_>>(),
            [4, 1, 5, 2, 6, 3]
        );
        let cursor = Cursor {
            visible: true,
            x: -1,
            y: 0,
            width: 2,
            height: 1,
            pitch: 8,
            bytes: std::sync::Arc::new(vec![9, 9, 9, 255, 8, 8, 8, 255]),
            ..Default::default()
        };
        compose(
            &input,
            12,
            3,
            2,
            Rotation::Clockwise90,
            Some(&cursor),
            &mut output,
        );
        assert_eq!(
            output.chunks(4).map(|p| p[0]).collect::<Vec<_>>(),
            [8, 1, 5, 2, 6, 3]
        );
    }
    #[test]
    fn monochrome_pointer_applies_and_then_xor_masks() {
        let input = vec![40; 16];
        let mut output = Vec::new();
        let cursor = Cursor {
            visible: true,
            width: 4,
            height: 1,
            pitch: 1,
            shape: CursorShape::Monochrome,
            bytes: std::sync::Arc::new(vec![0b11000000, 0b10100000]),
            ..Default::default()
        };
        compose(
            &input,
            16,
            4,
            1,
            Rotation::Identity,
            Some(&cursor),
            &mut output,
        );
        assert_eq!(
            output.chunks(4).map(|p| p[0]).collect::<Vec<_>>(),
            [215, 40, 255, 0]
        );
    }
}
