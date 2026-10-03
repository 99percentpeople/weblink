//! Window visibility never owns room, capture or host-control lifetime.
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
pub mod autostart;
pub mod close;
mod control_window;

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehavior {
    #[default]
    Ask,
    Exit,
    Tray,
}

#[derive(Clone, Copy, Default, Deserialize)]
pub enum Locale {
    #[default]
    #[serde(rename = "en")]
    English,
    #[serde(rename = "zh-cn")]
    Chinese,
    #[serde(rename = "zh-tw")]
    TraditionalChinese,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    close_behavior: CloseBehavior,
    hide_on_remote_control: bool,
    locale: Locale,
}

impl Options {
    fn close_action(self, ready: bool) -> CloseBehavior {
        if !ready && self.close_behavior == CloseBehavior::Tray {
            CloseBehavior::Ask
        } else {
            self.close_behavior
        }
    }
    fn hide_on_grant(self, ready: bool) -> bool {
        ready && self.hide_on_remote_control
    }
}

struct TrayMenu {
    show: MenuItem<tauri::Wry>,
    revoke: MenuItem<tauri::Wry>,
    exit: MenuItem<tauri::Wry>,
}

#[derive(Default)]
pub struct Service {
    ready: AtomicBool,
    options: Mutex<Options>,
    menu: Mutex<Option<TrayMenu>>,
    close: Mutex<close::Requests>,
    control_window: Mutex<control_window::ControlWindow>,
    exiting: AtomicBool,
    visibility_sequence: AtomicU64,
}

impl Service {
    pub fn ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }
    pub fn allow_auto_presentation(&self) -> bool {
        !self.exiting.load(Ordering::Acquire)
            && !self
                .close
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pending()
    }
    fn options(&self) -> Options {
        *self.options.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn clear_close_requests(&self) {
        self.close.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
    /// True means the native close event must be prevented.
    pub fn handle_close(&self, app: &tauri::AppHandle) -> bool {
        if self
            .close
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending()
        {
            return true;
        }
        match self.options().close_action(self.ready()) {
            CloseBehavior::Exit => false,
            CloseBehavior::Tray if hide(app).is_ok() => true,
            _ => {
                let requested = self
                    .close
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .request(self.ready());
                // A taskbar close can target a minimized window. Make the prompt
                // reachable without changing its current PiP presentation.
                if requested {
                    self.manual_visibility();
                    if let Some(window) = app.get_webview_window("main") {
                        focus_window(&window);
                    }
                }
                requested
            }
        }
    }
    fn next_visibility_event(&self) -> u64 {
        self.visibility_sequence.fetch_add(1, Ordering::Relaxed) + 1
    }
    fn manual_visibility(&self) {
        let sequence = self.next_visibility_event();
        self.control_window
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .manual(sequence);
    }
    pub fn shutdown(&self) {
        self.exiting.store(true, Ordering::Release);
        self.manual_visibility();
    }
    fn control_event(
        &self,
        app: &tauri::AppHandle,
        sequence: u64,
        event: crate::remote_control::ControlEvent,
    ) {
        if self.exiting.load(Ordering::Acquire) {
            return;
        }
        match event {
            crate::remote_control::ControlEvent::Granted(grant) => {
                let revision = self
                    .control_window
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .granted(sequence, grant);
                let Some(revision) = revision else {
                    return;
                };
                let pending = self
                    .close
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .pending();
                if pending || !self.options().hide_on_grant(self.ready()) {
                    return;
                }
                let Some(window) = app.get_webview_window("main") else {
                    return;
                };
                // Do not take ownership of a window the user already hid/minimized.
                if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
                    return;
                }
                match hide_window(app) {
                    Ok(()) => self
                        .control_window
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .hidden(revision),
                    Err(error) => {
                        eprintln!("could not hide Weblink after control approval: {error}")
                    }
                }
            }
            crate::remote_control::ControlEvent::Ended => {
                let restore = self
                    .control_window
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .ended(sequence);
                if restore {
                    show_window(app);
                }
            }
        }
    }
}

pub fn show(app: &tauri::AppHandle) {
    app.state::<Service>().manual_visibility();
    show_window(app);
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        app.state::<crate::picture_in_picture::Service>()
            .restore(&window, false);
        focus_window(&window);
    }
}

fn focus_window(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

pub fn hide(app: &tauri::AppHandle) -> tauri::Result<()> {
    app.state::<Service>().manual_visibility();
    hide_window(app)
}

fn hide_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window("main")
        .ok_or(tauri::Error::WindowNotFound)?;
    window.hide()?;
    // Cancel PiP motion without moving/resizing the disappearing native window.
    app.state::<crate::picture_in_picture::Service>().suspend();
    // Captured controller keys require foreground focus; the native host stays alive.
    app.state::<crate::keyboard::Shared>().close();
    Ok(())
}

pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let observed_app = app.clone();
    app.state::<crate::remote_control::Shared>()
        .observe(std::sync::Arc::new(move |event| {
            let sequence = observed_app.state::<Service>().next_visibility_event();
            let current = observed_app.clone();
            // Native grant teardown also runs while the renderer is hidden. Never
            // wait for the UI thread while holding the host/worker locks.
            let _ = observed_app.run_on_main_thread(move || {
                current
                    .state::<Service>()
                    .control_event(&current, sequence, event);
            });
        }));
    let show_item = MenuItem::with_id(app, "show", "Show Weblink", true, None::<&str>)?;
    let revoke = MenuItem::with_id(
        app,
        "revoke",
        "Revoke control of this device",
        true,
        None::<&str>,
    )?;
    let exit = MenuItem::with_id(app, "exit", "Quit Weblink", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &revoke, &separator, &exit])?;
    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?
        .clone();
    TrayIconBuilder::with_id("weblink")
        .icon(icon)
        .tooltip("Weblink")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show(app),
            "revoke" => {
                app.state::<crate::remote_control::Shared>()
                    .emergency_revoke();
                show(app);
            }
            "exit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    let service = app.state::<Service>();
    *service.menu.lock().unwrap_or_else(|e| e.into_inner()) = Some(TrayMenu {
        show: show_item,
        revoke,
        exit,
    });
    service.ready.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn application_configure(
    service: tauri::State<'_, Service>,
    options: Options,
) -> Result<(), String> {
    let menu = service.menu.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(menu) = menu.as_ref() {
        let labels = match options.locale {
            Locale::English => [
                "Show Weblink",
                "Revoke control of this device",
                "Quit Weblink",
            ],
            Locale::Chinese => ["显示 Weblink", "撤销对此设备的控制", "退出 Weblink"],
            Locale::TraditionalChinese => ["顯示 Weblink", "撤銷對此裝置的控制", "結束 Weblink"],
        };
        for (item, label) in [&menu.show, &menu.revoke, &menu.exit]
            .into_iter()
            .zip(labels)
        {
            item.set_text(label).map_err(|e| e.to_string())?;
        }
    }
    *service.options.lock().unwrap_or_else(|e| e.into_inner()) = options;
    Ok(())
}

#[tauri::command]
pub fn application_show(app: tauri::AppHandle) {
    show(&app);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_ask_and_keep_approval_visible() {
        let options = Options::default();
        assert_eq!(options.close_action(true), CloseBehavior::Ask);
        assert_eq!(options.close_action(false), CloseBehavior::Ask);
        assert!(!options.hide_on_grant(true));
    }
    #[test]
    fn hiding_requires_both_user_choice_and_a_working_tray() {
        let options = Options {
            close_behavior: CloseBehavior::Tray,
            hide_on_remote_control: true,
            ..Default::default()
        };
        assert_eq!(options.close_action(false), CloseBehavior::Ask);
        assert!(!options.hide_on_grant(false));
        assert_eq!(options.close_action(true), CloseBehavior::Tray);
        assert!(options.hide_on_grant(true));
    }
    #[test]
    fn wire_options_reject_unknown_behaviors() {
        let value = serde_json::json!({"closeBehavior":"tray", "hideOnRemoteControl":true, "locale":"zh-cn"});
        assert!(serde_json::from_value::<Options>(value)
            .unwrap()
            .hide_on_grant(true));
        let value = serde_json::json!({"closeBehavior":"minimize", "hideOnRemoteControl":false, "locale":"en"});
        assert!(serde_json::from_value::<Options>(value).is_err());
    }
}
