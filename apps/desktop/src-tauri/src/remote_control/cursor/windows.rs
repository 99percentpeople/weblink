use super::Shape;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    mem::size_of,
    time::{Duration, Instant},
};
use weblink_desktop_input::input::Rect;
use windows::Win32::{
    Foundation::POINT,
    Graphics::Gdi::*,
    UI::{Shell::GetScaleFactorForMonitor, WindowsAndMessaging::*},
};

const MAX_SIZE: i32 = 128;
const MAX_PNG: usize = 16 * 1024;
mod animation;
pub(super) mod events;

#[derive(Default)]
pub(super) struct Detector {
    // Only an identity, never dereferenced; Windows owns the original cursor.
    cached: Option<(usize, u32, Instant, Shape)>,
}
impl Detector {
    pub(super) fn invalidate(&mut self) {
        self.cached = None;
    }
    pub(super) fn read(&mut self, display: Rect) -> Shape {
        let mut info = CURSORINFO {
            cbSize: size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetCursorInfo(&mut info) }.is_err() {
            return Shape::Unknown;
        }
        let p = info.ptScreenPos;
        if i64::from(p.x) < i64::from(display.left)
            || i64::from(p.y) < i64::from(display.top)
            || i64::from(p.x) >= i64::from(display.left) + i64::from(display.width)
            || i64::from(p.y) >= i64::from(display.top) + i64::from(display.height)
        {
            return Shape::Unknown;
        }
        if info.flags != CURSOR_SHOWING {
            return Shape::System { name: "none" };
        }
        let handle = info.hCursor.0 as usize;
        let scale = monitor_scale(p);
        if let Some((old, old_scale, at, shape)) = &self.cached {
            // Refresh even the same handle: applications can reuse handles/change images.
            // A display/scale change must also invalidate an otherwise unchanged cursor.
            let lifetime = if matches!(shape, Shape::Animation { .. }) {
                2000
            } else {
                250
            };
            if *old == handle
                && *old_scale == scale
                && at.elapsed() < Duration::from_millis(lifetime)
            {
                return shape.clone();
            }
        }
        let shape = cursor_shape(info.hCursor, scale);
        self.cached = Some((handle, scale, Instant::now(), shape.clone()));
        shape
    }
}

fn cursor_shape(cursor: HCURSOR, scale: u32) -> Shape {
    // System roles use the viewer's native cursor (including wait/progress).
    // Only private application cursors need image resources or local frame playback.
    system_shape(cursor)
        .or_else(|| animation::read(cursor, scale))
        .or_else(|| bitmap_shape(cursor, scale))
        .unwrap_or(Shape::Unknown)
}

fn monitor_scale(position: POINT) -> u32 {
    let monitor = unsafe { MonitorFromPoint(position, MONITOR_DEFAULTTONEAREST) };
    unsafe { GetScaleFactorForMonitor(monitor) }
        .ok()
        .and_then(|scale| u32::try_from(scale.0).ok())
        .filter(|scale| (100..=500).contains(scale))
        .unwrap_or(100)
}

fn valid_geometry(width: i32, height: i32, hotspot_x: u32, hotspot_y: u32, scale: u32) -> bool {
    if !(100..=500).contains(&scale)
        || !(1..=MAX_SIZE * 5).contains(&width)
        || !(1..=MAX_SIZE * 5).contains(&height)
        || hotspot_x >= width as u32
        || hotspot_y >= height as u32
    {
        return false;
    }
    // Bound logical size without throwing away source pixels or rounding hotspots.
    width as u32 * 100 <= MAX_SIZE as u32 * scale && height as u32 * 100 <= MAX_SIZE as u32 * scale
}
fn system_shape(cursor: HCURSOR) -> Option<Shape> {
    for (id, name) in [
        (IDC_ARROW, "default"),
        (IDC_IBEAM, "text"),
        (IDC_HAND, "pointer"),
        (IDC_CROSS, "crosshair"),
        (IDC_WAIT, "wait"),
        (IDC_APPSTARTING, "progress"),
        (IDC_HELP, "help"),
        (IDC_NO, "not-allowed"),
        (IDC_SIZEALL, "move"),
        (IDC_SIZENS, "ns-resize"),
        (IDC_SIZEWE, "ew-resize"),
        (IDC_SIZENESW, "nesw-resize"),
        (IDC_SIZENWSE, "nwse-resize"),
    ] {
        if unsafe { LoadCursorW(None, id) }.is_ok_and(|value| value == cursor) {
            return Some(Shape::System { name });
        }
    }
    None
}
fn bitmap_shape(cursor: HCURSOR, scale: u32) -> Option<Shape> {
    // Snapshot the handle before reading its bitmaps, and free every GDI object on errors.
    let icon = unsafe { CopyIcon(HICON(cursor.0)) }.ok()?;
    let mut info = ICONINFO::default();
    let result = (|| {
        unsafe { GetIconInfo(icon, &mut info) }.ok()?;
        let mut bitmap = BITMAP::default();
        let color = !info.hbmColor.is_invalid();
        if unsafe {
            GetObjectW(
                HGDIOBJ(if color {
                    info.hbmColor.0
                } else {
                    info.hbmMask.0
                }),
                size_of::<BITMAP>() as i32,
                Some((&mut bitmap as *mut BITMAP).cast()),
            )
        } != size_of::<BITMAP>() as i32
        {
            return None;
        }
        let width = bitmap.bmWidth;
        let height = if color {
            bitmap.bmHeight
        } else {
            bitmap.bmHeight / 2
        };
        if !valid_geometry(width, height, info.xHotspot, info.yHotspot, scale) {
            return None;
        }
        // Keep the native pixels. Each viewer chooses its own raster density;
        // pre-shrinking here would irreversibly discard high-DPI detail.
        let pixels = render(icon, width, height)?;
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, width as u32, height as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().ok()?;
            writer.write_image_data(&pixels).ok()?;
            writer.finish().ok()?;
        }
        if png.len() > MAX_PNG {
            return None;
        }
        Some(Shape::Image {
            png: STANDARD.encode(png),
            width: width as u32,
            height: height as u32,
            hotspot_x: info.xHotspot,
            hotspot_y: info.yHotspot,
            source_scale: scale,
        })
    })();
    unsafe {
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
        }
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
        }
        let _ = DestroyIcon(icon);
    }
    result
}

fn render(icon: HICON, width: i32, height: i32) -> Option<Vec<u8>> {
    let dc = unsafe { CreateCompatibleDC(None) };
    if dc.is_invalid() {
        return None;
    }
    let mut bits = std::ptr::null_mut();
    let header = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let dib = unsafe { CreateDIBSection(Some(dc), &header, DIB_RGB_COLORS, &mut bits, None, 0) };
    let result = if let Ok(dib) = dib {
        let old = unsafe { SelectObject(dc, HGDIOBJ(dib.0)) };
        let result = (|| {
            if bits.is_null() || old.is_invalid() || old.0 as isize == -1 {
                return None;
            }
            // Rendering over black and white recovers alpha for both color and mask cursors.
            // Monochrome inversion is approximated by an outlined local cursor;
            // other background-dependent XOR colors still use the video cursor.
            let pixels = unsafe {
                std::slice::from_raw_parts_mut(bits.cast::<u8>(), (width * height * 4) as usize)
            };
            pixels.fill(0);
            unsafe { DrawIconEx(dc, 0, 0, icon, width, height, 0, None, DI_NORMAL) }.ok()?;
            unsafe { GdiFlush() }.ok().ok()?;
            let black = pixels.to_vec();
            pixels.fill(255);
            unsafe { DrawIconEx(dc, 0, 0, icon, width, height, 0, None, DI_NORMAL) }.ok()?;
            unsafe { GdiFlush() }.ok().ok()?;
            rgba(&black, pixels, width as usize)
        })();
        unsafe {
            let _ = SelectObject(dc, old);
            let _ = DeleteObject(HGDIOBJ(dib.0));
        }
        result
    } else {
        None
    };
    unsafe {
        let _ = DeleteDC(dc);
    }
    result
}
fn rgba(black: &[u8], white: &[u8], width: usize) -> Option<Vec<u8>> {
    if width == 0
        || black.is_empty()
        || black.len() != white.len()
        || black.len() % (width * 4) != 0
    {
        return None;
    }
    let mut result = Vec::with_capacity(black.len());
    let mut inverted = Vec::new();
    for (index, (b, w)) in black.chunks_exact(4).zip(white.chunks_exact(4)).enumerate() {
        // A mask cursor's AND=1/XOR=1 pixel inverts the desktop. PNG cannot
        // express that operation; preserve its shape with a black foreground.
        if b[..3] == [255, 255, 255] && w[..3] == [0, 0, 0] {
            inverted.push(index);
            result.extend_from_slice(&[0, 0, 0, 255]);
            continue;
        }
        let delta = i16::from(w[0]) - i16::from(b[0]);
        if delta < 0 || (1..3).any(|i| (i16::from(w[i]) - i16::from(b[i]) - delta).abs() > 1) {
            return None;
        }
        let alpha = 255 - delta as u32;
        for i in [2, 1, 0] {
            result.push(if alpha == 0 {
                0
            } else {
                (u32::from(b[i]) * 255 / alpha).min(255) as u8
            });
        }
        result.push(alpha as u8);
    }
    // A white edge keeps the replacement visible on dark backgrounds. Outline
    // only transparent neighbors so existing color/alpha pixels and hotspots stay intact.
    let height = result.len() / (width * 4);
    for index in inverted {
        let x = index % width;
        let y = index / width;
        for row in y.saturating_sub(1)..=(y + 1).min(height - 1) {
            for column in x.saturating_sub(1)..=(x + 1).min(width - 1) {
                let offset = (row * width + column) * 4;
                if result[offset + 3] == 0 {
                    result[offset..offset + 4].copy_from_slice(&[255, 255, 255, 255]);
                }
            }
        }
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_source_geometry_is_bounded_without_rounding_away_density() {
        for scale in [100, 125, 150, 175, 200, 300, 500] {
            let physical = (32 * scale / 100) as i32;
            let hotspot = 16 * scale / 100;
            assert!(valid_geometry(physical, physical, hotspot, hotspot, scale));
        }
        for valid in [
            (96, 64, 48, 32, 100),
            (192, 128, 96, 64, 200),
            (640, 640, 639, 639, 500),
            (1, 1, 0, 0, 500),
            (41, 26, 40, 25, 125),
        ] {
            assert!(valid_geometry(valid.0, valid.1, valid.2, valid.3, valid.4));
        }
        for invalid in [
            (129, 32, 0, 0, 100),
            (641, 32, 0, 0, 500),
            (32, 0, 0, 0, 100),
            (32, 32, 32, 0, 100),
            (32, 32, 0, 32, 100),
            (32, 32, 0, 0, 0),
            (32, 32, 0, 0, 501),
        ] {
            assert!(!valid_geometry(
                invalid.0, invalid.1, invalid.2, invalid.3, invalid.4
            ));
        }
    }

    #[test]
    fn high_dpi_custom_cursor_retains_source_pixels_and_separate_display_scale() {
        let and = [255u8; 64 * 8];
        let mut xor = [0u8; 64 * 8];
        for y in 16..48 {
            xor[y * 8 + 4] = 0x80;
        }
        let cursor = unsafe {
            CreateCursor(
                None,
                32,
                32,
                64,
                64,
                and.as_ptr().cast(),
                xor.as_ptr().cast(),
            )
        }
        .unwrap();
        let shapes = [bitmap_shape(cursor, 100), bitmap_shape(cursor, 200)];
        unsafe { DestroyCursor(cursor) }.unwrap();
        let mut pngs = Vec::new();
        for (shape, scale) in [(shapes[0].as_ref(), 100), (shapes[1].as_ref(), 200)] {
            let Some(Shape::Image {
                png,
                width,
                height,
                hotspot_x,
                hotspot_y,
                source_scale,
            }) = shape
            else {
                panic!("missing source cursor PNG");
            };
            assert_eq!((*width, *height, *hotspot_x, *hotspot_y), (64, 64, 32, 32));
            assert_eq!(*source_scale, scale);
            pngs.push(png);
            let mut reader = png::Decoder::new(std::io::Cursor::new(STANDARD.decode(png).unwrap()))
                .read_info()
                .unwrap();
            assert_eq!((reader.info().width, reader.info().height), (64, 64));
            let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
            reader.next_frame(&mut pixels).unwrap();
            assert!(pixels.chunks_exact(4).any(|pixel| pixel[3] != 0));
            assert_eq!(
                &pixels[(32 * 64 + 32) * 4..(32 * 64 + 33) * 4],
                &[0, 0, 0, 255]
            );
        }
        assert_eq!(pngs[0], pngs[1]);
    }

    #[test]
    fn cursor_pixels_preserve_color_alpha_and_support_monochrome_inversion() {
        assert_eq!(
            rgba(&[0, 0, 128, 0], &[127, 127, 255, 0], 1),
            Some(vec![255, 0, 0, 128])
        );
        assert_eq!(
            rgba(&[0, 0, 0, 0], &[255, 255, 255, 0], 1),
            Some(vec![0, 0, 0, 0])
        );
        assert_eq!(
            rgba(&[255, 255, 255, 0], &[0, 0, 0, 0], 1),
            Some(vec![0, 0, 0, 255])
        );
        assert_eq!(rgba(&[0, 255, 0, 0], &[255, 0, 255, 0], 1), None);
    }

    #[test]
    fn inversion_outline_preserves_adjacent_color_alpha_and_does_not_wrap_rows() {
        let mut black = vec![0; 3 * 3 * 4];
        let mut white = vec![255; 3 * 3 * 4];
        // Inversion at the left edge must not outline the previous row's right edge.
        black[12..16].copy_from_slice(&[255, 255, 255, 0]);
        white[12..16].copy_from_slice(&[0, 0, 0, 0]);
        black[16..20].copy_from_slice(&[0, 0, 128, 0]);
        white[16..20].copy_from_slice(&[127, 127, 255, 0]);
        let pixels = rgba(&black, &white, 3).unwrap();
        assert_eq!(&pixels[12..16], &[0, 0, 0, 255]);
        assert_eq!(&pixels[16..20], &[255, 0, 0, 128]);
        assert_eq!(&pixels[0..4], &[255, 255, 255, 255]);
        assert_eq!(&pixels[8..12], &[0, 0, 0, 0]);
    }
    #[test]
    fn system_cursors_stay_native_in_the_complete_detection_path() {
        for (id, name) in [
            (IDC_ARROW, "default"),
            (IDC_IBEAM, "text"),
            (IDC_HAND, "pointer"),
            (IDC_WAIT, "wait"),
            (IDC_APPSTARTING, "progress"),
            (IDC_SIZENS, "ns-resize"),
        ] {
            let cursor = unsafe { LoadCursorW(None, id) }.unwrap();
            for scale in [100, 200] {
                assert_eq!(cursor_shape(cursor, scale), Shape::System { name });
            }
        }
    }

    #[test]
    fn system_cursor_names_and_bitmap_encoding() {
        let arrow = unsafe { LoadCursorW(None, IDC_ARROW) }.unwrap();
        assert_eq!(system_shape(arrow), Some(Shape::System { name: "default" }));
        // Read a real shared icon without changing the desktop cursor.
        let Shape::Image {
            png,
            width,
            height,
            hotspot_x,
            hotspot_y,
            ..
        } = bitmap_shape(arrow, 100).unwrap()
        else {
            panic!("missing PNG")
        };
        let bytes = STANDARD.decode(png).unwrap();
        assert!(bytes.len() <= MAX_PNG);
        let reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        assert_eq!((reader.info().width, reader.info().height), (width, height));
        assert!(hotspot_x < width && hotspot_y < height);
    }

    #[test]
    fn custom_inverting_cursor_can_be_synced_without_showing_the_video_cursor() {
        // A real private cursor, like an application's I-beam/crosshair, rather
        // than a shared IDC handle. Do not install it on the interactive desktop.
        let and = [255u8; 32 * 4];
        let mut xor = [0u8; 32 * 4];
        for y in 8..24 {
            xor[y * 4 + 1] = 1;
        }
        let cursor = unsafe {
            CreateCursor(
                None,
                15,
                16,
                32,
                32,
                and.as_ptr().cast(),
                xor.as_ptr().cast(),
            )
        }
        .unwrap();
        assert_eq!(system_shape(cursor), None);
        let shape = cursor_shape(cursor, 100);
        unsafe { DestroyCursor(cursor) }.unwrap();
        let Shape::Image {
            png,
            width,
            height,
            hotspot_x,
            hotspot_y,
            ..
        } = shape
        else {
            panic!("custom inverting cursor fell back to the video cursor");
        };
        assert_eq!((width, height, hotspot_x, hotspot_y), (32, 32, 15, 16));
        let mut reader = png::Decoder::new(std::io::Cursor::new(STANDARD.decode(png).unwrap()))
            .read_info()
            .unwrap();
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut pixels).unwrap();
        let pixel = |x: usize, y: usize| &pixels[(y * 32 + x) * 4..(y * 32 + x + 1) * 4];
        assert_eq!(pixel(15, 16), &[0, 0, 0, 255]);
        assert_eq!(pixel(14, 16), &[255, 255, 255, 255]);
        assert_eq!(pixel(0, 0), &[0, 0, 0, 0]);
    }
}
