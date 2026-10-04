#[cfg(windows)]
mod windows;

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    #[cfg(windows)]
    return windows::init();

    #[cfg(not(windows))]
    tauri_plugin_single_instance::init(|app, args, _| {
        if !args.iter().any(|arg| arg == "--autostart") {
            super::show(app);
        }
    })
}
