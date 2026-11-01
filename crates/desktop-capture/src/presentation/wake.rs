//! Coalesced cross-thread wakeup, also waitable alongside native GPU events.
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::Threading::{CreateEventW, SetEvent},
};

pub(super) struct Wake(HANDLE);
// The auto-reset event is signalled from publishers; only the render worker waits.
unsafe impl Send for Wake {}
unsafe impl Sync for Wake {}
impl Wake {
    pub fn new() -> Result<Self, String> {
        unsafe { CreateEventW(None, false, false, None) }
            .map(Self)
            .map_err(|e| e.to_string())
    }
    pub fn signal(&self) {
        // The handle remains open until the worker and all subscriptions exit.
        let _ = unsafe { SetEvent(self.0) };
    }
    pub fn handle(&self) -> HANDLE {
        self.0
    }
}
impl Drop for Wake {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}
