use super::*;
use tauri::State;

#[tauri::command]
pub async fn remote_control_open(service: State<'_, Shared>) -> Result<String, String> {
    let s = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.open())
        .await
        .map_err(|e| e.to_string())?
}
/// Status observation; native window/room/media ownership controls the lifetime.
#[tauri::command]
pub async fn remote_control_status(
    service: State<'_, Shared>,
    owner_id: String,
) -> Result<Snapshot, String> {
    let s = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.status(&owner_id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn remote_control_end(
    service: State<'_, Shared>,
    owner_id: String,
) -> Result<(), String> {
    let s = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.end(&owner_id))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn remote_control_revoke(
    service: State<'_, Shared>,
    owner_id: String,
) -> Result<(), String> {
    let s = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.revoke(&owner_id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn remote_control_approve(
    window: tauri::WebviewWindow,
    service: State<'_, Shared>,
    owner_id: String,
    consent_id: String,
    approve: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Local main window required".into());
    }
    let s = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.approve(&owner_id, &consent_id, approve))
        .await
        .map_err(|e| e.to_string())??;
    Ok(())
}
