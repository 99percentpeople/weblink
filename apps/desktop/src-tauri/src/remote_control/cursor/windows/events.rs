//! System cursor shape/visibility notifications. No cursor pixels in callbacks.
use super::super::changes::{Changes, APPEARANCE};
use std::{
    cell::RefCell,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
};
use windows::Win32::{
    Foundation::*,
    System::Threading::{CreateEventW, SetEvent},
    UI::{Accessibility::*, WindowsAndMessaging::*},
};

thread_local! { static CHANGES: RefCell<Option<Changes>> = const { RefCell::new(None) }; }
unsafe extern "system" fn changed(
    _: HWINEVENTHOOK,
    _: u32,
    _: HWND,
    object: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    if object == OBJID_CURSOR.0 {
        CHANGES.with(|slot| {
            if let Some(changes) = slot.borrow().as_ref() {
                changes.notify(APPEARANCE);
            }
        });
    }
}
struct Hook(HWINEVENTHOOK);
impl Drop for Hook {
    fn drop(&mut self) {
        let _ = unsafe { UnhookWinEvent(self.0) };
    }
}
struct Exit(Arc<AtomicBool>, Changes);
impl Drop for Exit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
        self.1.notify(APPEARANCE);
    }
}

pub(in super::super) struct Listener {
    stop: Arc<OwnedHandle>,
    alive: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Listener {
    pub fn new(changes: Changes) -> Option<Self> {
        let stop = unsafe { CreateEventW(None, true, false, None) }.ok()?;
        let stop = Arc::new(unsafe { OwnedHandle::from_raw_handle(stop.0) });
        let stopping = stop.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let live = alive.clone();
        let (ready, receive) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("weblink-cursor-events".into())
            .spawn(move || unsafe {
                let _exit = Exit(live, changes.clone());
                let mut hooks = Vec::new();
                CHANGES.with(|slot| *slot.borrow_mut() = Some(changes));
                for kind in [
                    EVENT_OBJECT_NAMECHANGE,
                    EVENT_OBJECT_SHOW,
                    EVENT_OBJECT_HIDE,
                ] {
                    let hook = SetWinEventHook(
                        kind,
                        kind,
                        None,
                        Some(changed),
                        0,
                        0,
                        WINEVENT_OUTOFCONTEXT,
                    );
                    if hook.0.is_null() {
                        let _ = ready.send(false);
                        return;
                    }
                    hooks.push(Hook(hook));
                }
                if ready.send(true).is_ok() {
                    loop {
                        let wait = MsgWaitForMultipleObjectsEx(
                            Some(&[HANDLE(stopping.as_raw_handle())]),
                            u32::MAX,
                            QS_ALLINPUT,
                            MWMO_INPUTAVAILABLE,
                        );
                        if wait != WAIT_EVENT(WAIT_OBJECT_0.0 + 1) {
                            break;
                        }
                        let mut message = MSG::default();
                        for _ in 0..256 {
                            if !PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                                break;
                            }
                            if message.message == WM_QUIT {
                                return;
                            }
                            let _ = TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                }
                drop(hooks);
                CHANGES.with(|slot| slot.borrow_mut().take());
            })
            .ok()?;
        if receive.recv().unwrap_or(false) {
            Some(Self {
                stop,
                alive,
                thread: Some(thread),
            })
        } else {
            let _ = thread.join();
            None
        }
    }
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }
}
impl Drop for Listener {
    fn drop(&mut self) {
        let _ = unsafe { SetEvent(HANDLE(self.stop.as_raw_handle())) };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_event_listener_can_cancel_without_another_windows_message() {
        for _ in 0..8 {
            let changes = Changes::default();
            changes.activate(true);
            let listener = Listener::new(changes.clone()).expect("Cursor events unavailable");
            assert!(listener.alive());
            drop(listener);
            // An unexpected worker exit is also observable, never silent staleness.
            assert!(changes.pending());
        }
    }
}
