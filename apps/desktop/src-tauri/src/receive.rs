//! Native receive lifecycle and IPC are scoped to the creating WebView.
#[cfg(windows)]
#[path = "receive/windows.rs"]
mod backend;
#[cfg(not(windows))]
#[path = "receive/unavailable.rs"]
mod backend;
pub use backend::*;
