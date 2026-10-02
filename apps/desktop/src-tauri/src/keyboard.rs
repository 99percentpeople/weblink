//! Local controller keyboard capture, separate from the remote host's input engine.
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{ipc::Channel, State};
#[cfg(windows)]
#[path = "keyboard/windows.rs"]
mod backend;
#[cfg(not(windows))]
#[path = "keyboard/unavailable.rs"]
mod backend;
pub use backend::{supported, Service};
pub type Shared = Arc<Service>;

#[derive(Clone, Copy, Deserialize)]
pub enum ExitShortcut {
    #[serde(rename = "ctrl-alt-shift-q")]
    Q,
    #[serde(rename = "ctrl-alt-shift-x")]
    X,
}
#[derive(Clone, Serialize)]
#[cfg_attr(not(windows), allow(dead_code))]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum KeyboardEvent {
    Key {
        #[serde(rename = "scanCode")]
        scan_code: u16,
        extended: bool,
        down: bool,
        sequence: u64,
        timestamp: u64,
    },
    Stopped {
        reason: &'static str,
    },
}

#[tauri::command]
pub async fn keyboard_start(
    window: tauri::WebviewWindow,
    service: State<'_, Shared>,
    session_id: String,
    exit_shortcut: ExitShortcut,
    events: Channel<KeyboardEvent>,
) -> Result<(), String> {
    if window.label() != "main" || !weblink_desktop_input::protocol::valid_id(&session_id) {
        return Err("Local main window and valid keyboard session required".into());
    }
    backend::start(
        window,
        service.inner().clone(),
        session_id,
        exit_shortcut,
        events,
    )
    .await
}
#[tauri::command]
pub fn keyboard_renew(
    window: tauri::WebviewWindow,
    service: State<'_, Shared>,
    session_id: String,
    sequence: u64,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Local main window required".into());
    }
    service.renew(&session_id, sequence)
}
#[tauri::command]
pub fn keyboard_stop(
    window: tauri::WebviewWindow,
    service: State<'_, Shared>,
    session_id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Local main window required".into());
    }
    service.stop(&session_id);
    Ok(())
}
