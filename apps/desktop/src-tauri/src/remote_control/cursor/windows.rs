use super::Shape;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    mem::size_of,
    time::{Duration, Instant},
};
use weblink_desktop_input::input::Rect;
use windows::Win32::{Graphics::Gdi::*, UI::WindowsAndMessaging::*};

const MAX_SIZE: i32 = 128;
const MAX_PNG: usize = 16 * 1024;

#[derive(Default)]
pub(super) struct Detector {
    // Only an identity, never dereferenced; Windows owns the original cursor.
    cached: Option<(usize, Instant, Shape)>,
}
impl Detector {
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
        if let Some((old, at, shape)) = &self.cached {
            // Refresh even the same handle: applications can reuse handles/change images.
            if *old == handle && at.elapsed() < Duration::from_millis(250) {
                return shape.clone();
            }
        }
        let shape = system_shape(info.hCursor)
            .or_else(|| bitmap_shape(info.hCursor))
            .unwrap_or(Shape::Unknown);
        self.cached = Some((handle, Instant::now(), shape.clone()));
        shape
    }
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
fn bitmap_shape(cursor: HCURSOR) -> Option<Shape> {
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
        if !(1..=MAX_SIZE).contains(&width)
            || !(1..=MAX_SIZE).contains(&height)
            || info.xHotspot >= width as u32
            || info.yHotspot >= height as u32
        {
            return None;
        }
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
            // XOR/inverting pixels cannot be represented by CSS PNGs: keep the video cursor.
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
            rgba(&black, pixels)
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
fn rgba(black: &[u8], white: &[u8]) -> Option<Vec<u8>> {
    let mut result = Vec::with_capacity(black.len());
    for (b, w) in black.chunks_exact(4).zip(white.chunks_exact(4)) {
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
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_pixels_preserve_color_alpha_and_reject_inversion() {
        assert_eq!(
            rgba(&[0, 0, 128, 0], &[127, 127, 255, 0]),
            Some(vec![255, 0, 0, 128])
        );
        assert_eq!(
            rgba(&[0, 0, 0, 0], &[255, 255, 255, 0]),
            Some(vec![0, 0, 0, 0])
        );
        assert_eq!(rgba(&[255, 255, 255, 0], &[0, 0, 0, 0]), None);
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
        } = bitmap_shape(arrow).unwrap()
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
}
