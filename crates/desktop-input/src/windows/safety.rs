use super::environment::{desktop_available, layout, InputDpi, Layout};
use crate::input::{Error, Geometry};
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc, Arc,
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

pub(super) const INVALIDATED: u8 = 2;
pub(super) const EMERGENCY: u8 = 4;
const HOTKEY: i32 = 0x574c;
pub(super) struct Observations {
    signals: AtomicU8,
    closed: AtomicBool,
    owner: thread::Thread,
}
impl Observations {
    pub fn signals(&self) -> u8 {
        self.signals.swap(0, Ordering::AcqRel)
    }
    pub fn pending(&self) -> bool {
        self.closed.load(Ordering::Acquire) || self.signals.load(Ordering::Acquire) != 0
    }
    fn signal(&self, value: u8) {
        if value & INVALIDATED != 0 {
            self.closed.store(true, Ordering::Release);
        }
        self.signals.fetch_or(value, Ordering::AcqRel);
        self.owner.unpark();
    }
}
thread_local! {
    static OBSERVED: RefCell<Option<Arc<Observations>>> = const {RefCell::new(None)};
    static OBSERVED_LAYOUT: RefCell<Option<Layout>> = const {RefCell::new(None)};
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
unsafe extern "system" fn window(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_HOTKEY if wp.0 == HOTKEY as usize => signal(EMERGENCY),
        // Input preferences, theme and application activation can broadcast settings
        // changes without invalidating the authorized desktop. Recheck the binding
        // environment instead of terminating control for every settings notification.
        WM_SETTINGCHANGE => OBSERVED_LAYOUT.with(|expected| {
            if settings_invalidated(expected.borrow().as_ref(), layout(), desktop_available()) {
                signal(INVALIDATED);
            }
        }),
        WM_DISPLAYCHANGE | WM_DPICHANGED | WM_WTSSESSION_CHANGE | WM_QUERYENDSESSION
        | WM_ENDSESSION => signal(INVALIDATED),
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}
fn settings_invalidated(
    expected: Option<&Layout>,
    current: Result<Layout, Error>,
    available: bool,
) -> bool {
    !available || expected.is_none() || current.as_ref().ok() != expected
}
struct Listener {
    hwnd: HWND,
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
                OBSERVED_LAYOUT.with(|slot| *slot.borrow_mut() = Some(layout.clone()));
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
            signals: AtomicU8::new(0),
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
                    // Wake on lifecycle/hotkey messages, not a polling sleep. Never run SendInput here.
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
    pub fn pointer_in_guard(&self, x: i32, y: i32) -> bool {
        let d = self.layout.desktop;
        let px = i64::from(d.left) + i64::from(x) * i64::from(d.width) / 65536;
        let py = i64::from(d.top) + i64::from(y) * i64::from(d.height) / 65536;
        self.pixel_in_guard(px as i32, py as i32)
    }
    pub fn pixel_in_guard(&self, px: i32, py: i32) -> bool {
        self.guard.is_none_or(|raw| unsafe {
            let hwnd = HWND(raw as *mut _);
            let mut r = RECT::default();
            let mut origin = POINT::default();
            if GetClientRect(hwnd, &mut r).is_err() || !ClientToScreen(hwnd, &mut origin).as_bool()
            {
                return false;
            }
            px >= origin.x && px < origin.x + r.right && py >= origin.y && py < origin.y + r.bottom
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
    fn ordinary_settings_changes_keep_control_but_changed_or_unavailable_desktop_does_not() {
        let original = Layout {
            desktop: crate::input::Rect {
                left: 0,
                top: 0,
                width: 1920,
                height: 1080,
            },
            monitors: vec![],
        };
        assert!(!settings_invalidated(
            Some(&original),
            Ok(original.clone()),
            true
        ));
        let mut changed = original.clone();
        changed.desktop.width = 2560;
        assert!(settings_invalidated(Some(&original), Ok(changed), true));
        assert!(settings_invalidated(
            Some(&original),
            Ok(original.clone()),
            false
        ));
        assert!(settings_invalidated(
            Some(&original),
            Err(Error::Unavailable),
            true
        ));
        assert!(settings_invalidated(None, Ok(original), true));
    }
}
