//! Trusted local composition: capture identity + room lifetime + attended native input.
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use weblink_desktop_capture::media::control::Port;
#[cfg(any(windows, test))]
mod transport;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::Service;
#[cfg(not(windows))]
#[derive(Default)]
pub struct Service {}
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub owner_id: String,
    pub peer_generation: String,
    pub client_id: String,
    pub source_id: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub consent_id: String,
    pub client_id: String,
    pub source_id: String,
    pub peer_generation: String,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub pending: Option<Pending>,
    pub client_id: Option<String>,
    pub closed: bool,
}
#[cfg_attr(not(windows), allow(dead_code))]
pub enum ControlEvent {
    Granted(String),
    Ended,
}
pub type Observer = Arc<dyn Fn(ControlEvent) + Send + Sync>;
#[cfg(not(windows))]
impl Service {
    pub fn observe(&self, _: Observer) {}
    pub fn stop_capture(&self, _: &str) {}
    pub fn close(&self) {}
    pub fn emergency_revoke(&self) {}
    pub fn open(&self) -> Result<String, String> {
        Err("Remote input requires Windows".into())
    }
    pub fn status(&self, _: &str) -> Result<Snapshot, String> {
        Err("Remote input unavailable".into())
    }
    pub fn end(&self, _: &str) {}
    pub fn revoke(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    pub fn approve(&self, _: &str, _: &str, _: bool) -> Result<(), String> {
        Err("Remote input unavailable".into())
    }
    pub fn attach(
        &self,
        _: Arc<weblink_desktop_capture::CaptureService>,
        _: Context,
        _: String,
        _: String,
    ) -> Result<Arc<dyn Port>, String> {
        Err("Remote input unavailable".into())
    }
}
pub type Shared = Arc<Service>;
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
