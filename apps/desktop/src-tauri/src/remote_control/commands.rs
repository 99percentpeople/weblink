use super::*;
use tauri::State;

#[tauri::command]
pub async fn remote_control_open(
    service: State<'_, Shared>,
    shortcut: Option<weblink_desktop_input::shortcut::Shortcut>,
) -> Result<String, String> {
    let s = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.open_with_shortcut(shortcut))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn remote_control_configure_shortcut(
    window: tauri::WebviewWindow,
    service: State<'_, Shared>,
    keyboard: State<'_, crate::keyboard::Shared>,
    shortcut: weblink_desktop_input::shortcut::Shortcut,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Local main window required".into());
    }
    let service = service.inner().clone();
    let keyboard = keyboard.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.configure_shortcut(shortcut)?;
        // Drop any capture policy that reserved the old emergency chord.
        keyboard.close();
        Ok(())
    })
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
pub async fn remote_control_watch(
    service: State<'_, Shared>,
    owner_id: String,
    watch_id: String,
    events: tauri::ipc::Channel<Snapshot>,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&watch_id).map_err(|_| "Invalid control watcher")?;
    let s = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        s.watch(&owner_id, watch_id, move |status| {
            events.send(status).is_ok()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn remote_control_unwatch(
    service: State<'_, Shared>,
    owner_id: String,
    watch_id: String,
) -> Result<(), String> {
    let s = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || s.unwatch(&owner_id, &watch_id))
        .await
        .map_err(|e| e.to_string())
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
