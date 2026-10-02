use super::{ExitShortcut, KeyboardEvent};
use std::sync::Arc;
use tauri::ipc::Channel;
#[derive(Default)]
pub struct Service;
impl Service {
    pub fn close(&self) {}
    pub fn stop(&self, _: &str) {}
    pub fn renew(&self, _: &str, _: u64) -> Result<(), String> {
        Err("System keyboard unavailable".into())
    }
}
pub fn supported() -> bool {
    false
}
pub async fn start(
    _: tauri::WebviewWindow,
    _: Arc<Service>,
    _: String,
    _: ExitShortcut,
    _: Channel<KeyboardEvent>,
) -> Result<(), String> {
    Err("System keyboard unavailable on this platform".into())
}
