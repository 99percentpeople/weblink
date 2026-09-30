use serde::Serialize;
use tauri::{webview::NewWindowResponse, Manager, Url, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
mod capture;
mod preview;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCapabilities {
    runtime: &'static str,
    os: &'static str,
    version: String,
    native_screen_capture: bool,
    display_refresh_rates: Vec<u32>,
    remote_input: bool,
}

#[tauri::command]
async fn runtime_capabilities(
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
        remote_input: false,
    })
}

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

pub fn run() {
    tauri::Builder::default()
        .manage(std::sync::Arc::new(
            weblink_desktop_capture::CaptureService::new()
                .expect("could not start capture service"),
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            runtime_capabilities,
            capture::capture_sources,
            capture::capture_thumbnail,
            capture::capture_codecs,
            capture::capture_backends,
            capture::capture_encoders,
            capture::capture_start,
            capture::capture_status,
            capture::capture_stop,
            capture::capture_share_start,
            capture::capture_set_audio_enabled,
            capture::capture_update_video_settings,
            capture::capture_video_stats,
            capture::capture_pipeline_stats,
            preview::capture_preview_open,
            preview::capture_preview_frame,
            preview::capture_preview_close,
            capture::capture_offer,
            capture::capture_answer,
            capture::capture_add_ice_candidate,
            capture::capture_close_peer
        ])
        .setup(|app| {
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
            WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_page_load(|webview, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                        preview::clear(&webview);
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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not build Weblink desktop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<capture::Service>().shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

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
