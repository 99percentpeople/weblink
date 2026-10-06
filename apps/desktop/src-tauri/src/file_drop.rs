//! A remote drop is prepared against a live grant and a fixed native window, then consumed once.
use crate::{
    remote_control::Shared,
    staged_files::{self, FileEntry, StagedFiles},
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use weblink_desktop_input::protocol::Target;

#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
mod windows {
    #[derive(Clone)]
    pub struct Destination;
    impl Destination {
        pub fn capture(_: (i32, i32)) -> Result<Self, String> {
            Err("Native file drop unavailable".into())
        }
        pub fn current(&self) -> bool {
            false
        }
    }
    pub fn perform(
        _: &Destination,
        _: &[String],
        _: Box<dyn Fn() -> bool + Send>,
    ) -> Result<(), String> {
        Err("Native file drop unavailable".into())
    }
}
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    owner_id: String,
    client_id: String,
    grant_id: String,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    x: f64,
    y: f64,
}
#[derive(Clone)]
struct Pending {
    scope: Scope,
    target: Target,
    position: Position,
    pixels: (i32, i32),
    destination: windows::Destination,
    created: Instant,
    cancelled: Arc<AtomicBool>,
    applying: bool,
    max_file_bytes: usize,
}
static PENDING: LazyLock<Mutex<HashMap<String, Pending>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static FILES: Mutex<Vec<(Instant, StagedFiles)>> = Mutex::new(Vec::new());
static DROPPING: Mutex<()> = Mutex::new(());
const LIFETIME: Duration = Duration::from_secs(120);
pub fn shutdown() {
    for (_, pending) in PENDING.lock().unwrap_or_else(|e| e.into_inner()).drain() {
        pending.cancelled.store(true, Ordering::Release);
    }
    FILES.lock().unwrap_or_else(|e| e.into_inner()).clear();
}
fn local(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Main window required".into())
    }
}
fn position(
    service: &Shared,
    scope: &Scope,
    target: &Target,
    point: &Position,
) -> Result<(i32, i32), String> {
    service.file_drop_position(
        &scope.owner_id,
        &scope.client_id,
        &scope.grant_id,
        target,
        point.x,
        point.y,
    )
}
fn current(service: &Shared, pending: &Pending) -> bool {
    !pending.cancelled.load(Ordering::Acquire)
        && pending.created.elapsed() < LIFETIME
        && position(service, &pending.scope, &pending.target, &pending.position).ok()
            == Some(pending.pixels)
        && pending.destination.current()
}
#[tauri::command]
pub async fn file_drop_prepare(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Shared>,
    scope: Scope,
    operation_id: String,
    target: Target,
    point: Position,
    max_file_bytes: Option<usize>,
) -> Result<(), String> {
    local(&window)?;
    let max_file_bytes = staged_files::file_limit(max_file_bytes)?;
    uuid::Uuid::parse_str(&operation_id).map_err(|_| "Invalid drop operation")?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let pixels = position(&service, &scope, &target, &point)?;
        let destination = windows::Destination::capture(pixels)?;
        let mut pending = PENDING.lock().map_err(|e| e.to_string())?;
        pending.retain(|_, p| p.applying || p.created.elapsed() < LIFETIME);
        if pending.contains_key(&operation_id) || pending.len() >= 16 {
            return Err("File drop is already pending".into());
        }
        pending.insert(
            operation_id,
            Pending {
                scope,
                target,
                position: point,
                pixels,
                destination,
                created: Instant::now(),
                cancelled: Arc::new(AtomicBool::new(false)),
                applying: false,
                max_file_bytes,
            },
        );
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn file_drop_cancel(
    window: tauri::WebviewWindow,
    scope: Scope,
    operation_id: String,
) -> Result<(), String> {
    local(&window)?;
    let mut pending = PENDING.lock().map_err(|e| e.to_string())?;
    if pending.get(&operation_id).is_some_and(|p| p.scope == scope) {
        if let Some(p) = pending.remove(&operation_id) {
            p.cancelled.store(true, Ordering::Release);
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn file_drop_apply(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Shared>,
    scope: Scope,
    operation_id: String,
    files: Vec<FileEntry>,
) -> Result<(), String> {
    local(&window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = {
            let mut pending = PENDING.lock().map_err(|e| e.to_string())?;
            let p = pending
                .get_mut(&operation_id)
                .filter(|p| p.scope == scope && !p.applying)
                .ok_or("Stale file drop")?;
            p.applying = true;
            p.clone()
        };
        let result = (|| {
            let _dropping = DROPPING
                .try_lock()
                .map_err(|_| "Another file drop is running")?;
            if !current(&service, &p) {
                return Err("File drop target changed or control ended".into());
            }
            let staged = staged_files::stage(files, p.max_file_bytes)?;
            // Retain accepted paths: targets may read them after IDropTarget::Drop returns.
            let mut retained = FILES.lock().map_err(|e| e.to_string())?;
            retained.retain(|(at, _)| at.elapsed() < Duration::from_secs(30 * 60));
            if retained.len() >= 128
                || retained.iter().map(|(_, f)| f.bytes).sum::<usize>() + staged.bytes
                    > 512 * 1024 * 1024
            {
                return Err("File drop staging is full".into());
            }
            let destination = p.destination.clone();
            let paths = staged.paths.clone();
            // Keep paths alive without holding a global mutex across another application's OLE callback.
            retained.push((Instant::now(), staged));
            drop(retained);
            // A blocking-pool thread may already be MTA; every drop gets its own STA.
            std::thread::Builder::new()
                .name("weblink-file-drop".into())
                .spawn(move || {
                    windows::perform(
                        &destination,
                        &paths,
                        Box::new(move || current(&service, &p)),
                    )
                })
                .map_err(|e| e.to_string())?
                .join()
                .map_err(|_| "File drop worker stopped".to_string())?
        })();
        PENDING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&operation_id);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
