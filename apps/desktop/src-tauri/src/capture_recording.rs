use crate::capture::{run, Service};
use tauri::State;

#[tauri::command]
pub async fn capture_recording_open(
    service: State<'_, Service>,
    session_id: String,
    recording_id: String,
    encoded_audio: Option<bool>,
) -> Result<Option<weblink_desktop_capture::media::RecordingInfo>, String> {
    uuid::Uuid::parse_str(&recording_id).map_err(|_| "Invalid recording identifier")?;
    run(service, move |s| {
        s.media(session_id)?
            .open_recording(recording_id, encoded_audio.unwrap_or(true))
    })
    .await
}
#[tauri::command]
pub async fn capture_recording_read(
    service: State<'_, Service>,
    session_id: String,
    recording_id: String,
) -> Result<tauri::ipc::Response, String> {
    run(service, move |s| {
        s.media(session_id)?.read_recording(&recording_id)
    })
    .await
    .map(tauri::ipc::Response::new)
}
#[tauri::command]
pub async fn capture_recording_control(
    service: State<'_, Service>,
    session_id: String,
    recording_id: String,
    active: bool,
    segment: u32,
) -> Result<(), String> {
    run(service, move |s| {
        s.media(session_id)?
            .control_recording(&recording_id, active, segment)
    })
    .await
}
#[tauri::command]
pub async fn capture_recording_close(
    service: State<'_, Service>,
    session_id: String,
    recording_id: String,
) -> Result<(), String> {
    run(service, move |s| {
        if let Ok(media) = s.media(session_id) {
            media.close_recording(&recording_id);
        }
        Ok(())
    })
    .await
}
