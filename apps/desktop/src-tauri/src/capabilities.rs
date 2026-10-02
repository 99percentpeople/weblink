use crate::{application, capture, keyboard};
use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeCapabilities {
    runtime: &'static str,
    os: &'static str,
    version: String,
    native_screen_capture: bool,
    display_refresh_rates: Vec<u32>,
    remote_input: bool,
    system_keyboard: bool,
    system_tray: bool,
}

#[tauri::command]
pub(crate) async fn runtime_capabilities(
    app: tauri::AppHandle,
    service: tauri::State<'_, capture::Service>,
) -> Result<RuntimeCapabilities, String> {
    let (native_screen_capture, display_refresh_rates) =
        capture::run(service, |s| Ok((s.supported(), s.display_refresh_rates()))).await?;
    Ok(RuntimeCapabilities {
        runtime: "desktop",
        os: std::env::consts::OS,
        version: app.package_info().version.to_string(),
        native_screen_capture,
        display_refresh_rates,
        remote_input: weblink_desktop_input::session::supported(),
        system_keyboard: keyboard::supported(),
        system_tray: app.state::<application::Service>().ready(),
    })
}
