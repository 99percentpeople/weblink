//! Shared preview IPC; pixel transport and resource ownership belong to the backend.
use tauri::{ipc::Channel, State, Webview};
use weblink_desktop_capture::media::preview::{PreviewEvent, PreviewFrame};
#[cfg(windows)]
#[path = "preview/windows.rs"]
mod backend;
#[cfg(not(windows))]
#[path = "preview/unavailable.rs"]
mod backend;
pub use backend::{clear, update_visibility};

#[tauri::command]
pub async fn capture_preview_open(
    webview: Webview,
    service: State<'_, crate::capture::Service>,
    session_id: String,
    preview_id: String,
    events: Channel<PreviewEvent>,
    visible: bool,
) -> Result<(), String> {
    if preview_id.len() > 128 || preview_id.is_empty() {
        return Err("Invalid preview id".into());
    }
    let media = crate::capture::run(service, move |s| s.media(session_id)).await?;
    backend::open(webview, media, preview_id, events, visible).await
}
#[tauri::command]
pub async fn capture_preview_visible(
    webview: Webview,
    preview_id: String,
    visible: bool,
) -> Result<(), String> {
    backend::set_visible(webview, preview_id, visible).await
}
#[tauri::command]
pub async fn capture_preview_frame(
    webview: Webview,
    preview_id: String,
    after: u64,
) -> Result<Option<PreviewFrame>, String> {
    backend::frame(webview, preview_id, after).await
}
#[tauri::command]
pub async fn capture_preview_close(webview: Webview, preview_id: String) -> Result<(), String> {
    backend::close(webview, preview_id).await
}
