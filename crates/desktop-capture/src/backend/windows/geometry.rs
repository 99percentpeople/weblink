//! EnumDisplaySettingsEx returns physical pixels regardless of DPI virtualization.
use crate::geometry::{DisplayGeometry, PixelRect};
use crate::Result;
use windows::core::HSTRING;
use windows::Win32::Graphics::Gdi::{
    EnumDisplaySettingsExW, DEVMODEW, DM_DISPLAYORIENTATION, DM_PELSHEIGHT, DM_PELSWIDTH,
    DM_POSITION, ENUM_CURRENT_SETTINGS, ENUM_DISPLAY_SETTINGS_FLAGS, HMONITOR,
};
use windows::Win32::UI::Shell::GetScaleFactorForMonitor;
use windows_capture::monitor::Monitor;

fn snapshot() -> Result<Vec<DisplayGeometry>> {
    let mut displays = Vec::new();
    for monitor in Monitor::enumerate().map_err(|e| e.to_string())? {
        let device = monitor.device_name().map_err(|e| e.to_string())?;
        let mut mode = DEVMODEW {
            dmSize: std::mem::size_of::<DEVMODEW>() as u16,
            ..Default::default()
        };
        let found = unsafe {
            EnumDisplaySettingsExW(
                &HSTRING::from(&device),
                ENUM_CURRENT_SETTINGS,
                &mut mode,
                ENUM_DISPLAY_SETTINGS_FLAGS(0),
            )
        };
        let required = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYORIENTATION;
        if !found.as_bool() || !mode.dmFields.contains(required) {
            return Err("Current physical display geometry is unavailable".into());
        }
        let display = unsafe { mode.Anonymous1.Anonymous2 };
        let rotation = match display.dmDisplayOrientation.0 {
            0 => 0,
            1 => 90,
            2 => 180,
            3 => 270,
            _ => return Err("Unsupported display orientation".into()),
        };
        let scale_percent =
            unsafe { GetScaleFactorForMonitor(HMONITOR(monitor.as_raw_hmonitor())) }
                .ok()
                .and_then(|scale| u32::try_from(scale.0).ok())
                .filter(|scale| (100..=500).contains(scale));
        displays.push(DisplayGeometry {
            source_id: super::screen::id(monitor),
            bounds: PixelRect {
                left: display.dmPosition.x,
                top: display.dmPosition.y,
                width: mode.dmPelsWidth,
                height: mode.dmPelsHeight,
            },
            rotation,
            scale_percent,
        });
    }
    displays.sort_by(|a, b| a.source_id.cmp(&b.source_id));
    Ok(displays)
}

pub(super) fn displays() -> Result<Vec<DisplayGeometry>> {
    let first = snapshot()?;
    let second = snapshot()?;
    if first != second {
        return Err("Display layout changed during enumeration; retry the query".into());
    }
    Ok(second)
}
