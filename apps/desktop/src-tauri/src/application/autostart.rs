use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;

#[cfg(windows)]
mod windows;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    enabled: bool,
    path_mismatch: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum StartupBehavior {
    #[default]
    Tray,
    Window,
}

pub fn starts_hidden(autostart: bool, behavior: StartupBehavior, tray: bool) -> bool {
    autostart && tray && behavior == StartupBehavior::Tray
}

#[tauri::command]
pub fn application_startup_behavior(app: tauri::AppHandle) -> Result<StartupBehavior, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("startup.json");
    match std::fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(StartupBehavior::default()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn application_startup_set_behavior(
    app: tauri::AppHandle,
    behavior: StartupBehavior,
) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join("startup.json"),
        serde_json::to_vec(&behavior).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn application_autostart_status(app: tauri::AppHandle) -> Result<AutostartStatus, String> {
    #[cfg(windows)]
    let path_mismatch = windows::path_mismatch(&app.package_info().name)?;
    #[cfg(not(windows))]
    let path_mismatch = false;
    Ok(AutostartStatus {
        enabled: app.autolaunch().is_enabled().map_err(|e| e.to_string())?,
        path_mismatch,
    })
}

#[tauri::command]
pub fn application_autostart_set(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<AutostartStatus, String> {
    let launch = app.autolaunch();
    if enabled {
        #[cfg(windows)]
        windows::enable(&app.package_info().name)?;
        #[cfg(not(windows))]
        launch.enable().map_err(|e| e.to_string())?;
    } else {
        // Also remove entries disabled through Task Manager.
        launch.disable().map_err(|e| e.to_string())?;
    }
    application_autostart_status(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_login_startup_with_a_working_tray_can_start_hidden() {
        assert!(starts_hidden(true, StartupBehavior::default(), true));
        assert!(!starts_hidden(false, StartupBehavior::Tray, true));
        assert!(!starts_hidden(true, StartupBehavior::Tray, false));
        assert!(!starts_hidden(true, StartupBehavior::Window, true));
        assert!(serde_json::from_str::<StartupBehavior>("\"unknown\"").is_err());
    }
}
