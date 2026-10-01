//! Local controller keyboard capture, separate from the remote host's input engine.
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{ipc::Channel, State};
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::Service;
#[cfg(not(windows))]
#[derive(Default)]
pub struct Service {}
#[cfg(not(windows))]
impl Service {
    pub fn close(&self) {}
}
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
    #[cfg(windows)]
    {
        use tauri::Manager;
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
        let host = window
            .state::<crate::remote_control::Shared>()
            .inner()
            .clone();
        let s = service.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            s.start(session_id, hwnd, exit_shortcut, events, move || {
                host.emergency_revoke()
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (service, session_id, exit_shortcut, events);
        Err("System keyboard forwarding requires Windows".into())
    }
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
    #[cfg(windows)]
    {
        service.renew(&session_id, sequence)
    }
    #[cfg(not(windows))]
    {
        let _ = (service, session_id, sequence);
        Err("System keyboard unavailable".into())
    }
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
    #[cfg(windows)]
    {
        service.stop(&session_id);
    }
    #[cfg(not(windows))]
    {
        let _ = (service, session_id);
    }
    Ok(())
}
