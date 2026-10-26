//! Portable accessibility contract. OS objects stay on one worker thread;
//! transports receive only bounded snapshots and caller-bound opaque references.
mod model;
mod observation;
#[cfg(any(windows, test))]
mod session;
mod wait;
#[cfg(windows)]
mod windows;
mod worker;
pub use model::*;
use std::sync::Arc;
pub use wait::WaitSignal;
pub use weblink_desktop_input::window::BoundWindow;
pub use worker::Client;

/// Rechecked between provider calls and immediately before any semantic action.
pub type Check = Arc<dyn Fn() -> Result<()> + Send + Sync>;
#[derive(Clone)]
pub struct Access {
    pub owner: String,
    /// Current request, timeout, consent and exclusive control authority.
    pub check: Check,
    /// Original read grant. Retained references become unusable when it expires/revokes.
    pub lease: Check,
}

/// Owned and dropped on the backend thread. Dropping removes exactly this subscription.
pub trait EventSubscription {}

/// Implement on a dedicated native thread. No Tauri, MCP or UIA types cross this API.
/// Backends must exclude the application's own UI, fail closed on protected content,
/// and call `check` after resolving a pattern and immediately before its side effect.
pub trait Backend {
    type Element: Clone;
    fn subscribe(
        &mut self,
        _element: &Self::Element,
        _condition: &WaitCondition,
        _signal: Arc<WaitSignal>,
        _check: &Check,
    ) -> Result<Box<dyn EventSubscription>> {
        Err(Error::Unsupported)
    }
    fn bind_window(&mut self, _element: &Self::Element, _check: &Check) -> Result<BoundWindow> {
        Err(Error::Unsupported)
    }
    fn name(&self) -> &'static str;
    fn roots(&mut self, limit: usize, check: &Check) -> Result<(Vec<Self::Element>, bool)>;
    fn children(
        &mut self,
        element: &Self::Element,
        limit: usize,
        check: &Check,
    ) -> Result<(Vec<Self::Element>, bool)>;
    fn inspect(
        &mut self,
        element: &Self::Element,
        options: &ReadOptions,
        check: &Check,
    ) -> Result<ElementInfo>;
    fn perform(
        &mut self,
        element: &Self::Element,
        action: Action,
        value: Option<&str>,
        check: &Check,
    ) -> Result<()>;
}
