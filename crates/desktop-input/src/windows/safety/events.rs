//! Wake the message owner for local commands and input desktop changes.
use crate::input::Error;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows::Win32::{
    Foundation::{HANDLE, HWND},
    System::Threading::{CreateEventW, SetEvent},
    UI::{Accessibility::*, WindowsAndMessaging::*},
};

pub(super) struct Wake(OwnedHandle);
impl Wake {
    pub fn new() -> Result<Self, Error> {
        let handle =
            unsafe { CreateEventW(None, false, false, None) }.map_err(|_| Error::Unavailable)?;
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle.0) }))
    }
    pub fn handle(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }
    pub fn notify(&self) {
        // Every waiter/producer owns an Arc, so the event cannot close during use.
        let _ = unsafe { SetEvent(self.handle()) };
    }
}

pub(super) struct DesktopSwitch(HWINEVENTHOOK);
impl DesktopSwitch {
    pub fn new() -> Result<Self, Error> {
        let hook = unsafe {
            SetWinEventHook(
                EVENT_SYSTEM_DESKTOPSWITCH,
                EVENT_SYSTEM_DESKTOPSWITCH,
                None,
                Some(changed),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            )
        };
        if hook.0.is_null() {
            Err(Error::Unavailable)
        } else {
            Ok(Self(hook))
        }
    }
}
impl Drop for DesktopSwitch {
    fn drop(&mut self) {
        let _ = unsafe { UnhookWinEvent(self.0) };
    }
}
unsafe extern "system" fn changed(
    _: HWINEVENTHOOK,
    _: u32,
    _: HWND,
    _: i32,
    _: i32,
    _: u32,
    _: u32,
) {
    // No desktop enumeration or input injection from this callback. Switching
    // away ends the binding even if the default desktop returns before we run.
    super::signal(super::INVALIDATED);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{mpsc, Arc},
        thread,
        time::Duration,
    };
    use windows::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::WaitForSingleObject};

    #[test]
    fn commands_retain_a_wake_before_waiting_and_can_wake_an_idle_owner() {
        let wake = Arc::new(Wake::new().unwrap());
        wake.notify();
        assert_eq!(
            unsafe { WaitForSingleObject(wake.handle(), 0) },
            WAIT_OBJECT_0
        );
        let worker_wake = wake.clone();
        let (send, receive) = mpsc::channel();
        let worker = thread::spawn(move || {
            send.send(unsafe { WaitForSingleObject(worker_wake.handle(), u32::MAX) })
                .unwrap();
        });
        assert_eq!(
            receive.recv_timeout(Duration::from_millis(350)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        wake.notify();
        assert_eq!(
            receive.recv_timeout(Duration::from_secs(2)).unwrap(),
            WAIT_OBJECT_0
        );
        worker.join().unwrap();
    }

    #[test]
    fn desktop_switch_invalidates_even_if_the_original_desktop_has_returned() {
        let observed = Arc::new(super::super::Observations::new());
        super::super::OBSERVED.with(|slot| *slot.borrow_mut() = Some(observed.clone()));
        unsafe {
            changed(
                HWINEVENTHOOK::default(),
                EVENT_SYSTEM_DESKTOPSWITCH,
                HWND::default(),
                0,
                0,
                0,
                0,
            )
        };
        assert!(observed.pending());
        assert_eq!(observed.signals(), super::super::INVALIDATED);
        super::super::OBSERVED.with(|slot| slot.borrow_mut().take());
    }
}
