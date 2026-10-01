use super::{apply_outer, interpolate, Bounds};
use windows::{
    core::w,
    Win32::{
        Foundation::{HWND, RECT},
        UI::WindowsAndMessaging::*,
    },
};

struct HiddenWindow(HWND);
impl Drop for HiddenWindow {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.0) };
    }
}

fn outer(hwnd: HWND) -> Bounds {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.unwrap();
    Bounds {
        position: (rect.left, rect.top).into(),
        size: (
            (rect.right - rect.left) as u32,
            (rect.bottom - rect.top) as u32,
        )
            .into(),
    }
}

fn client_size(hwnd: HWND) -> (i32, i32) {
    let mut rect = RECT::default();
    unsafe { GetClientRect(hwnd, &mut rect) }.unwrap();
    (rect.right - rect.left, rect.bottom - rect.top)
}

fn decorate(hwnd: HWND, style: WINDOW_STYLE) {
    unsafe {
        SetWindowLongPtrW(hwnd, GWL_STYLE, style.0 as isize);
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED,
        )
        .unwrap();
    }
}

#[test]
fn repeated_native_caption_round_trips_do_not_accumulate_size() {
    // Exercise Win32 sizing without opening a visible window or touching focus.
    let window = HiddenWindow(unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("STATIC"),
            w!("Weblink bounds test"),
            WS_OVERLAPPEDWINDOW,
            100,
            100,
            900,
            640,
            None,
            None,
            None,
            None,
        )
        .unwrap()
    });
    let hwnd = window.0;
    let original = outer(hwnd);
    let original_client = client_size(hwnd);
    let compact = Bounds {
        position: (200, 200).into(),
        size: (480, 386).into(),
    };
    for cycle in 0..24 {
        // Like entering PiP, each cycle saves the OS-reported current rectangle.
        let saved = outer(hwnd);
        decorate(hwnd, WS_POPUP | WS_THICKFRAME);
        apply_outer(hwnd, saved).unwrap();
        apply_outer(hwnd, interpolate(saved, compact, 0.4)).unwrap();
        if cycle % 2 == 0 {
            apply_outer(hwnd, compact).unwrap();
        }
        // Include restoration before entry completes as well as full round trips.
        decorate(hwnd, WS_OVERLAPPEDWINDOW);
        apply_outer(hwnd, saved).unwrap();
        assert_eq!(
            outer(hwnd),
            original,
            "outer bounds drifted on cycle {cycle}"
        );
        assert_eq!(
            client_size(hwnd),
            original_client,
            "client size drifted on cycle {cycle}"
        );
    }
}
