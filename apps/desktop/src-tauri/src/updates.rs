use serde::Serialize;
use std::{path::Path, time::Duration};
use tauri::{ipc::Channel, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

const RELEASES: &str = "https://github.com/99percentpeople/weblink/releases";
const ENDPOINT: &str =
    "https://github.com/99percentpeople/weblink/releases/latest/download/latest.json";

#[derive(Default)]
pub struct Service(Mutex<Option<Pending>>);

struct Pending {
    update: Update,
    can_install: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
    can_install: bool,
    download_kind: &'static str,
    download_url: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CheckResult {
    Current,
    Unavailable { reason: &'static str },
    Available { update: UpdateInfo },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
}

fn unavailable_reason(supported: bool, development: bool) -> Option<&'static str> {
    if development {
        Some("development")
    } else if !supported {
        Some("platform")
    } else {
        None
    }
}

// NSIS creates uninstall.exe beside the installed executable. Unknown/raw
// executables are treated as portable; the ZIP marker takes precedence even
// when extracted into a directory that previously held an installation.
fn is_installed(directory: &Path) -> bool {
    !directory.join("weblink-portable").exists() && directory.join("uninstall.exe").is_file()
}

fn public_key(app: &tauri::AppHandle) -> &str {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config.get("pubkey"))
        .and_then(|key| key.as_str())
        .unwrap_or("")
        .trim()
}

#[tauri::command]
pub async fn updates_check(app: tauri::AppHandle) -> Result<CheckResult, String> {
    let service = app.state::<Service>();
    let mut pending = service
        .0
        .try_lock()
        .map_err(|_| "Update operation already in progress")?;
    // Never retain a stale install candidate after a failed or superseding check.
    *pending = None;
    if let Some(reason) = unavailable_reason(
        cfg!(all(windows, target_arch = "x86_64")),
        cfg!(debug_assertions) || env!("WEBLINK_BUILD_CHANNEL") != "stable",
    ) {
        return Ok(CheckResult::Unavailable { reason });
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let installed = executable.parent().is_some_and(is_installed);
    let can_install = installed && !public_key(&app).is_empty();
    let exit_app = app.clone();
    let updater = app
        .updater_builder()
        .endpoints(vec![ENDPOINT.parse().expect("valid update endpoint")])
        .map_err(|error| error.to_string())?
        .timeout(Duration::from_secs(30))
        .on_before_exit(move || {
            // The Windows updater exits directly, without delivering RunEvent::Exit.
            crate::shutdown(&exit_app);
            exit_app.cleanup_before_exit();
        })
        .build()
        .map_err(|error| error.to_string())?;
    let Some(mut update) = updater.check().await.map_err(|error| error.to_string())? else {
        return Ok(CheckResult::Current);
    };
    // Installer downloads need a longer deadline than the small manifest request.
    update.timeout = Some(Duration::from_secs(20 * 60));
    let asset = if installed {
        "setup.exe"
    } else {
        "portable.zip"
    };
    let info = UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
        can_install,
        download_kind: if installed { "installer" } else { "portable" },
        download_url: format!(
            "{RELEASES}/download/v{}/Weblink-windows-x64-{asset}",
            update.version
        ),
    };
    *pending = Some(Pending {
        update,
        can_install,
    });
    Ok(CheckResult::Available { update: info })
}

fn validate_install(candidate: Option<(&str, bool)>, version: &str) -> Result<(), String> {
    match candidate {
        Some((checked, true)) if checked == version => Ok(()),
        _ => Err("Check for a signed installer update before installing".into()),
    }
}

#[tauri::command]
pub async fn updates_install(
    app: tauri::AppHandle,
    version: String,
    channel: Channel<Progress>,
) -> Result<(), String> {
    let service = app.state::<Service>();
    let pending = service
        .0
        .try_lock()
        .map_err(|_| "Update operation already in progress")?;
    validate_install(
        pending
            .as_ref()
            .map(|candidate| (candidate.update.version.as_str(), candidate.can_install)),
        &version,
    )?;
    let candidate = pending.as_ref().expect("validated update");
    let mut downloaded = 0;
    // Download verifies the signature before returning bytes or entering install.
    let bytes = candidate
        .update
        .download(
            |length, total| {
                downloaded += length as u64;
                let _ = channel.send(Progress {
                    phase: "downloading",
                    downloaded,
                    total,
                });
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    let _ = channel.send(Progress {
        phase: "installing",
        downloaded: bytes.len() as u64,
        total: Some(bytes.len() as u64),
    });
    candidate
        .update
        .install(bytes)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_and_marked_executables_never_use_the_installer() {
        let directory = tempfile::tempdir().unwrap();
        assert!(!is_installed(directory.path()));
        std::fs::write(directory.path().join("uninstall.exe"), []).unwrap();
        assert!(is_installed(directory.path()));
        std::fs::write(directory.path().join("weblink-portable"), []).unwrap();
        assert!(!is_installed(directory.path()));
    }

    #[test]
    fn only_stable_supported_builds_check_the_feed() {
        assert_eq!(unavailable_reason(true, false), None);
        assert_eq!(unavailable_reason(true, true), Some("development"));
        assert_eq!(unavailable_reason(false, false), Some("platform"));
    }

    #[test]
    fn installation_requires_the_checked_version_and_installer_permission() {
        assert!(validate_install(None, "1.2.0").is_err());
        assert!(validate_install(Some(("1.2.0", false)), "1.2.0").is_err());
        assert!(validate_install(Some(("1.2.0", true)), "1.3.0").is_err());
        assert!(validate_install(Some(("1.2.0", true)), "1.2.0").is_ok());
    }

    #[test]
    fn an_install_excludes_checks_and_other_installs() {
        let service = Service::default();
        let guard = service.0.try_lock().unwrap();
        assert!(service.0.try_lock().is_err());
        drop(guard);
        assert!(service.0.try_lock().is_ok());
    }
}
