//! Native notification probe; moves within its fixture and restores the cursor.
use super::*;
use ::windows::{
    core::w,
    Win32::{
        Foundation::{HWND, POINT},
        UI::{HiDpi::*, WindowsAndMessaging::*},
    },
};
use std::thread;

#[test]
#[ignore = "Requires an unlocked Windows desktop; briefly moves the cursor inside a fixture and restores it"]
fn native_cursor_shape_changes_wake_a_quiet_monitor() {
    struct Window(HWND, DPI_AWARENESS_CONTEXT, POINT);
    impl Drop for Window {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyWindow(self.0);
                let _ = SetCursorPos(self.2.x, self.2.y);
                SetThreadDpiAwarenessContext(self.1);
            }
        }
    }
    // Keep all cursor mutation on this thread and restore the original handle
    // during unwinding as well. The listener itself runs on its own message loop.
    struct Restore(HCURSOR);
    impl Drop for Restore {
        fn drop(&mut self) {
            unsafe {
                SetCursor(Some(self.0));
            }
        }
    }
    let mut monitor = Monitor::default();
    monitor.set_waker(thread::current());
    let mut watch = watch();
    let mut info = CURSORINFO {
        cbSize: std::mem::size_of::<CURSORINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetCursorInfo(&mut info) }.unwrap();
    // SetCursor on a background console thread does not change the visible
    // desktop cursor. Give this thread a tiny non-activating window under it.
    let old_dpi =
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let window = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_NOACTIVATE,
            w!("BUTTON"),
            w!("Weblink cursor notification test"),
            WS_POPUP | WS_VISIBLE,
            info.ptScreenPos.x - 8,
            info.ptScreenPos.y - 8,
            16,
            16,
            None,
            None,
            None,
            None,
        )
    }
    .unwrap();
    let _window = Window(window, old_dpi, info.ptScreenPos);
    unsafe {
        // Enter this window's input queue, keeping movement within its bounds.
        SetCursorPos(info.ptScreenPos.x - 1, info.ptScreenPos.y).unwrap();
        let mut message = MSG::default();
        while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        assert_eq!(WindowFromPoint(info.ptScreenPos), window);
    }
    let _restore = Restore(info.hCursor);
    watch.display.left = info.ptScreenPos.x - 100;
    watch.display.top = info.ptScreenPos.y - 100;
    monitor.watch(watch, PointerActivity::default());
    let listener = monitor
        .listener
        .as_ref()
        .expect("Cursor listener unavailable");
    assert!(listener.alive());
    if let Some(update) = monitor.sample(Instant::now()) {
        println!("initial cursor: {:?}", update.shape);
    }
    for (name, expected) in [
        (IDC_HAND, "pointer"),
        (IDC_IBEAM, "text"),
        (IDC_ARROW, "default"),
    ] {
        let cursor = unsafe { LoadCursorW(None, name) }.unwrap();
        if cursor == info.hCursor {
            continue;
        }
        unsafe {
            SetCursor(Some(cursor));
            info.cbSize = std::mem::size_of::<CURSORINFO>() as u32;
            GetCursorInfo(&mut info).unwrap();
        }
        println!(
            "requested cursor={cursor:?}, actual={:?}, flags={:?}",
            info.hCursor, info.flags
        );
        assert_eq!(
            info.hCursor, cursor,
            "Fixture did not own the visible cursor"
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(update) = monitor.sample(Instant::now()) {
                println!("cursor notification: {:?}", update.shape);
                if update.shape == (Shape::System { name: expected }) {
                    break;
                }
            }
            assert!(
                Instant::now() < deadline,
                "Native cursor change was not delivered"
            );
            // A deadline bounds the test; steady cursor state has no sample timer.
            thread::park_timeout(
                monitor
                    .wait_duration(Instant::now())
                    .unwrap_or(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
    monitor.cancel();
    assert_eq!(monitor.wait_duration(Instant::now()), None);
}
