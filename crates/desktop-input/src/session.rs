//! Native input actor boundary. The caller owns one attended session, not an OS device.
use crate::{
    authorization::{Binding, Grant, RequestResult},
    engine::{Status, TrustedTarget},
    input::{Error, Event},
    protocol::Signal,
};
use std::sync::{atomic::AtomicBool, Arc};

/// Operations are serialized by the backend. Only locally resolved capture targets
/// may be registered. Network handlers cannot bypass the authorization engine.
pub trait Session: Send {
    fn configure_shortcut(&self, _shortcut: crate::shortcut::Shortcut) -> Result<(), Error> {
        Err(Error::Unavailable)
    }
    /// Wake the native owner when status changes. False retains its bounded
    /// fallback for backends without notifications.
    fn set_waker(&self, _owner: std::thread::Thread) -> bool {
        false
    }
    /// The backend must observe invalidation before injecting any queued input.
    fn register_until(
        &self,
        target: TrustedTarget,
        invalidated: Arc<AtomicBool>,
    ) -> Result<bool, Error>;
    fn request(&self, media: String, signal: Signal) -> Result<Option<RequestResult>, Error>;
    fn approve(&self, consent: String) -> Result<Option<Signal>, Error>;
    fn decline(&self, consent: String) -> Result<Option<Signal>, Error>;
    fn renew(&self, grant: Grant) -> Result<bool, Error>;
    fn receive_end(&self, media: String, signal: Signal) -> Result<bool, Error>;
    fn invalidate(&self, binding: Binding) -> Result<(), Error>;
    /// Discard queued input and release held inputs, retaining the attended grant.
    fn interrupt(&self) -> Result<(), Error>;
    fn revoke(&self) -> Result<(), Error>;
    /// Success means queued; flush observes completed native submissions.
    fn input(&self, grant: Grant, event: Event) -> Result<(), Error>;
    fn flush(&self) -> Result<Status, Error>;
    fn status(&self) -> Status;
    /// Close the queue, release held inputs and join the native thread. Idempotent;
    /// implementations must also do this when dropped, including startup failures.
    fn shutdown(&mut self);
}

/// Implementation availability, not a permission grant or a promise of OS access.
/// Querying it must not start input injection or register native hooks/hotkeys.
pub fn supported() -> bool {
    cfg!(target_os = "windows")
}

pub fn start() -> Result<Box<dyn Session>, Error> {
    start_with_shortcut(crate::shortcut::Shortcut::default())
}
pub fn start_with_shortcut(shortcut: crate::shortcut::Shortcut) -> Result<Box<dyn Session>, Error> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::Worker::start_with_shortcut(None, shortcut)
            .map(|worker| Box::new(worker) as Box<dyn Session>)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = shortcut;
        Err(Error::Unavailable)
    }
}
