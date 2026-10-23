//! One GDI crop/resize directly into a bounded bitmap. No capture session.
use crate::{
    surface::{snapshot, thumbnail, Rotation},
    Result,
};
use std::{mem::size_of, ptr, slice};
use windows::Win32::{
    Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, GetDC,
        GetMonitorInfoW, ReleaseDC, SelectObject, SetBrushOrgEx, SetStretchBltMode, StretchBlt,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HALFTONE, HBITMAP, HDC,
        HGDIOBJ, HMONITOR, MONITORINFO, SRCCOPY,
    },
    UI::HiDpi::{
        SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    },
};
use windows_capture::monitor::Monitor;

pub(super) fn monitor(monitor: Monitor) -> Result<Vec<u8>> {
    // Monitor coordinates and GDI source coordinates must both be physical pixels,
    // including mixed-DPI displays and monitors left/above the primary display.
    let _dpi = DpiContext(unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
    });
    if _dpi.0 .0.is_null() {
        return Err("Could not set snapshot DPI awareness".into());
    }
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        GetMonitorInfoW(HMONITOR(monitor.as_raw_hmonitor()), &mut info)
            .ok()
            .map_err(|e| e.to_string())?;
    }
    let rect = info.rcMonitor;
    let (width, height) = (rect.right - rect.left, rect.bottom - rect.top);
    if width <= 0 || height <= 0 {
        return Err("Display has no visible area".into());
    }
    let bounds = crate::geometry::PixelRect {
        left: rect.left,
        top: rect.top,
        width: width as u32,
        height: height as u32,
    };
    let area = crate::snapshot::SnapshotOptions {
        max_width: 640,
        max_height: 360,
        rect: None,
    }
    .region(&bounds)?;
    capture(&area, true)
}

pub(super) fn region(area: &crate::snapshot::Region) -> Result<Vec<u8>> {
    let _dpi = DpiContext(unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
    });
    if _dpi.0 .0.is_null() {
        return Err("Could not set snapshot DPI awareness".into());
    }
    capture(area, false)
}

fn capture(area: &crate::snapshot::Region, preview: bool) -> Result<Vec<u8>> {
    let rect = &area.bounds;
    let (width, height) = (rect.width as i32, rect.height as i32);
    let (w, h) = area.dimensions();
    let mut bitmap = Bitmap::default();
    unsafe {
        bitmap.screen = GetDC(None);
        if bitmap.screen.is_invalid() {
            return Err("Could not obtain the desktop device context".into());
        }
        bitmap.memory = CreateCompatibleDC(Some(bitmap.screen));
        if bitmap.memory.is_invalid() {
            return Err("Could not create the snapshot device context".into());
        }
        let header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32), // top-down BGRA, no post-capture flip
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = ptr::null_mut();
        bitmap.image = CreateDIBSection(
            Some(bitmap.screen),
            &header,
            DIB_RGB_COLORS,
            &mut pixels,
            None,
            0,
        )
        .map_err(|e| e.to_string())?;
        if pixels.is_null() {
            return Err("Snapshot bitmap has no pixel storage".into());
        }
        bitmap.previous = SelectObject(bitmap.memory, HGDIOBJ(bitmap.image.0));
        if bitmap.previous.is_invalid() {
            return Err("Could not select the snapshot bitmap".into());
        }
        if SetStretchBltMode(bitmap.memory, HALFTONE) == 0 {
            return Err("Could not enable thumbnail scaling".into());
        }
        SetBrushOrgEx(bitmap.memory, 0, 0, None)
            .ok()
            .map_err(|e| e.to_string())?;
        StretchBlt(
            bitmap.memory,
            0,
            0,
            w as i32,
            h as i32,
            Some(bitmap.screen),
            rect.left,
            rect.top,
            width,
            height,
            SRCCOPY | CAPTUREBLT,
        )
        .ok()
        .map_err(|e| e.to_string())?;
        // Complete GDI's batched writes before reading the DIB's memory directly.
        GdiFlush().ok().map_err(|e| e.to_string())?;
        let bytes = slice::from_raw_parts(pixels.cast(), (w * h * 4) as usize);
        if preview {
            thumbnail::encode(bytes, (w * 4) as usize, w, h, Rotation::Identity)
        } else {
            // GDI already cropped and resized. Encode this bitmap at exactly 1:1.
            let region = crate::snapshot::SnapshotOptions {
                max_width: w,
                max_height: h,
                rect: None,
            }
            .region(&crate::geometry::PixelRect {
                left: 0,
                top: 0,
                width: w,
                height: h,
            })?;
            snapshot::encode(bytes, (w * 4) as usize, w, h, Rotation::Identity, &region)
        }
    }
}

#[derive(Default)]
struct Bitmap {
    screen: HDC,
    memory: HDC,
    image: HBITMAP,
    previous: HGDIOBJ,
}
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.is_invalid() {
                SelectObject(self.memory, self.previous);
            }
            if !self.memory.is_invalid() {
                let _ = DeleteDC(self.memory);
            }
            if !self.image.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(self.image.0));
            }
            if !self.screen.is_invalid() {
                ReleaseDC(None, self.screen);
            }
        }
    }
}

struct DpiContext(DPI_AWARENESS_CONTEXT);
impl Drop for DpiContext {
    fn drop(&mut self) {
        if !self.0 .0.is_null() {
            unsafe {
                SetThreadDpiAwarenessContext(self.0);
            }
        }
    }
}
