use super::environment::{desktop_available, layout, InputDpi, Layout};
use crate::input::{Button, Error, Geometry, Held};
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows::{
    core::{w, HSTRING},
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::{
            LibraryLoader::GetModuleHandleW, RemoteDesktop::*, Threading::GetCurrentProcessId,
        },
        UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
};

pub(super) const TAKEOVER: u8 = 1;
pub(super) const INVALIDATED: u8 = 2;
pub(super) const EMERGENCY: u8 = 4;
const HOTKEY: i32 = 0x574c;
struct Observation {
    marker: usize,
    keys: [bool; 512],
    buttons: [bool; 5],
    signal: u8,
}
impl Default for Observation {
    fn default() -> Self {
        Self {
            marker: 0,
            keys: [false; 512],
            buttons: [false; 5],
            signal: 0,
        }
    }
}
pub(super) struct Observations {
    state: Mutex<Observation>,
    closed: AtomicBool,
    owner: thread::Thread,
}
impl Observations {
    pub fn signals(&self) -> u8 {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut state.signal)
    }
    pub fn pending(&self) -> bool {
        self.closed.load(Ordering::Acquire)
            || self.state.lock().unwrap_or_else(|e| e.into_inner()).signal != 0
    }
    fn signal(&self, value: u8) {
        if value & INVALIDATED != 0 {
            self.closed.store(true, Ordering::Release);
        }
        self.state.lock().unwrap_or_else(|e| e.into_inner()).signal |= value;
        self.owner.unpark();
    }
    pub fn physical(&self, held: Held) -> bool {
        let o = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match held {
            Held::Key(key) => o.keys[key.code() as usize + if key.extended() { 256 } else { 0 }],
            Held::Button(button) => o.buttons[button_index(button)],
        }
    }
}
thread_local! { static OBSERVED: RefCell<Option<Arc<Observations>>> = const {RefCell::new(None)}; }
fn observe(f: impl FnOnce(&mut Observation)) {
    OBSERVED.with(|slot| {
        if let Some(shared) = slot.borrow().as_ref() {
            let wake = {
                let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                f(&mut state);
                state.signal != 0
            };
            if wake {
                shared.owner.unpark();
            }
        }
    });
}
pub(super) fn pump() {
    unsafe {
        let mut msg = MSG::default();
        for _ in 0..256 {
            if !PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                break;
            }
            if msg.message == WM_QUIT {
                signal(INVALIDATED);
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
fn signal(value: u8) {
    OBSERVED.with(|slot| {
        if let Some(shared) = slot.borrow().as_ref() {
            shared.signal(value);
        }
    });
}
fn button_index(button: Button) -> usize {
    match button {
        Button::Left => 0,
        Button::Right => 1,
        Button::Middle => 2,
        Button::Back => 3,
        Button::Forward => 4,
    }
}
impl Observation {
    fn keyboard(&mut self, event: &KBDLLHOOKSTRUCT) {
        let injected = event.flags.0 & LLKHF_INJECTED.0 != 0;
        if injected && event.dwExtraInfo == self.marker {
            return;
        }
        let down = event.flags.0 & LLKHF_UP.0 == 0;
        if !injected {
            let index = event.scanCode as usize
                + if event.flags.0 & LLKHF_EXTENDED.0 != 0 {
                    256
                } else {
                    0
                };
            if let Some(key) = self.keys.get_mut(index) {
                *key = down;
            }
        }
        if down {
            self.signal |= TAKEOVER;
        }
    }
    fn mouse(&mut self, event: &MSLLHOOKSTRUCT, message: u32) {
        let injected = event.flags & LLMHF_INJECTED != 0;
        if injected && event.dwExtraInfo == self.marker {
            return;
        }
        let transition = match message {
            WM_LBUTTONDOWN => Some((0, true)),
            WM_LBUTTONUP => Some((0, false)),
            WM_RBUTTONDOWN => Some((1, true)),
            WM_RBUTTONUP => Some((1, false)),
            WM_MBUTTONDOWN => Some((2, true)),
            WM_MBUTTONUP => Some((2, false)),
            WM_XBUTTONDOWN | WM_XBUTTONUP => Some((
                if event.mouseData >> 16 == 1 { 3 } else { 4 },
                message == WM_XBUTTONDOWN,
            )),
            _ => None,
        };
        if let Some((index, down)) = transition {
            // Other injected input revokes control, but cannot create/clear physical ownership.
            if !injected {
                self.buttons[index] = down;
            }
            if down {
                self.signal |= TAKEOVER;
            }
        }
    }
}
unsafe extern "system" fn keyboard(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        observe(|o| o.keyboard(&*(lp.0 as *const KBDLLHOOKSTRUCT)));
    }
    CallNextHookEx(None, code, wp, lp)
}
unsafe extern "system" fn mouse(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        observe(|o| o.mouse(&*(lp.0 as *const MSLLHOOKSTRUCT), wp.0 as u32));
    }
    CallNextHookEx(None, code, wp, lp)
}

unsafe extern "system" fn window(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_HOTKEY if wp.0 == HOTKEY as usize => signal(EMERGENCY),
        WM_DISPLAYCHANGE | WM_DPICHANGED | WM_SETTINGCHANGE | WM_WTSSESSION_CHANGE
        | WM_QUERYENDSESSION | WM_ENDSESSION => signal(INVALIDATED),
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}
struct Listener {
    hwnd: HWND,
    keyboard: Option<HHOOK>,
    mouse: Option<HHOOK>,
    hotkey: bool,
    session: bool,
    class: HSTRING,
    old_dpi: DPI_AWARENESS_CONTEXT,
    pub layout: Layout,
}
impl Listener {
    fn new(observations: Arc<Observations>) -> Result<Self, Error> {
        unsafe {
            let old_dpi = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            if old_dpi.0.is_null() {
                return Err(Error::Unavailable);
            }
            let init = (|| {
                if !desktop_available() {
                    return Err(Error::Unavailable);
                }
                let layout = layout()?;
                OBSERVED.with(|slot| *slot.borrow_mut() = Some(observations));
                let class = HSTRING::from(format!("WeblinkInput-{}", uuid::Uuid::new_v4()));
                let module = GetModuleHandleW(None).map_err(|_| Error::Unavailable)?;
                let wc = WNDCLASSW {
                    lpfnWndProc: Some(window),
                    hInstance: module.into(),
                    lpszClassName: windows::core::PCWSTR(class.as_ptr()),
                    ..Default::default()
                };
                if RegisterClassW(&wc) == 0 {
                    return Err(Error::Unavailable);
                }
                let hwnd = match CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    &class,
                    w!("Weblink input lifecycle"),
                    WS_OVERLAPPED,
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    Some(module.into()),
                    None,
                ) {
                    Ok(hwnd) => hwnd,
                    Err(_) => {
                        let _ = UnregisterClassW(&class, Some(module.into()));
                        return Err(Error::Unavailable);
                    }
                };
                let mut s = Self {
                    hwnd,
                    keyboard: None,
                    mouse: None,
                    hotkey: false,
                    session: false,
                    class,
                    old_dpi,
                    layout,
                };
                RegisterHotKey(
                    Some(hwnd),
                    HOTKEY,
                    MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT,
                    VK_F10.0 as u32,
                )
                .map_err(|_| Error::Unavailable)?;
                s.hotkey = true;
                WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)
                    .map_err(|_| Error::Unavailable)?;
                s.session = true;
                s.keyboard = Some(
                    SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), Some(module.into()), 0)
                        .map_err(|_| Error::Unavailable)?,
                );
                s.mouse = Some(
                    SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), Some(module.into()), 0)
                        .map_err(|_| Error::Unavailable)?,
                );
                Ok(s)
            })();
            if init.is_err() {
                SetThreadDpiAwarenessContext(old_dpi);
            }
            init
        }
    }
}
impl Drop for Listener {
    fn drop(&mut self) {
        unsafe {
            if let Some(h) = self.keyboard.take() {
                let _ = UnhookWindowsHookEx(h);
            }
            if let Some(h) = self.mouse.take() {
                let _ = UnhookWindowsHookEx(h);
            }
            if self.hotkey {
                let _ = UnregisterHotKey(Some(self.hwnd), HOTKEY);
            }
            if self.session {
                let _ = WTSUnRegisterSessionNotification(self.hwnd);
            }
            let _ = DestroyWindow(self.hwnd);
            let _ = UnregisterClassW(&self.class, GetModuleHandleW(None).ok().map(Into::into));
            SetThreadDpiAwarenessContext(self.old_dpi);
        }
    }
}

struct ObserverExit(Arc<Observations>);
impl Drop for ObserverExit {
    fn drop(&mut self) {
        self.0.signal(INVALIDATED);
    }
}

pub(super) struct Safety {
    pub observations: Arc<Observations>,
    stop: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
    _dpi: InputDpi,
    pub layout: Layout,
    pub marker: usize,
    guard: Option<usize>,
}
impl Safety {
    pub fn new(guard: Option<usize>) -> Result<Self, Error> {
        let dpi = InputDpi::new()?;
        // Mouse ExtraInfo can be truncated to 32 bits even for 64-bit SendInput.
        // This positive tag identifies our injections; it is not an authorization token.
        let marker = ((uuid::Uuid::new_v4().as_u128() as u32 & 0x7fff_ffff) | 1) as usize;
        let observations = Arc::new(Observations {
            state: Mutex::new(Observation {
                marker,
                ..Default::default()
            }),
            closed: AtomicBool::new(false),
            owner: thread::current(),
        });
        let stop = Arc::new(AtomicBool::new(false));
        let shared = observations.clone();
        let stopping = stop.clone();
        let (ready, initialized) = mpsc::sync_channel(1);
        let listener = thread::Builder::new()
            .name("weblink-input-events".into())
            .spawn(move || {
                let _exit = ObserverExit(shared.clone());
                let native = match Listener::new(shared.clone()) {
                    Ok(native) => native,
                    Err(e) => {
                        let _ = ready.send(Err(e));
                        return;
                    }
                };
                let _ = ready.send(Ok(native.layout.clone()));
                let mut poll = Instant::now();
                while !stopping.load(Ordering::Acquire) {
                    pump();
                    if poll.elapsed() >= Duration::from_millis(100) {
                        if !desktop_available() || layout().as_ref() != Ok(&native.layout) {
                            shared.signal(INVALIDATED);
                        }
                        poll = Instant::now();
                    }
                    // Wake on hook/window messages, not a polling sleep. Never run SendInput here.
                    unsafe {
                        if MsgWaitForMultipleObjectsEx(None, 5, QS_ALLINPUT, MWMO_INPUTAVAILABLE)
                            == WAIT_FAILED
                        {
                            shared.signal(INVALIDATED);
                            break;
                        }
                    }
                }
            })
            .map_err(|_| Error::Unavailable)?;
        let layout = match initialized.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(layout)) => layout,
            result => {
                stop.store(true, Ordering::Release);
                let _ = listener.join();
                return Err(match result {
                    Ok(Err(e)) => e,
                    _ => Error::Timeout,
                });
            }
        };
        let safety = Self {
            observations,
            stop,
            listener: Some(listener),
            _dpi: dpi,
            layout,
            marker,
            guard,
        };
        if !safety.guard_current() || safety.observations.closed.load(Ordering::Acquire) {
            return Err(Error::Unavailable);
        }
        Ok(safety)
    }
    pub fn guard_current(&self) -> bool {
        self.guard.is_none_or(|raw| unsafe {
            let hwnd = HWND(raw as *mut _);
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            pid == GetCurrentProcessId()
                && IsWindow(Some(hwnd)).as_bool()
                && GetForegroundWindow() == hwnd
        })
    }
    pub fn geometry_current(&self, g: Geometry) -> bool {
        g.desktop == self.layout.desktop && self.layout.monitors.iter().any(|m| m.1 == g.display)
    }
    pub fn local_keys_up(&self) -> bool {
        unsafe { (1..255).all(|key| GetAsyncKeyState(key) >= 0) }
    }
    pub fn pointer_in_guard(&self, x: i32, y: i32) -> bool {
        self.guard.is_none_or(|raw| unsafe {
            let hwnd = HWND(raw as *mut _);
            let mut r = RECT::default();
            let mut origin = POINT::default();
            if GetClientRect(hwnd, &mut r).is_err() || !ClientToScreen(hwnd, &mut origin).as_bool()
            {
                return false;
            }
            let d = self.layout.desktop;
            let px = i64::from(d.left) + i64::from(x) * i64::from(d.width) / 65536;
            let py = i64::from(d.top) + i64::from(y) * i64::from(d.height) / 65536;
            px >= i64::from(origin.x)
                && px < i64::from(origin.x + r.right)
                && py >= i64::from(origin.y)
                && py < i64::from(origin.y + r.bottom)
        })
    }
}

impl Drop for Safety {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn own_injection_does_not_take_over_and_other_injection_cannot_change_physical_ownership() {
        let mut o = Observation {
            marker: 0x574c1234,
            ..Default::default()
        };
        let own = MSLLHOOKSTRUCT {
            dwExtraInfo: o.marker,
            flags: LLMHF_INJECTED,
            ..Default::default()
        };
        o.mouse(&own, WM_LBUTTONDOWN);
        assert_eq!(o.signal, 0);
        assert!(!o.buttons[0]);
        let physical = MSLLHOOKSTRUCT::default();
        o.mouse(&physical, WM_LBUTTONDOWN);
        assert_eq!(o.signal, TAKEOVER);
        assert!(o.buttons[0]);
        let other = MSLLHOOKSTRUCT {
            dwExtraInfo: 1,
            ..own
        };
        o.mouse(&other, WM_LBUTTONUP);
        assert!(o.buttons[0]);
        o.mouse(&physical, WM_LBUTTONUP);
        assert!(!o.buttons[0]);
        o.signal = 0;
        o.mouse(&other, WM_LBUTTONDOWN);
        assert_eq!(o.signal, TAKEOVER);
        assert!(!o.buttons[0]);
    }
    #[test]
    fn extended_keyboard_and_physical_overlap_are_tracked_independently() {
        let mut o = Observation {
            marker: 0x1234,
            ..Default::default()
        };
        let mut key = KBDLLHOOKSTRUCT {
            scanCode: 0x1d,
            flags: LLKHF_EXTENDED,
            ..Default::default()
        };
        o.keyboard(&key);
        assert!(o.keys[0x11d]);
        assert!(!o.keys[0x1d]);
        key.flags = LLKHF_EXTENDED | LLKHF_UP | LLKHF_INJECTED;
        key.dwExtraInfo = o.marker;
        o.keyboard(&key);
        assert!(o.keys[0x11d]);
        key.dwExtraInfo = 42;
        o.keyboard(&key);
        assert!(o.keys[0x11d]);
        key.flags = LLKHF_EXTENDED | LLKHF_UP;
        o.keyboard(&key);
        assert!(!o.keys[0x11d]);
    }
}
