use tauri::{
    webview::{NewWindowResponse, PermissionKind, PermissionResponse},
    Manager, Url, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
mod application;
mod capabilities;
mod capture;
mod keyboard;
mod media_permissions;
mod notifications;
mod picture_in_picture;
mod preview;
mod remote_control;

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
        && left.username().is_empty()
        && left.password().is_none()
}

fn external_link(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
        && url.username().is_empty()
        && url.password().is_none()
}

fn media_permission(
    kind: PermissionKind,
    url: Option<&Url>,
    local_url: &Url,
    dev_url: Option<&Url>,
) -> PermissionResponse {
    if !matches!(kind, PermissionKind::Microphone | PermissionKind::Camera) {
        return PermissionResponse::Default;
    }
    if url.is_some_and(|url| {
        same_origin(url, local_url) || dev_url.is_some_and(|dev| same_origin(url, dev))
    }) {
        PermissionResponse::Allow
    } else {
        PermissionResponse::Deny
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(application::single_instance::init())
        .manage(notifications::Service::default())
        .manage(std::sync::Arc::new(
            weblink_desktop_capture::CaptureService::new()
                .expect("could not start capture service"),
        ))
        .manage(std::sync::Arc::new(remote_control::Service::default()))
        .manage(std::sync::Arc::new(keyboard::Service::default()))
        .manage(application::Service::default())
        .manage(picture_in_picture::Service::default())
        .plugin(tauri_plugin_autostart::Builder::new().args(["--autostart"]).build())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            capabilities::runtime_capabilities,
            notifications::notifications_capabilities,
            notifications::notifications_request_permission,
            notifications::notifications_watch,
            notifications::notifications_unwatch,
            notifications::notifications_show,
            notifications::notifications_dismiss,

            application::application_configure,
            application::application_show,
            application::visibility::application_visibility_watch,
            application::visibility::application_visibility_unwatch,
            application::device::application_device_name,
            application::autostart::application_autostart_status,
            application::autostart::application_autostart_set,
            application::autostart::application_startup_behavior,
            application::autostart::application_startup_set_behavior,
            picture_in_picture::pip_watch,
            picture_in_picture::pip_unwatch,
            picture_in_picture::pip_configure,
            picture_in_picture::pip_enter,
            picture_in_picture::pip_exit,
            picture_in_picture::pip_drag,
            application::close::application_close_watch,
            application::close::application_close_unwatch,
            application::close::application_close_respond,
            keyboard::keyboard_start,
            keyboard::keyboard_renew,
            keyboard::keyboard_stop,
            remote_control::remote_control_open,
            remote_control::remote_control_configure_shortcut,
            remote_control::remote_control_status,
            remote_control::remote_control_watch,
            remote_control::remote_control_unwatch,
            remote_control::remote_control_end,
            remote_control::remote_control_revoke,
            remote_control::remote_control_approve,
            capture::capture_sources,
            capture::capture_display_layout,
            capture::capture_thumbnail,
            capture::capture_codecs,
            capture::capture_audio_formats,
            capture::capture_backends,
            capture::capture_encoders,
            capture::capture_start,
            capture::capture_status,
            capture::capture_renew,
            capture::capture_watch,
            capture::capture_unwatch,
            capture::capture_stop,
            capture::capture_share_start,
            capture::capture_set_audio_enabled,
            capture::capture_update_video_settings,
            capture::capture_video_stats,
            capture::capture_pipeline_stats,
            preview::capture_preview_open,
            preview::capture_preview_frame,
            preview::capture_preview_visible,
            preview::capture_preview_close,
            capture::capture_offer,
            capture::capture_answer,
            capture::capture_add_ice_candidate,
            capture::capture_close_peer
        ])
        .setup(|app| {
            if let Err(error) = application::setup(app.handle()) {
                // Keep the application usable; without a tray no operation may hide it.
                eprintln!("could not create Weblink tray: {error}");
            }
            let dev_url = if cfg!(debug_assertions) {
                app.config().build.dev_url.clone()
            } else {
                None
            };
            let app_handle = app.handle().clone();
            let local_url = Url::parse(if cfg!(windows) {
                "https://tauri.localhost"
            } else {
                "tauri://localhost"
            })?;
            let media_local_url = local_url.clone();
            let media_dev_url = dev_url.clone();
            let mut media_origins = vec![local_url.clone()];
            if let Some(dev) = &dev_url {
                media_origins.push(dev.clone());
            }
            let startup = application::autostart::application_startup_behavior(app.handle().clone())
                .unwrap_or(application::autostart::StartupBehavior::Window);
            let hidden = application::autostart::starts_hidden(
                std::env::args().any(|arg| arg == "--autostart"),
                startup,
                app.state::<application::Service>().ready(),
            );
            let builder = WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .visible(!hidden).focused(!hidden);
            // Native media/signaling keep their renderer-owned leases in tray mode.
            // The Tauri background_throttling option does not support Windows.
            #[cfg(windows)]
            let builder = builder.additional_browser_args("--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows");
            #[cfg(target_os = "macos")]
            let builder = builder.background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
            let window = builder
                .on_permission_request(move |webview, kind| {
                    media_permission(
                        kind,
                        webview.url().ok().as_ref(),
                        &media_local_url,
                        media_dev_url.as_ref(),
                    )
                })
                .on_page_load(|webview, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                        preview::clear(&webview);
                        webview.state::<capture::Service>().clear_watches();
                        webview.state::<notifications::Service>().clear();
                        if let Some(window) = webview.app_handle().get_webview_window("main") {
                            webview.state::<picture_in_picture::Service>().reset(&window);
                        }
                        webview.state::<application::Service>().clear_page();
                        webview.state::<keyboard::Shared>().close();
                        webview.state::<remote_control::Shared>().close();
                    }
                })
                .on_navigation(move |url| {
                    same_origin(url, &local_url)
                        || dev_url.as_ref().is_some_and(|dev| same_origin(url, dev))
                })
                .on_new_window(move |url, _| {
                    if external_link(&url) {
                        let _ = app_handle.opener().open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            media_permissions::configure(&window, &media_origins)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build Weblink desktop")
        .run(|app, event| {
            if let tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } = &event {
                if label == "main" && app.state::<application::Service>().handle_close(app) {
                    api.prevent_close();
                }
            }
            if matches!(&event, tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Destroyed, .. } if label == "main") {
                app.state::<keyboard::Shared>().close();
            }
            if matches!(&event, tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } if label == "main") {
                app.state::<picture_in_picture::Service>().shutdown();
                app.state::<application::Service>().shutdown();
                app.state::<notifications::Service>().clear();
                app.state::<remote_control::Shared>().close();
            }
            if let tauri::RunEvent::WindowEvent { label, event, .. } = &event {
                if label == "main" {
                    if let Some(window) = app.get_webview_window("main") {
                        app.state::<picture_in_picture::Service>().window_event(&window, event);
                        if matches!(event, tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_)) {
                            application::visibility::update(&window);
                        }
                    }
                }
            }
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<application::Service>().shutdown();
                app.state::<notifications::Service>().clear();
                app.state::<keyboard::Shared>().close();
                app.state::<remote_control::Shared>().close();
                app.state::<capture::Service>().shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_capture_is_allowed_only_for_local_application_content() {
        let local = Url::parse("https://tauri.localhost").unwrap();
        let dev = Url::parse("http://127.0.0.1:1420").unwrap();
        for kind in [PermissionKind::Camera, PermissionKind::Microphone] {
            for url in [&local, &dev] {
                assert_eq!(
                    media_permission(kind, Some(url), &local, Some(&dev)),
                    PermissionResponse::Allow
                );
            }
            for url in [
                "https://webl.ink",
                "https://tauri.localhost.evil.test",
                "http://tauri.localhost",
                "https://tauri.localhost:1420",
                "https://user@tauri.localhost",
                "http://127.0.0.1:1421",
            ] {
                assert_eq!(
                    media_permission(kind, Some(&Url::parse(url).unwrap()), &local, Some(&dev)),
                    PermissionResponse::Deny
                );
            }
            assert_eq!(
                media_permission(kind, None, &local, Some(&dev)),
                PermissionResponse::Deny
            );
            assert_eq!(
                media_permission(kind, Some(&dev), &local, None),
                PermissionResponse::Deny
            );
        }
    }

    #[test]
    fn media_policy_does_not_grant_unrelated_permissions() {
        let local = Url::parse("https://tauri.localhost").unwrap();
        for kind in [
            PermissionKind::DisplayCapture,
            PermissionKind::ClipboardRead,
            PermissionKind::Notifications,
            PermissionKind::Geolocation,
            PermissionKind::Other,
        ] {
            assert_eq!(
                media_permission(kind, Some(&local), &local, None),
                PermissionResponse::Default
            );
        }
    }

    #[test]
    fn navigation_does_not_trust_similar_hosts_or_other_ports() {
        let origin = Url::parse("http://127.0.0.1:1420").unwrap();
        assert!(same_origin(
            &Url::parse("http://127.0.0.1:1420/?id=room").unwrap(),
            &origin
        ));
        for url in [
            "http://127.0.0.1:1421",
            "https://127.0.0.1:1420",
            "http://127.0.0.1.evil.test:1420",
            "http://user@127.0.0.1:1420",
        ] {
            assert!(!same_origin(&Url::parse(url).unwrap(), &origin));
        }
    }

    #[test]
    fn external_links_cannot_launch_local_files_or_custom_protocols() {
        for url in [
            "https://webl.ink",
            "http://localhost:5173",
            "mailto:hello@example.com",
        ] {
            assert!(external_link(&Url::parse(url).unwrap()));
        }
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "https://user:secret@example.com",
        ] {
            assert!(!external_link(&Url::parse(url).unwrap()));
        }
    }
}
