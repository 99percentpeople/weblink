//! Physical display inventory and input-desktop availability, independent of injection.
use crate::input::{Error, Rect};
use std::mem::size_of;
use windows::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::{StationsAndDesktops::*, Threading::GetCurrentThreadId},
    UI::{HiDpi::*, WindowsAndMessaging::*},
};
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Layout {
    pub desktop: Rect,
    pub monitors: Vec<(isize, Rect, [u16; 32])>,
}
unsafe extern "system" fn monitor(
    handle: HMONITOR,
    _: HDC,
    _: *mut RECT,
    lp: LPARAM,
) -> windows::core::BOOL {
    let out = &mut *(lp.0 as *mut Option<Vec<(isize, Rect, [u16; 32])>>);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    if !GetMonitorInfoW(handle, &mut info.monitorInfo).as_bool() {
        *out = None;
        return false.into();
    }
    let r = info.monitorInfo.rcMonitor;
    let rect = Rect {
        left: r.left,
        top: r.top,
        width: (r.right - r.left) as u32,
        height: (r.bottom - r.top) as u32,
    };
    if !rect.valid() {
        *out = None;
        return false.into();
    }
    if let Some(out) = out {
        out.push((handle.0 as isize, rect, info.szDevice));
    }
    true.into()
}
pub(super) fn layout() -> Result<Layout, Error> {
    unsafe {
        let mut monitors: Option<Vec<(isize, Rect, [u16; 32])>> = Some(Vec::new());
        if !EnumDisplayMonitors(
            None,
            None,
            Some(monitor),
            LPARAM(&mut monitors as *mut _ as isize),
        )
        .as_bool()
        {
            return Err(Error::Unavailable);
        }
        let mut monitors = monitors.ok_or(Error::Unavailable)?;
        if monitors.is_empty() || monitors.len() > 64 {
            return Err(Error::Unavailable);
        }
        monitors.sort_by_key(|m| m.0);
        let desktop = Rect {
            left: GetSystemMetrics(SM_XVIRTUALSCREEN),
            top: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN) as u32,
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN) as u32,
        };
        if !desktop.valid() || monitors.iter().any(|m| !desktop.contains(m.1)) {
            return Err(Error::Unavailable);
        }
        Ok(Layout { desktop, monitors })
    }
}
fn desktop_name(handle: HDESK) -> Option<Vec<u16>> {
    let mut name = [0u16; 256];
    unsafe {
        GetUserObjectInformationW(
            HANDLE(handle.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            size_of_val(&name) as u32,
            None,
        )
        .ok()?;
    }
    Some(name.into_iter().take_while(|c| *c != 0).collect())
}
pub(super) fn desktop_available() -> bool {
    unsafe {
        let Ok(input) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return false;
        };
        let current = desktop_name(input);
        let _ = CloseDesktop(input);
        let thread = GetThreadDesktop(GetCurrentThreadId())
            .ok()
            .and_then(desktop_name);
        current.is_some()
            && current == thread
            && current.as_deref() == Some(&[68, 101, 102, 97, 117, 108, 116]) // Default
    }
}
pub(super) struct InputDpi(DPI_AWARENESS_CONTEXT);
impl InputDpi {
    pub(super) fn new() -> Result<Self, Error> {
        let old =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if old.0.is_null() {
            Err(Error::Unavailable)
        } else {
            Ok(Self(old))
        }
    }
}
impl Drop for InputDpi {
    fn drop(&mut self) {
        unsafe {
            SetThreadDpiAwarenessContext(self.0);
        }
    }
}
