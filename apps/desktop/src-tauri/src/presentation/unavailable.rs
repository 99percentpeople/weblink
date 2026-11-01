use serde_json::Value;
use tauri::{ipc::Channel, State, Webview};
#[derive(Default)]
pub struct Service;
impl Service {
    pub fn clear(&self, _owner: Option<&str>) {}
}
#[tauri::command]
pub async fn presentation_open(
    _webview: Webview,
    _service: State<'_, Service>,
    id: String,
    source_id: String,
    preview: bool,
    events: Channel<Value>,
) -> Result<(), String> {
    let _ = (id, source_id, preview, events);
    Err("Native composition is unavailable".into())
}
#[tauri::command]
pub fn presentation_layout(id: String, layout: Value) -> Result<(), String> {
    let _ = (id, layout);
    Err("Native composition is unavailable".into())
}
#[tauri::command]
pub fn presentation_stats(id: String) -> Result<Value, String> {
    let _ = id;
    Err("Native composition is unavailable".into())
}
#[tauri::command]
pub fn presentation_close(id: String) {
    let _ = id;
}
#[tauri::command]
pub fn presentation_frame(
    id: String,
    recording_id: String,
    after: u64,
) -> Result<tauri::ipc::Response, String> {
    let _ = (id, recording_id, after);
    Err("Native composition is unavailable".into())
}
#[tauri::command]
pub fn presentation_recording_open(id: String, recording_id: String) -> Result<(), String> {
    let _ = (id, recording_id);
    Err("Native composition is unavailable".into())
}
#[tauri::command]
pub fn presentation_recording_close(id: String, recording_id: String) {
    let _ = (id, recording_id);
}
