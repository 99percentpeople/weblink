use serde_json::Value;
use std::sync::Arc;
#[derive(Default)]
pub struct Service;
pub type Shared = Arc<Service>;
impl Service {
    pub fn clear(&self, _: Option<&str>) {}
}
pub fn clear_buffers(_: &tauri::WebviewWindow) {}
pub fn release_notification(invoke: &tauri::ipc::Invoke<tauri::Wry>) -> bool {
    invoke.message.command() == "receive_release"
}
#[tauri::command]
pub fn receive_codecs() -> Vec<String> {
    Vec::new()
}
macro_rules! unavailable {
    ($($name:ident),*) => {$(
        #[tauri::command]
        pub fn $name() -> Result<Value,String> {Err("Native receiving is unavailable".into())}
    )*};
}
unavailable!(
    receive_open,
    receive_answer,
    receive_candidate,
    receive_stats,
    receive_renew,
    receive_send,
    receive_audio,
    receive_visible,
    receive_close
);
