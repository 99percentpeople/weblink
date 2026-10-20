//! A private property distinguishes the selected window from a recycled HWND.
use crate::{
    input::Error,
    window::{BoundWindow, WindowGuard},
};
use std::sync::Arc;
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{HANDLE, HWND, POINT, RECT},
        UI::WindowsAndMessaging::*,
    },
};

struct Guard {
    hwnd: isize,
    process: u32,
    property: Vec<u16>,
}
impl Guard {
    fn hwnd(&self) -> HWND {
        HWND(self.hwnd as *mut _)
    }
    fn identity(&self) -> Result<(), Error> {
        unsafe {
            let h = self.hwnd();
            let mut process = 0;
            GetWindowThreadProcessId(h, Some(&mut process));
            if !IsWindow(Some(h)).as_bool()
                || process != self.process
                || GetAncestor(h, GA_ROOT) != h
                || GetPropW(h, PCWSTR(self.property.as_ptr())).0 as usize != 1
            {
                return Err(Error::WindowUnavailable);
            }
            Ok(())
        }
    }
}
impl WindowGuard for Guard {
    fn activate(&self) -> Result<(), Error> {
        self.identity()?;
        unsafe {
            let _ = SetForegroundWindow(self.hwnd());
        }
        self.check(None)
    }
    fn check(&self, point: Option<(i32, i32)>) -> Result<(), Error> {
        self.identity()?;
        unsafe {
            let h = self.hwnd();
            if !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() {
                return Err(Error::WindowUnavailable);
            }
            if GetForegroundWindow() != h {
                return Err(Error::WindowFocusLost);
            }
            let mut gui = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            GetGUIThreadInfo(GetWindowThreadProcessId(h, None), &mut gui)
                .map_err(|_| Error::WindowFocusLost)?;
            if gui.hwndFocus.0.is_null() || GetAncestor(gui.hwndFocus, GA_ROOT) != h {
                return Err(Error::WindowFocusLost);
            }
            if let Some((x, y)) = point {
                let _dpi = super::environment::InputDpi::new()?;
                if !gui.hwndCapture.0.is_null() && GetAncestor(gui.hwndCapture, GA_ROOT) != h {
                    return Err(Error::WindowPointOutside);
                }
                let mut rect = RECT::default();
                GetWindowRect(h, &mut rect).map_err(|_| Error::WindowUnavailable)?;
                if x < rect.left
                    || x >= rect.right
                    || y < rect.top
                    || y >= rect.bottom
                    || GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT) != h
                {
                    return Err(Error::WindowPointOutside);
                }
            }
        }
        Ok(())
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        // Never remove another window's/property owner's marker after destruction/reuse.
        if self.identity().is_ok() {
            unsafe {
                let _ = RemovePropW(self.hwnd(), PCWSTR(self.property.as_ptr()));
            }
        }
    }
}
/// Only call with an HWND resolved by a trusted local window provider.
pub fn bind(hwnd: isize, expected_process: u32) -> Result<BoundWindow, Error> {
    let property: Vec<u16> = format!("Weblink.Input.{}\0", uuid::Uuid::new_v4())
        .encode_utf16()
        .collect();
    let guard = Guard {
        hwnd,
        process: expected_process,
        property,
    };
    unsafe {
        let h = guard.hwnd();
        let mut process = 0;
        GetWindowThreadProcessId(h, Some(&mut process));
        if !IsWindow(Some(h)).as_bool()
            || GetAncestor(h, GA_ROOT) != h
            || process != expected_process
            || process == std::process::id()
        {
            return Err(Error::WindowUnavailable);
        }
        SetPropW(
            h,
            PCWSTR(guard.property.as_ptr()),
            Some(HANDLE(1usize as *mut _)),
        )
        .map_err(|_| Error::WindowUnavailable)?;
    }
    guard.identity()?;
    Ok(Arc::new(guard))
}
