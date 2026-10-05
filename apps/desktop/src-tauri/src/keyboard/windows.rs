use super::{ExitShortcut, KeyboardEvent};
use std::{
    cell::RefCell,
    sync::{
        atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;
use weblink_desktop_input::keyboard_capture::{Decision, KeyboardCapture};
use windows::Win32::{
    Foundation::*,
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::{Accessibility::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
};

const CLOSED: u8 = 1;
const FOCUS: u8 = 2;
const EXPIRED: u8 = 3;
const OVERFLOW: u8 = 4;
const EXIT: u8 = 5;
const EMERGENCY: u8 = 6;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
struct Life {
    started: Instant,
    stopped: AtomicU8,
    deadline: AtomicU64,
    sequence: AtomicU64,
    acknowledged: AtomicU64,
    thread_id: AtomicU32,
    delivery: Mutex<Option<mpsc::SyncSender<Option<KeyboardEvent>>>>,
}
impl Life {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            stopped: AtomicU8::new(0),
            deadline: AtomicU64::new(750),
            sequence: AtomicU64::new(0),
            acknowledged: AtomicU64::new(0),
            thread_id: AtomicU32::new(0),
            delivery: Mutex::new(None),
        }
    }
    fn stop(&self, reason: u8) {
        if self
            .stopped
            .compare_exchange(0, reason, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            if let Some(send) = &*self.delivery.lock().unwrap_or_else(|e| e.into_inner()) {
                let _ = send.try_send(None);
            }
            let thread_id = self.thread_id.load(Ordering::Acquire);
            if thread_id != 0 {
                unsafe {
                    let _ = PostThreadMessageW(thread_id, WM_NULL, WPARAM(0), LPARAM(0));
                }
            }
        }
    }
    fn active(&self) -> bool {
        if self.elapsed() >= self.deadline.load(Ordering::Acquire) {
            self.stop(EXPIRED);
        }
        self.stopped.load(Ordering::Acquire) == 0
    }
    fn elapsed(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}
struct Session {
    id: String,
    life: Arc<Life>,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.life.stop(CLOSED);
    }
}
#[derive(Default)]
pub struct Service {
    session: Mutex<Option<Session>>,
}
impl Service {
    pub fn start(
        &self,
        id: String,
        hwnd: usize,
        exit: ExitShortcut,
        emergency_shortcut: ExitShortcut,
        events: Channel<KeyboardEvent>,
        emergency: impl FnOnce() + Send + 'static,
    ) -> Result<(), String> {
        let mut slot = self.session.lock().unwrap_or_else(|e| e.into_inner());
        slot.take();
        let life = Arc::new(Life::new());
        let (send, receive) = mpsc::sync_channel(64);
        *life.delivery.lock().unwrap() = Some(send.clone());
        let (ready, started) = mpsc::sync_channel(1);
        let shared = life.clone();
        thread::Builder::new()
            .name("weblink-keyboard-capture".into())
            .spawn(move || run(hwnd, exit, emergency_shortcut, shared, send, ready))
            .map_err(|e| e.to_string())?;
        match started.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok(())) => {}
            result => {
                life.stop(CLOSED);
                return Err(match result {
                    Ok(Err(error)) => error,
                    _ => "Keyboard capture startup timed out".into(),
                });
            }
        }
        let shared = life.clone();
        if let Err(error) = thread::Builder::new()
            .name("weblink-keyboard-delivery".into())
            .spawn(move || {
                while shared.active() {
                    match receive.recv() {
                        Ok(Some(event)) => {
                            if !shared.active() {
                                break;
                            }
                            if let KeyboardEvent::Key { timestamp, .. } = event {
                                if now().abs_diff(timestamp) > 100 {
                                    shared.stop(OVERFLOW);
                                    break;
                                }
                            }
                            if events.send(event).is_err() {
                                shared.stop(CLOSED);
                            }
                        }
                        Ok(None) | Err(_) => {
                            shared.stop(CLOSED);
                        }
                    }
                }
                let reason = match shared.stopped.load(Ordering::Acquire) {
                    FOCUS => "focus",
                    EXPIRED => "expired",
                    OVERFLOW => "overflow",
                    EXIT => "exit",
                    EMERGENCY => "emergency",
                    _ => "closed",
                };
                if reason == "emergency" {
                    emergency();
                }
                let _ = events.send(KeyboardEvent::Stopped { reason });
            })
        {
            life.stop(CLOSED);
            return Err(error.to_string());
        }
        *slot = Some(Session { id, life });
        Ok(())
    }
    pub fn renew(&self, id: &str, sequence: u64) -> Result<(), String> {
        let slot = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let s = slot
            .as_ref()
            .filter(|s| s.id == id && s.life.active())
            .ok_or("Keyboard capture ended")?;
        if sequence < s.life.acknowledged.load(Ordering::Acquire)
            || sequence > s.life.sequence.load(Ordering::Acquire)
        {
            return Err("Invalid keyboard acknowledgement".into());
        }
        s.life.acknowledged.store(sequence, Ordering::Release);
        s.life
            .deadline
            .store(s.life.elapsed() + 750, Ordering::Release);
        Ok(())
    }
    pub fn stop(&self, id: &str) {
        let mut slot = self.session.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|s| s.id == id) {
            slot.take();
        }
    }
    pub fn close(&self) {
        self.session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}
struct Capture {
    hwnd: HWND,
    life: Arc<Life>,
    policy: KeyboardCapture,
    send: mpsc::SyncSender<Option<KeyboardEvent>>,
}
thread_local! { static CAPTURE: RefCell<Option<Capture>> = const { RefCell::new(None) }; }
unsafe fn foreground(hwnd: HWND) -> bool {
    GetForegroundWindow() == hwnd && IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool()
}
unsafe extern "system" fn hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code != HC_ACTION as i32 {
        return CallNextHookEx(None, code, wp, lp);
    }
    let value = &*(lp.0 as *const KBDLLHOOKSTRUCT);
    let down = match wp.0 as u32 {
        WM_KEYDOWN | WM_SYSKEYDOWN => true,
        WM_KEYUP | WM_SYSKEYUP => false,
        _ => return CallNextHookEx(None, code, wp, lp),
    };
    let suppress = CAPTURE.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else {
            return false;
        };
        let Some(s) = slot.as_mut() else {
            return false;
        };
        if !foreground(s.hwnd) {
            s.life.stop(FOCUS);
        }
        let active = s.life.active();
        let Ok(scan) = u16::try_from(value.scanCode) else {
            return false;
        };
        match s.policy.input(
            scan,
            value.flags.contains(LLKHF_EXTENDED),
            down,
            value.flags.contains(LLKHF_INJECTED),
            value.vkCode,
            active,
        ) {
            Decision::Pass => false,
            Decision::Suppress => true,
            Decision::Exit => {
                s.life.stop(EXIT);
                true
            }
            Decision::Emergency => {
                s.life.stop(EMERGENCY);
                true
            }
            Decision::Forward(key, down) => {
                let sequence = s.life.sequence.fetch_add(1, Ordering::AcqRel) + 1;
                if sequence.saturating_sub(s.life.acknowledged.load(Ordering::Acquire)) > 64
                    || s.send
                        .try_send(Some(KeyboardEvent::Key {
                            scan_code: key.code(),
                            extended: key.extended(),
                            down,
                            sequence,
                            timestamp: now(),
                        }))
                        .is_err()
                {
                    s.life.stop(OVERFLOW);
                }
                true
            }
        }
    });
    if suppress {
        LRESULT(1)
    } else {
        CallNextHookEx(None, code, wp, lp)
    }
}
unsafe extern "system" fn focus_changed(
    _: HWINEVENTHOOK,
    _: u32,
    _: HWND,
    _: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    CAPTURE.with(|slot| {
        if let Some(capture) = slot.borrow().as_ref() {
            if !foreground(capture.hwnd) {
                capture.life.stop(FOCUS);
            }
        }
    });
}
fn run(
    hwnd: usize,
    exit: ExitShortcut,
    emergency_shortcut: ExitShortcut,
    life: Arc<Life>,
    send: mpsc::SyncSender<Option<KeyboardEvent>>,
    ready: mpsc::SyncSender<Result<(), String>>,
) {
    unsafe {
        let hwnd = HWND(hwnd as *mut _);
        if !foreground(hwnd) || !weblink_desktop_input::windows::input_desktop_available() {
            let _ = ready.send(Err("Control window is not in the foreground".into()));
            life.stop(FOCUS);
            return;
        }
        let mut initial = [false; 256];
        for (vk, down) in initial.iter_mut().enumerate().skip(8) {
            if !(0x10..=0x12).contains(&vk) {
                *down = GetAsyncKeyState(vk as i32) < 0;
            }
        }
        CAPTURE.with(|slot| {
            *slot.borrow_mut() = Some(Capture {
                hwnd,
                life: life.clone(),
                policy: KeyboardCapture::new(exit, emergency_shortcut, initial),
                send,
            })
        });
        let installed = GetModuleHandleW(None).and_then(|module| {
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), Some(module.into()), 0)
        });
        let handle = match installed {
            Ok(handle) => handle,
            Err(e) => {
                CAPTURE.with(|slot| slot.borrow_mut().take());
                life.stop(CLOSED);
                let _ = ready.send(Err(e.to_string()));
                return;
            }
        };
        let focus_hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(focus_changed),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        life.thread_id
            .store(GetCurrentThreadId(), Ordering::Release);
        let _ = ready.send(Ok(()));
        let mut draining = None;
        let mut desktop_check = Instant::now();
        loop {
            if desktop_check.elapsed() >= Duration::from_millis(50) {
                if !weblink_desktop_input::windows::input_desktop_available() {
                    life.stop(FOCUS);
                }
                desktop_check = Instant::now();
            }
            if !foreground(hwnd) {
                life.stop(FOCUS);
            }
            if !life.active() {
                let start = draining.get_or_insert_with(Instant::now);
                let held =
                    CAPTURE.with(|slot| slot.borrow().as_ref().is_some_and(|s| s.policy.held()));
                // Only consume releases of keys captured here; never new background input.
                if !held || start.elapsed() >= Duration::from_secs(2) {
                    break;
                }
            }
            let mut msg = MSG::default();
            for _ in 0..128 {
                if !PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    break;
                }
                if msg.message == WM_QUIT {
                    life.stop(CLOSED);
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let mut wait = Duration::from_millis(50).saturating_sub(desktop_check.elapsed());
            if draining.is_none() {
                wait = wait.min(Duration::from_millis(
                    life.deadline
                        .load(Ordering::Acquire)
                        .saturating_sub(life.elapsed()),
                ));
            }
            if MsgWaitForMultipleObjectsEx(
                None,
                wait.as_millis().max(1) as u32,
                QS_ALLINPUT,
                MWMO_INPUTAVAILABLE,
            ) == WAIT_FAILED
            {
                life.stop(CLOSED);
                break;
            }
        }
        let _ = UnhookWindowsHookEx(handle);
        let _ = UnhookWinEvent(focus_hook);
        life.thread_id.store(0, Ordering::Release);
        CAPTURE.with(|slot| slot.borrow_mut().take());
        life.stop(CLOSED);
    }
}

/// Implementation availability only; starting still verifies focus and native access.
pub fn supported() -> bool {
    true
}
pub async fn start(
    window: tauri::WebviewWindow,
    service: Arc<Service>,
    session_id: String,
    exit_shortcut: ExitShortcut,
    events: Channel<KeyboardEvent>,
) -> Result<(), String> {
    use tauri::Manager;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    let host = window
        .state::<crate::remote_control::Shared>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let revoker = host.clone();
        host.with_shortcut(|emergency_shortcut| {
            service.start(
                session_id,
                hwnd,
                exit_shortcut,
                emergency_shortcut,
                events,
                move || revoker.emergency_revoke(),
            )
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stopping_capture_wakes_delivery_once_without_polling() {
        let life = Life::new();
        let (send, receive) = mpsc::sync_channel(1);
        *life.delivery.lock().unwrap() = Some(send);
        life.stop(FOCUS);
        assert!(receive
            .recv_timeout(Duration::from_millis(100))
            .unwrap()
            .is_none());
        life.stop(CLOSED);
        assert!(receive.try_recv().is_err());
        assert_eq!(life.stopped.load(Ordering::Acquire), FOCUS);
    }
    fn service() -> (Service, Arc<Life>) {
        let life = Arc::new(Life::new());
        (
            Service {
                session: Mutex::new(Some(Session {
                    id: "current".into(),
                    life: life.clone(),
                })),
            },
            life,
        )
    }
    #[test]
    fn renewal_requires_current_capture_and_consumed_sequence() {
        let (service, life) = service();
        life.sequence.store(3, Ordering::Release);
        assert!(service.renew("retired", 0).is_err());
        assert!(service.renew("current", 4).is_err());
        assert!(service.renew("current", 2).is_ok());
        assert!(service.renew("current", 1).is_err());
        assert!(service.renew("current", 3).is_ok());
        life.deadline.store(0, Ordering::Release);
        assert!(service.renew("current", 3).is_err());
        assert_eq!(life.stopped.load(Ordering::Acquire), EXPIRED);
    }
    #[test]
    fn old_capture_cleanup_cannot_stop_its_replacement() {
        let (service, life) = service();
        service.stop("retired");
        assert!(life.active());
        service.stop("current");
        assert!(!life.active());
        assert!(service.renew("current", 0).is_err());
        let next = Arc::new(Life::new());
        *service.session.lock().unwrap() = Some(Session {
            id: "next".into(),
            life: next.clone(),
        });
        service.stop("current");
        assert!(next.active());
        service.close();
        assert!(!next.active());
    }
}
