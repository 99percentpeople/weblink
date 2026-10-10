//! Native clipboard IPC; remote access additionally requires a live control grant.
use crate::staged_files::{file_limit, file_name};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

const LIMIT: usize = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
mod changes;
struct StagedFiles {
    _directory: tempfile::TempDir,
    bytes: usize,
    created: Instant,
    sequence: u32,
}
static FILES: Mutex<Vec<StagedFiles>> = Mutex::new(Vec::new());
pub fn shutdown() {
    stop_watches();
    FILES.lock().unwrap_or_else(|e| e.into_inner()).clear();
}
static WATCH: Mutex<Option<(String, Option<native::Watcher>)>> = Mutex::new(None);
pub(super) static WRITING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
pub(super) static LAST_WRITE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
pub fn stop_watches() {
    WATCH.lock().unwrap_or_else(|e| e.into_inner()).take();
}
#[tauri::command]
pub async fn clipboard_watch(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, crate::remote_control::Shared>,
    scope: Scope,
    watch_id: String,
    events: tauri::ipc::Channel<()>,
) -> Result<(), String> {
    local(&window)?;
    uuid::Uuid::parse_str(&watch_id).map_err(|_| "Invalid clipboard watcher")?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scope = Some(scope);
        access(&service, &scope, || Ok(()))?;
        let previous = WATCH
            .lock()
            .map_err(|e| e.to_string())?
            .replace((watch_id.clone(), None));
        drop(previous);
        let watcher = native::watch(Box::new(move || {
            let _ = access(&service, &scope, || {
                events.send(()).map_err(|e| e.to_string())
            });
        }))?;
        let mut slot = WATCH.lock().map_err(|e| e.to_string())?;
        if let Some((id, active)) = slot.as_mut() {
            if *id == watch_id {
                *active = Some(watcher);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn clipboard_unwatch(
    window: tauri::WebviewWindow,
    watch_id: String,
) -> Result<(), String> {
    local(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut watch = WATCH.lock().unwrap_or_else(|e| e.into_inner());
        if watch.as_ref().is_some_and(|(id, _)| *id == watch_id) {
            watch.take();
        }
    })
    .await
    .map_err(|e| e.to_string())
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    owner_id: String,
    client_id: String,
    grant_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    #[serde(rename = "type")]
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<String>,
    data: String,
}
impl Entry {
    fn bytes(kind: &str, bytes: &[u8]) -> Self {
        Self {
            kind: kind.into(),
            name: None,
            path: None,
            group: None,
            data: STANDARD.encode(bytes),
        }
    }
}
#[derive(Serialize)]
pub struct Snapshot {
    sequence: u32,
    entries: Vec<Entry>,
}
fn access<T>(
    service: &crate::remote_control::Shared,
    scope: &Option<Scope>,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    match scope {
        Some(s) => service.with_clipboard(&s.owner_id, &s.client_id, &s.grant_id, action),
        None => action(),
    }
}
fn local(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Main window required".into())
    }
}
#[tauri::command]
pub async fn clipboard_sequence(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, crate::remote_control::Shared>,
    scope: Option<Scope>,
) -> Result<u32, String> {
    local(&window)?;
    access(service.inner(), &scope, || Ok(native::sequence()))
}
#[tauri::command]
pub async fn clipboard_read(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, crate::remote_control::Shared>,
    scope: Option<Scope>,
    after: Option<u32>,
    files: Option<bool>,
    max_file_bytes: Option<usize>,
) -> Result<Snapshot, String> {
    local(&window)?;
    let max_file_bytes = file_limit(max_file_bytes)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        access(&service, &scope, || Ok(()))?;
        if let Some(after) = after {
            let changed = native::wait_after(after, Duration::from_millis(1800));
            // Waiting holds no control lock and never extends authorization.
            access(&service, &scope, || Ok(()))?;
            changed?;
        }
        // Delayed clipboard rendering belongs to another application and may block.
        // Never hold the control actor lock while asking it for data; revalidate before delivery.
        access(&service, &scope, || Ok(()))?;
        let (mut snapshot, paths) = native::read()?;
        access(&service, &scope, || Ok(()))?;
        let mut size = 0;
        for (index, path) in paths.iter().filter(|_| files != Some(false)).enumerate() {
            let p = Path::new(path);
            let name = p
                .file_name()
                .ok_or("Invalid clipboard filename")?
                .to_string_lossy()
                .into_owned();
            collect(
                p,
                &name,
                &index.to_string(),
                &mut snapshot.entries,
                &mut size,
                0,
                max_file_bytes,
            )?;
        }
        access(&service, &scope, || {
            if native::sequence() != snapshot.sequence {
                return Err("Clipboard changed during copy; try again".into());
            }
            if snapshot.entries.is_empty() && !(files == Some(false) && !paths.is_empty()) {
                return Err("No supported clipboard content".into());
            }
            Ok(snapshot)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
fn collect(
    path: &Path,
    relative: &str,
    group: &str,
    entries: &mut Vec<Entry>,
    size: &mut usize,
    depth: usize,
    limit: usize,
) -> Result<(), String> {
    if entries.len() >= MAX_ENTRIES || depth > 64 {
        return Err("Too many clipboard files".into());
    }
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Clipboard folders containing links are unsupported".into());
        }
    }
    if meta.is_symlink() {
        return Err("Clipboard links are unsupported".into());
    }
    if meta.is_dir() {
        entries.push(Entry {
            kind: "directory".into(),
            name: None,
            path: Some(relative.into()),
            group: Some(group.into()),
            data: String::new(),
        });
        for child in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            let child = child.map_err(|e| e.to_string())?;
            collect(
                &child.path(),
                &format!("{relative}/{}", child.file_name().to_string_lossy()),
                group,
                entries,
                size,
                depth + 1,
                limit,
            )?;
        }
    } else if meta.is_file() {
        if meta.len() > limit.saturating_sub(*size) as u64 {
            return Err(format!(
                "Files exceed the {} MiB limit",
                limit as f64 / 1024.0 / 1024.0
            ));
        }
        // Bound reads even when the file grows after metadata was sampled.
        use std::io::Read;
        let mut data = Vec::new();
        std::fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take((limit - *size + 1) as u64)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        *size += data.len();
        if *size > limit {
            return Err(format!(
                "Files exceed the {} MiB limit",
                limit as f64 / 1024.0 / 1024.0
            ));
        }
        let mut entry = Entry::bytes("file", &data);
        entry.name = Some(path.file_name().unwrap().to_string_lossy().into_owned());
        entry.path = Some(relative.into());
        entry.group = Some(group.into());
        entries.push(entry);
    } else {
        return Err("Unsupported clipboard file".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn clipboard_write(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, crate::remote_control::Shared>,
    scope: Option<Scope>,
    entries: Vec<Entry>,
    max_file_bytes: Option<usize>,
) -> Result<u32, String> {
    local(&window)?;
    let max_file_bytes = file_limit(max_file_bytes)?;
    let service = service.inner().clone();
    #[cfg(windows)]
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    #[cfg(not(windows))]
    let hwnd = 0usize;
    tauri::async_runtime::spawn_blocking(move || {
        access(&service, &scope, || Ok(()))?;
        if entries.is_empty() || entries.len() > MAX_ENTRIES {
            return Err("Invalid clipboard contents".into());
        }
        let mut file_bytes = 0usize;
        let mut other_bytes = 0usize;
        let mut formats = Vec::new();
        let mut paths = Vec::new();
        let mut directory = None;
        let mut seen = std::collections::HashSet::new();
        for entry in entries {
            let (used, limit) = if entry.kind == "file" {
                (&mut file_bytes, max_file_bytes)
            } else {
                (&mut other_bytes, LIMIT)
            };
            if entry.data.len() > (limit - *used) * 4 / 3 + 4 {
                return Err(format!(
                    "Clipboard {} content exceeds the {} MiB limit",
                    entry.kind,
                    limit as f64 / 1024.0 / 1024.0
                ));
            }
            let data = STANDARD.decode(&entry.data).map_err(|e| e.to_string())?;
            *used += data.len();
            if *used > limit {
                return Err(format!(
                    "Clipboard {} content exceeds the {} MiB limit",
                    entry.kind,
                    limit as f64 / 1024.0 / 1024.0
                ));
            }
            if entry.kind == "file" {
                let name = entry.name.as_deref().ok_or("Missing clipboard filename")?;
                file_name(name)?;
                if !seen.insert(format!("file:{}", name.to_lowercase())) {
                    return Err("Duplicate clipboard filename".into());
                }
                let dir = match &directory {
                    Some(d) => d,
                    None => directory.insert(tempfile::tempdir().map_err(|e| e.to_string())?),
                };
                let path = dir.path().join(name);
                std::fs::write(&path, data).map_err(|e| e.to_string())?;
                paths.push(path.to_string_lossy().into_owned());
            } else {
                if !seen.insert(entry.kind.clone()) {
                    return Err("Duplicate clipboard format".into());
                }
                formats.extend(native::encode(&entry.kind, data)?);
            }
        }
        if !paths.is_empty() {
            formats.push(native::files(&paths)?);
        }
        // Current clipboard paths stay alive. Replaced snapshots get a grace period for shell copies.
        let mut retained = FILES.lock().map_err(|e| e.to_string())?;
        let sequence = native::sequence();
        retained.retain(|entry| {
            entry.sequence == sequence || entry.created.elapsed() < Duration::from_secs(30 * 60)
        });
        if directory.is_some()
            && (retained.len() >= 128
                || retained.iter().map(|e| e.bytes).sum::<usize>() + file_bytes > 512 * 1024 * 1024)
        {
            return Err(
                "Clipboard file staging is full; restart the application to clear it".into(),
            );
        }
        let result = access(&service, &scope, || native::write(hwnd, formats))?;
        if let Some(dir) = directory {
            retained.push(StagedFiles {
                _directory: dir,
                bytes: file_bytes,
                created: Instant::now(),
                sequence: result,
            });
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
#[path = "clipboard/windows.rs"]
mod native;
#[cfg(not(windows))]
mod native {
    use super::*;
    pub struct Watcher;
    pub fn watch(_: Box<dyn Fn() + Send>) -> Result<Watcher, String> {
        Err("Clipboard unavailable".into())
    }
    pub fn sequence() -> u32 {
        0
    }
    pub fn wait_after(_: u32, _: Duration) -> Result<(), String> {
        Err("Clipboard unavailable".into())
    }
    pub fn read() -> Result<(Snapshot, Vec<String>), String> {
        Err("Clipboard unavailable".into())
    }
    pub fn encode(_: &str, _: Vec<u8>) -> Result<Vec<(u32, Vec<u8>)>, String> {
        Err("Clipboard unavailable".into())
    }
    pub fn files(_: &[String]) -> Result<(u32, Vec<u8>), String> {
        Err("Clipboard unavailable".into())
    }
    pub fn write(_: usize, _: Vec<(u32, Vec<u8>)>) -> Result<u32, String> {
        Err("Clipboard unavailable".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_native_file_reads_before_loading_and_counts_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), [1, 2, 3]).unwrap();
        std::fs::write(dir.path().join("b"), [4, 5]).unwrap();
        let mut entries = Vec::new();
        let mut size = 0;
        collect(dir.path(), "folder", "0", &mut entries, &mut size, 0, 5).unwrap();
        assert_eq!(size, 5);
        assert_eq!(entries.len(), 3);
        assert!(collect(dir.path(), "folder", "0", &mut Vec::new(), &mut 0, 0, 4).is_err());
        let path = dir.path().join("large");
        std::fs::File::create(&path)
            .unwrap()
            .set_len((crate::staged_files::DEFAULT_LIMIT + 1) as u64)
            .unwrap();
        assert!(collect(
            &path,
            "large",
            "1",
            &mut Vec::new(),
            &mut 0,
            0,
            crate::staged_files::DEFAULT_LIMIT
        )
        .is_err());
    }
    #[test]
    fn rejects_paths_and_windows_devices() {
        for name in ["../a", "a\\b", "C:a", "NUL.txt", "COM1", "a.", "a ", ""] {
            assert!(file_name(name).is_err(), "{name}");
        }
        assert!(file_name("文件.zip").is_ok());
    }
}
