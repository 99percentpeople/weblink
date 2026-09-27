use std::sync::Arc;
use tauri::State;
use weblink_desktop_capture::{CaptureService, CaptureSource, CaptureStatus};

pub type Service = Arc<CaptureService>;

pub async fn run<T: Send + 'static>(
    service: State<'_, Service>,
    operation: impl FnOnce(&CaptureService) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || operation(&service))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn capture_sources(service: State<'_, Service>) -> Result<Vec<CaptureSource>, String> {
    run(service, CaptureService::sources).await
}

#[tauri::command]
pub async fn capture_start(
    service: State<'_, Service>,
    source_id: String,
) -> Result<CaptureStatus, String> {
    run(service, move |s| s.start(source_id)).await
}

#[tauri::command]
pub async fn capture_status(
    service: State<'_, Service>,
    session_id: String,
) -> Result<CaptureStatus, String> {
    run(service, move |s| s.status(session_id)).await
}

#[tauri::command]
pub async fn capture_stop(
    service: State<'_, Service>,
    session_id: String,
) -> Result<CaptureStatus, String> {
    run(service, move |s| s.stop(session_id)).await
}
