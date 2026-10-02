//! Attended remote-control input. Native ownership stays separate from UI and transport.
pub mod authorization;
pub mod engine;
pub mod input;
pub mod keyboard_capture;
#[cfg(any(target_os = "windows", test))]
mod mailbox;
pub mod pan;
pub mod protocol;
pub mod session;
pub mod touch;
pub mod trackpad;
#[cfg(target_os = "windows")]
pub mod windows;
pub mod wire;
