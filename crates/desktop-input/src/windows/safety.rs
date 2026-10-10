use super::environment::{desktop_available, layout, InputDpi, Layout};
use super::hotkey::Listener as ShortcutListener;
use crate::input::{Error, Geometry};
use crate::shortcut::Shortcut;
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use windows::{
    core::{w, HSTRING},
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::{
            LibraryLoader::GetModuleHandleW, RemoteDesktop::*, Threading::GetCurrentProcessId,
        },
        UI::{HiDpi::*, WindowsAndMessaging::*},
    },
};
mod events;

pub(super) const INVALIDATED: u8 = 2;
pub(super) struct Observations {
    signals: AtomicU8,
    closed: AtomicBool,
    owner: thread::Thread,
    grant_epoch: AtomicU64,
    emergency_epoch: AtomicU64,
    pointer_activity: AtomicU64,
    pointer_changed: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}
impl Observations {
    pub fn new() -> Self {
        Self {
            signals: AtomicU8::new(0),
            closed: AtomicBool::new(false),
            owner: thread::current(),
            grant_epoch: AtomicU64::new(0),
            emergency_epoch: AtomicU64::new(0),
            pointer_activity: AtomicU64::new(0),
            pointer_changed: Mutex::new(None),
        }
    }
    pub fn authorize(&self, epoch: u64) {
        self.grant_epoch.store(epoch, Ordering::Release);
    }
    pub fn grant_epoch(&self) -> u64 {
        self.grant_epoch.load(Ordering::Acquire)
    }
    pub fn pointer_moved(&self, local: bool) {
        if self.grant_epoch() != 0 && !self.closed.load(Ordering::Acquire) {
            // One atomic snapshot carries both sequence and origin. The observer
            // only coalesces invalidations; no pixels or network traffic in hooks.
            let _ =
                self.pointer_activity
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |old| {
                        Some((old.wrapping_add(2) & !1) | u64::from(local))
                    });
            let changed = self
                .pointer_changed
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if let Some(changed) = changed {
                changed();
            }
        }
    }
    pub fn observe_pointer(&self, changed: Option<Arc<dyn Fn() + Send + Sync>>) {
        *self
            .pointer_changed
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = changed;
    }
    pub fn pointer_activity(&self) -> crate::session::PointerActivity {
        let value = self.pointer_activity.load(Ordering::Acquire);
        crate::session::PointerActivity {
            sequence: value >> 1,
            local: value & 1 != 0,
        }
    }
    pub fn emergency(&self, epoch: u64) {
        if epoch != 0 && epoch == self.grant_epoch() && !self.closed.load(Ordering::Acquire) {
            self.emergency_epoch.fetch_max(epoch, Ordering::AcqRel);
            self.owner.unpark();
        }
    }
    pub fn take_emergency(&self) -> bool {
        let epoch = self.emergency_epoch.swap(0, Ordering::AcqRel);
        epoch != 0 && epoch == self.grant_epoch()
    }
    pub fn signals(&self) -> u8 {
        self.signals.swap(0, Ordering::AcqRel)
    }
    pub fn pending(&self) -> bool {
        let emergency = self.emergency_epoch.load(Ordering::Acquire);
        self.closed.load(Ordering::Acquire)
            || self.signals.load(Ordering::Acquire) != 0
            || (emergency != 0 && emergency == self.grant_epoch())
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
    hotkey: Option<ShortcutListener>,
    pointer: Option<super::pointer_observer::Listener>,
    desktop: Option<events::DesktopSwitch>,
    session: bool,
    class: HSTRING,
    old_dpi: DPI_AWARENESS_CONTEXT,
    pub layout: Layout,
}
impl Listener {
    fn new(
        observations: Arc<Observations>,
        shortcut: Shortcut,
        marker: usize,
    ) -> Result<Self, Error> {
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
                OBSERVED.with(|slot| *slot.borrow_mut() = Some(observations.clone()));
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
                    hotkey: None,
                    pointer: None,
                    desktop: None,
                    session: false,
                    class,
                    old_dpi,
                    layout,
                };
                s.hotkey = Some(ShortcutListener::new(shortcut, observations.clone())?);
                s.pointer = Some(super::pointer_observer::Listener::new(
                    marker,
                    observations,
                )?);
                WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)
                    .map_err(|_| Error::Unavailable)?;
                s.session = true;
                s.desktop = Some(events::DesktopSwitch::new()?);
                // Check again after registration to cover a switch during setup.
                if !desktop_available() || super::environment::layout().as_ref() != Ok(&s.layout) {
                    return Err(Error::Unavailable);
                }
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
            self.hotkey.take();
            self.pointer.take();
            self.desktop.take();
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

#[derive(Clone)]
pub(super) struct ShortcutControl {
    send: mpsc::SyncSender<(Shortcut, mpsc::SyncSender<Result<(), Error>>)>,
    wake: Arc<events::Wake>,
}
impl ShortcutControl {
    pub fn configure(&self, shortcut: Shortcut) -> Result<(), Error> {
        let (send, receive) = mpsc::sync_channel(1);
        self.send
            .send((shortcut, send))
            .map_err(|_| Error::Closed)?;
        self.wake.notify();
        // The command wakes the message owner; disconnect also wakes the reply.
        // No timeout that could report failure followed by a late successful update.
        receive.recv().map_err(|_| Error::Closed)?
    }
}

pub(super) struct Safety {
    pub observations: Arc<Observations>,
    pub shortcut: ShortcutControl,
    stop: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
    wake: Arc<events::Wake>,
    _dpi: InputDpi,
    pub layout: Layout,
    pub marker: usize,
    guard: Option<usize>,
}
impl Safety {
    pub fn new(guard: Option<usize>, shortcut: Shortcut) -> Result<Self, Error> {
        let dpi = InputDpi::new()?;
        // Mouse ExtraInfo can be truncated to 32 bits even for 64-bit SendInput.
        // This positive tag identifies our injections; it is not an authorization token.
        let marker = ((uuid::Uuid::new_v4().as_u128() as u32 & 0x7fff_ffff) | 1) as usize;
        let observations = Arc::new(Observations::new());
        let stop = Arc::new(AtomicBool::new(false));
        let shared = observations.clone();
        let stopping = stop.clone();
        let wake = Arc::new(events::Wake::new()?);
        let notified = wake.clone();
        let (ready, initialized) = mpsc::sync_channel(1);
        let (configure, requests) =
            mpsc::sync_channel::<(Shortcut, mpsc::SyncSender<Result<(), Error>>)>(1);
        let listener = thread::Builder::new()
            .name("weblink-input-events".into())
            .spawn(move || {
                let _exit = ObserverExit(shared.clone());
                let mut native = match Listener::new(shared.clone(), shortcut, marker) {
                    Ok(native) => native,
                    Err(e) => {
                        let _ = ready.send(Err(e));
                        return;
                    }
                };
                let _ = ready.send(Ok(native.layout.clone()));
                while !stopping.load(Ordering::Acquire) {
                    pump();
                    while let Ok((shortcut, reply)) = requests.try_recv() {
                        let result = native
                            .hotkey
                            .as_mut()
                            .ok_or(Error::Closed)
                            .and_then(|key| key.configure(shortcut));
                        let _ = reply.send(result);
                    }
                    if stopping.load(Ordering::Acquire) {
                        break;
                    }
                    // Display/settings/session messages and the desktop-switch
                    // hook cover environment changes. Local commands and stop
                    // signal the event, including before this wait starts.
                    unsafe {
                        if MsgWaitForMultipleObjectsEx(
                            Some(&[notified.handle()]),
                            u32::MAX,
                            QS_ALLINPUT,
                            MWMO_INPUTAVAILABLE,
                        ) == WAIT_FAILED
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
                wake.notify();
                let _ = listener.join();
                return Err(match result {
                    Ok(Err(e)) => e,
                    _ => Error::Timeout,
                });
            }
        };
        let safety = Self {
            observations,
            shortcut: ShortcutControl {
                send: configure,
                wake: wake.clone(),
            },
            stop,
            listener: Some(listener),
            wake,
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
        self.wake.notify();
        if let Some(listener) = self.listener.take() {
            let _ = listener.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires an unlocked Windows desktop; installs passive listeners and sends no input"]
    fn native_safety_commands_and_shutdown_wake_an_idle_listener() {
        let (ready, initialized) = mpsc::channel();
        let (stop, stopping) = mpsc::channel();
        let (done, finished) = mpsc::channel();
        let owner = thread::spawn(move || {
            let safety = Safety::new(None, Shortcut::default()).unwrap();
            ready.send(safety.shortcut.clone()).unwrap();
            stopping.recv().unwrap();
            drop(safety);
            done.send(()).unwrap();
        });
        let shortcut = initialized.recv_timeout(Duration::from_secs(5)).unwrap();
        // No input, settings messages or periodic environment scan is required
        // for this command to reach the message owner's blocking wait.
        shortcut
            .configure("ctrl-alt-shift-f9".to_owned().try_into().unwrap())
            .unwrap();
        shortcut.configure(Shortcut::default()).unwrap();
        stop.send(()).unwrap();
        finished.recv_timeout(Duration::from_secs(2)).unwrap();
        owner.join().unwrap();
        assert_eq!(shortcut.configure(Shortcut::default()), Err(Error::Closed));
    }
    #[test]
    fn mouse_origin_observation_requires_a_live_grant_and_retains_native_order() {
        let observations = Observations::new();
        observations.pointer_moved(true);
        assert_eq!(observations.pointer_activity().sequence, 0);
        observations.authorize(1);
        for (index, local) in [true, true, false, true].into_iter().enumerate() {
            observations.pointer_moved(local);
            assert_eq!(
                observations.pointer_activity(),
                crate::session::PointerActivity {
                    sequence: index as u64 + 1,
                    local,
                }
            );
        }
        observations.authorize(0);
        observations.pointer_moved(false);
        assert!(observations.pointer_activity().local);
        assert_eq!(observations.pointer_activity().sequence, 4);
    }
    #[test]
    fn emergency_requires_current_grant_and_cannot_revoke_a_replacement() {
        let observations = Observations::new();
        observations.emergency(0);
        assert!(!observations.pending());
        assert!(!observations.take_emergency());
        observations.authorize(1);
        observations.emergency(1);
        assert!(observations.pending());
        assert!(observations.take_emergency());
        assert!(!observations.take_emergency());
        observations.emergency(1);
        observations.authorize(0);
        assert!(!observations.pending());
        assert!(!observations.take_emergency());
        observations.authorize(2);
        observations.emergency(2);
        observations.authorize(3);
        assert!(!observations.pending());
        assert!(!observations.take_emergency());
        observations.emergency(2);
        assert!(!observations.take_emergency());
        observations.emergency(3);
        assert!(observations.take_emergency());
    }
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
