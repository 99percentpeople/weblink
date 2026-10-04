use std::sync::Arc;
use tauri::{ipc::Channel, Webview};
use weblink_desktop_capture::media::{preview::PreviewFrame, MediaSession};
pub async fn open(
    _: Webview,
    _: Arc<MediaSession>,
    _: String,
    _: Channel<bool>,
) -> Result<(), String> {
    Err("Native preview unavailable on this platform".into())
}
pub async fn frame(_: Webview, _: String, _: u64) -> Result<Option<PreviewFrame>, String> {
    Err("Native preview unavailable on this platform".into())
}
pub async fn close(_: Webview, _: String) -> Result<(), String> {
    Ok(())
}
pub fn clear(_: &tauri::WebviewWindow) {}
pub fn update_visibility(_: &tauri::WebviewWindow) {}
