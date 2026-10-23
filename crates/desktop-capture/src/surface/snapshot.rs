//! Encode a source crop before resizing, retaining native detail for small regions.
use super::Rotation;
use crate::{
    snapshot::{Region, MAX_PNG_BYTES},
    Result,
};

pub(crate) fn encode(
    input: &[u8],
    stride: usize,
    width: u32,
    height: u32,
    rotation: Rotation,
    region: &Region,
) -> Result<Vec<u8>> {
    let (dw, dh) = match rotation {
        Rotation::Clockwise90 | Rotation::Clockwise270 => (height, width),
        _ => (width, height),
    };
    if width == 0
        || height == 0
        || stride < width as usize * 4
        || input.len()
            < (height as usize - 1)
                .saturating_mul(stride)
                .saturating_add(width as usize * 4)
        || region
            .x
            .checked_add(region.bounds.width)
            .is_none_or(|r| r > dw)
        || region
            .y
            .checked_add(region.bounds.height)
            .is_none_or(|b| b > dh)
    {
        return Err("CAPTURE_BOUNDS_MISMATCH".into());
    }
    let (w, h) = region.dimensions();
    // Interpolate in oriented source coordinates. At 1:1 every source pixel is
    // preserved; shrinking uses pixel centers rather than dropping whole strokes.
    let pixel = |x: u32, y: u32| {
        let (dx, dy) = (region.x + x, region.y + y);
        let (sx, sy) = match rotation {
            Rotation::Identity => (dx, dy),
            Rotation::Clockwise90 => (dy, height - 1 - dx),
            Rotation::Clockwise180 => (width - 1 - dx, height - 1 - dy),
            Rotation::Clockwise270 => (width - 1 - dy, dx),
        };
        let offset = sy as usize * stride + sx as usize * 4;
        [input[offset + 2], input[offset + 1], input[offset]]
    };
    let axis = |p: u32, output: u32, source: u32| {
        let f = ((f64::from(p) + 0.5) * f64::from(source) / f64::from(output) - 0.5)
            .clamp(0., f64::from(source - 1));
        (f as u32, (f as u32 + 1).min(source - 1), f.fract())
    };
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        let (y0, y1, fy) = axis(y, h, region.bounds.height);
        for x in 0..w {
            if (w, h) == (region.bounds.width, region.bounds.height) {
                rgb.extend_from_slice(&pixel(x, y));
                continue;
            }
            let (x0, x1, fx) = axis(x, w, region.bounds.width);
            let (a, b, c, d) = (pixel(x0, y0), pixel(x1, y0), pixel(x0, y1), pixel(x1, y1));
            for channel in 0..3 {
                let top = f64::from(a[channel]) * (1. - fx) + f64::from(b[channel]) * fx;
                let bottom = f64::from(c[channel]) * (1. - fx) + f64::from(d[channel]) * fx;
                rgb.push((top * (1. - fy) + bottom * fy).round() as u8);
            }
        }
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, w, h);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&rgb).map_err(|e| e.to_string())?;
    }
    if bytes.len() > MAX_PNG_BYTES {
        return Err("RESULT_TOO_LARGE".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests;
