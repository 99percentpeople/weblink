use std::{
    cell::RefCell,
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows::{
    core::{w, HSTRING},
    Win32::{
        Foundation::*,
        Graphics::Gdi::ClientToScreen,
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentProcessId},
        UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
};
type Events = Arc<Mutex<Vec<(u32, usize, isize)>>>;
thread_local! {static EVENTS:RefCell<Option<Events>>=const {RefCell::new(None)};}
unsafe extern "system" fn procedure(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if matches!(
        msg,
        WM_MOUSEMOVE
            | WM_LBUTTONDOWN
            | WM_LBUTTONUP
            | WM_MOUSEWHEEL
            | WM_MOUSEHWHEEL
            | WM_KEYDOWN
            | WM_KEYUP
            | WM_CHAR
    ) {
        EVENTS.with(|e| {
            if let Some(events) = e.borrow().as_ref() {
                let mut events = events.lock().unwrap();
                if events.len() < 4096 {
                    events.push((msg, wp.0, lp.0));
                }
            }
        });
    }
    // This receiver consumes wheel input; do not forward it to the desktop/parent chain.
    if matches!(msg, WM_MOUSEWHEEL | WM_MOUSEHWHEEL) {
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}
pub struct TestWindow {
    hwnd: usize,
    events: Events,
    stop: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
}
impl TestWindow {
    pub fn new() -> Result<Self, String> {
        Self::with_focus_timeout(Duration::from_secs(30))
    }
    pub fn with_focus_timeout(timeout: Duration) -> Result<Self, String> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let out = events.clone();
        let (ready, rx) = mpsc::channel();
        let (stop, stopped) = mpsc::channel();
        let thread = thread::spawn(move || unsafe {
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let previous = GetForegroundWindow();
            let mut cursor = POINT::default();
            let _ = GetCursorPos(&mut cursor);
            let module = GetModuleHandleW(None).unwrap();
            let class = HSTRING::from(format!("WeblinkInputTest-{}", uuid::Uuid::new_v4()));
            EVENTS.with(|e| *e.borrow_mut() = Some(out));
            let wc = WNDCLASSW {
                lpfnWndProc: Some(procedure),
                hInstance: module.into(),
                lpszClassName: windows::core::PCWSTR(class.as_ptr()),
                ..Default::default()
            };
            assert_ne!(RegisterClassW(&wc), 0);
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                &class,
                w!("Weblink input self-test - local click/key aborts control"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                120,
                120,
                720,
                440,
                None,
                None,
                Some(module.into()),
                None,
            )
            .unwrap();
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = SetForegroundWindow(hwnd);
            let _ = ready.send(hwnd.0 as usize);
            while stopped.try_recv() == Err(mpsc::TryRecvError::Empty)
                && IsWindow(Some(hwnd)).as_bool()
            {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                thread::sleep(Duration::from_millis(2));
            }
            if GetForegroundWindow() == hwnd {
                let _ = SetCursorPos(cursor.x, cursor.y);
                if IsWindow(Some(previous)).as_bool() {
                    let _ = SetForegroundWindow(previous);
                }
            }
            let _ = DestroyWindow(hwnd);
            let _ = UnregisterClassW(&class, Some(module.into()));
        });
        let hwnd = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let result = Self {
            hwnd,
            events,
            stop,
            thread: Some(thread),
        };
        // Windows may refuse programmatic foreground activation. Let the local user click
        // this owned window; do not bypass foreground restrictions or inject into another app.
        let deadline = Instant::now() + timeout;
        let mut idle = Instant::now();
        loop {
            if result.foreground().is_err()
                || unsafe { (1..255).any(|key| GetAsyncKeyState(key) < 0) }
            {
                idle = Instant::now();
            }
            if idle.elapsed() >= Duration::from_millis(200) {
                break;
            }
            if Instant::now() >= deadline {
                result.foreground()?;
                let buttons = unsafe { (1..=6).filter(|key| GetAsyncKeyState(*key) < 0).count() };
                let modifiers = unsafe {
                    [
                        0x10, 0x11, 0x12, 0x5b, 0x5c, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5,
                    ]
                    .into_iter()
                    .filter(|key| GetAsyncKeyState(*key) < 0)
                    .count()
                };
                let count = unsafe { (1..255).filter(|key| GetAsyncKeyState(*key) < 0).count() };
                return Err(format!("release local keys/buttons before testing: {buttons} button states, {modifiers} modifier states, {count} total states held"));
            }
            thread::sleep(Duration::from_millis(5));
        }
        result.events.lock().unwrap().clear();
        Ok(result)
    }
    pub fn handle(&self) -> usize {
        self.hwnd
    }
    fn foreground(&self) -> Result<(), String> {
        if unsafe { GetForegroundWindow().0 as usize } != self.hwnd {
            Err("test window lost foreground; no input will be injected".into())
        } else {
            Ok(())
        }
    }
    pub fn point(&self, x: i32, y: i32) -> Result<(i32, i32), String> {
        unsafe {
            let old = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let mut point = POINT { x, y };
            let ok = ClientToScreen(HWND(self.hwnd as *mut _), &mut point).as_bool();
            SetThreadDpiAwarenessContext(old);
            if ok {
                Ok((point.x, point.y))
            } else {
                Err("client position unavailable".into())
            }
        }
    }
    pub fn wait_for(&self, message: u32, count: usize) -> Result<(), String> {
        self.wait(
            |events| events.iter().filter(|e| e.0 == message).count() >= count,
            &format!("message {message:#x}, count {count}"),
        )
    }
    fn wait(
        &self,
        check: impl Fn(&[(u32, usize, isize)]) -> bool,
        what: &str,
    ) -> Result<(), String> {
        let start = Instant::now();
        loop {
            self.foreground()?;
            if check(&self.events.lock().unwrap()) {
                return Ok(());
            }
            if start.elapsed() > Duration::from_secs(2) {
                return Err(format!("did not receive {what}"));
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
    pub fn wait_drag(&self) -> Result<(), String> {
        self.wait(
            |events| events.iter().any(|e| e.0 == WM_MOUSEMOVE && e.1 & 1 != 0),
            "drag movement",
        )
    }
    pub fn wait_key_up(&self, count: usize) -> Result<(), String> {
        self.wait(
            |events| {
                events
                    .iter()
                    .filter(|e| e.0 == WM_KEYUP && e.1 == 0x41)
                    .count()
                    >= count
            },
            "owned scan-code key release",
        )
    }
    pub fn assert_text(&self) -> Result<(), String> {
        self.wait(
            |events| {
                let text: Vec<u16> = events
                    .iter()
                    .filter(|e| e.0 == WM_CHAR)
                    .map(|e| e.1 as u16)
                    .collect();
                text.ends_with(&"中😀".encode_utf16().collect::<Vec<_>>())
            },
            "committed Unicode text",
        )
    }
    pub fn assert_cursor(&self, x: i32, y: i32) -> Result<(), String> {
        unsafe {
            let old = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let mut p = POINT::default();
            let result = GetCursorPos(&mut p);
            SetThreadDpiAwarenessContext(old);
            result.map_err(|e| e.to_string())?;
            if (p.x - x).abs() > 2 || (p.y - y).abs() > 2 {
                return Err(format!("cursor mismatch {p:?}, expected {x},{y}"));
            }
            Ok(())
        }
    }
    pub fn assert_released(&self) -> Result<(), String> {
        let start = Instant::now();
        loop {
            if unsafe { GetAsyncKeyState(0x41) >= 0 && GetAsyncKeyState(VK_LBUTTON.0 as i32) >= 0 }
            {
                return Ok(());
            }
            if start.elapsed() > Duration::from_millis(200) {
                return Err("injected key/button still down".into());
            }
            thread::sleep(Duration::from_millis(2));
        }
    }
    pub fn external_click(&self) -> Result<(), String> {
        self.foreground()?;
        unsafe {
            let pair = [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP].map(|flags| INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dwFlags: flags,
                        dwExtraInfo: 0x1234,
                        ..Default::default()
                    },
                },
            });
            if SendInput(&pair, std::mem::size_of::<INPUT>() as i32) != 2 {
                return Err("external takeover probe failed".into());
            }
            Ok(())
        }
    }
    pub fn check_hotkey(&self, available: bool) -> Result<(), String> {
        unsafe {
            let registered = RegisterHotKey(
                None,
                0x574d,
                MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT,
                VK_F10.0 as u32,
            )
            .is_ok();
            if registered {
                let _ = UnregisterHotKey(None, 0x574d);
            }
            if registered == available {
                Ok(())
            } else {
                Err("emergency hotkey ownership mismatch".into())
            }
        }
    }
    pub fn with_reserved_hotkey(&self, probe: impl FnOnce() -> bool) -> Result<(), String> {
        unsafe {
            RegisterHotKey(
                None,
                0x574d,
                MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT,
                VK_F10.0 as u32,
            )
            .map_err(|e| e.to_string())?;
            let rejected = probe();
            let _ = UnregisterHotKey(None, 0x574d);
            if rejected {
                Ok(())
            } else {
                Err("input worker started without an available emergency hotkey".into())
            }
        }
    }
    pub fn notify_lifecycle(&self, message: u32) -> Result<(), String> {
        self.foreground()?;
        unsafe {
            unsafe extern "system" fn visit(hwnd: HWND, lp: LPARAM) -> windows::core::BOOL {
                let mut pid = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if pid == GetCurrentProcessId() {
                    let mut title = [0u16; 64];
                    let n = GetWindowTextW(hwnd, &mut title);
                    if String::from_utf16_lossy(&title[..n as usize]) == "Weblink input lifecycle" {
                        let _ = PostMessageW(
                            Some(hwnd),
                            lp.0 as u32,
                            WPARAM(if lp.0 as u32 == WM_HOTKEY { 0x574c } else { 0 }),
                            LPARAM(0),
                        );
                    }
                }
                true.into()
            }
            EnumWindows(Some(visit), LPARAM(message as isize)).map_err(|e| e.to_string())
        }
    }
}
impl Drop for TestWindow {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
