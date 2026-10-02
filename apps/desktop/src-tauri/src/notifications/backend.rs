//! The Windows backend owns authorization, presentation and supported actions.
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;
#[cfg(not(windows))]
mod unavailable;
#[cfg(not(windows))]
pub use unavailable::*;
