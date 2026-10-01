use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub fn application_autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn application_autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let launch = app.autolaunch();
    if launch.is_enabled().map_err(|e| e.to_string())? != enabled {
        if enabled {
            launch.enable()
        } else {
            launch.disable()
        }
        .map_err(|e| e.to_string())?;
    }
    launch.is_enabled().map_err(|e| e.to_string())
}
