//! Window-owned native video surfaces. Only opaque source IDs and layout cross IPC.
#[cfg(windows)]
#[path = "presentation/windows.rs"]
mod platform;
#[cfg(not(windows))]
#[path = "presentation/unavailable.rs"]
mod platform;
pub use platform::*;
