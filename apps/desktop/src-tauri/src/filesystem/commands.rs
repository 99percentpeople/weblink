use super::*;
use notify::Watcher;
use std::io::{Read, Seek, SeekFrom};
use tauri::{
    ipc::{Channel, InvokeBody, Request, Response},
    Manager,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
const MAX_IO: usize = 1024 * 1024;
const MAX_SIZE: u64 = 9_007_199_254_740_991;

#[tauri::command]
pub async fn vfs_volumes(app: tauri::AppHandle) -> Result<Vec<Volume>, String> {
    blocking(move || Ok(roots(&app)?.iter().map(Volume::from).collect())).await
}
#[tauri::command]
pub async fn vfs_pick_directory(window: tauri::WebviewWindow) -> Result<Option<Volume>, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .pick_folder(move |path| {
            let _ = send.send(path);
        });
    let Some(path) = receive.await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let app = window.app_handle().clone();
    blocking(move || add_root(&app, path).map(Some)).await
}
#[tauri::command]
pub async fn vfs_open_directory(app: tauri::AppHandle, mount_id: String) -> Result<(), String> {
    blocking(move || {
        let directory = scoped(&root(&app, &mount_id)?, "", false)?;
        if !directory.is_dir() {
            return Err("Directory is unavailable".into());
        }
        app.opener()
            .open_path(directory.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|error| error.to_string())
    })
    .await
}
#[tauri::command]
pub async fn vfs_open_file(app: tauri::AppHandle, id: String) -> Result<(), String> {
    blocking(move || {
        let media = app
            .state::<Service>()
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .media
            .get(&id)
            .cloned()
            .ok_or("Unknown file capability")?;
        let path = media.checked_path()?;
        app.opener()
            .open_path(path.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|error| error.to_string())
    })
    .await
}

fn reveal_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let path = scoped(root, path, false)?;
    if !path.is_file() {
        return Err("File is unavailable".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn vfs_reveal_file(
    app: tauri::AppHandle,
    mount_id: String,
    path: String,
) -> Result<(), String> {
    blocking(move || {
        let path = reveal_path(&root(&app, &mount_id)?, &path)?;
        app.opener()
            .reveal_item_in_dir(path)
            .map_err(|error| error.to_string())
    })
    .await
}
#[tauri::command]
pub async fn vfs_stat(
    app: tauri::AppHandle,
    mount_id: String,
    path: String,
) -> Result<Option<Stat>, String> {
    blocking(move || stat(&scoped(&root(&app, &mount_id)?, &path, false)?)).await
}
#[tauri::command]
pub async fn vfs_list(
    app: tauri::AppHandle,
    mount_id: String,
    path: String,
) -> Result<Vec<Entry>, String> {
    blocking(move || {
        let directory = scoped(&root(&app, &mount_id)?, &path, false)?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
                continue;
            }
            if let Some(stat) = stat(&entry.path())? {
                entries.push(Entry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    stat,
                });
            }
        }
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(entries)
    })
    .await
}
pub fn read_range(
    path: &Path,
    offset: u64,
    length: usize,
    revision: Option<&str>,
) -> Result<Vec<u8>, String> {
    if length > MAX_IO {
        return Err("Read exceeds buffer limit".into());
    }
    let before = stat(path)?.ok_or("File is unavailable")?;
    if before.kind != "file"
        || offset
            .checked_add(length as u64)
            .is_none_or(|end| end > before.size)
    {
        return Err("Invalid read range".into());
    }
    if revision.is_some_and(|revision| revision != before.revision) {
        return Err("File changed while reading".into());
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    if stat(path)?.is_none_or(|after| after.revision != before.revision) {
        return Err("File changed while reading".into());
    }
    Ok(bytes)
}
#[tauri::command]
pub async fn vfs_read(
    app: tauri::AppHandle,
    mount_id: String,
    path: String,
    offset: u64,
    length: usize,
    revision: Option<String>,
) -> Result<Response, String> {
    blocking(move || {
        read_range(
            &scoped(&root(&app, &mount_id)?, &path, false)?,
            offset,
            length,
            revision.as_deref(),
        )
        .map(Response::new)
    })
    .await
}
#[tauri::command]
pub async fn vfs_resize(
    app: tauri::AppHandle,
    mount_id: String,
    path: String,
    size: u64,
) -> Result<(), String> {
    blocking(move || {
        if path.is_empty() || size > MAX_SIZE {
            return Err("Invalid file size or path".into());
        }
        let path = scoped(&root(&app, &mount_id)?, &path, true)?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.set_len(size).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    })
    .await
}
pub fn write_range(path: &Path, offset: u64, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_IO {
        return Err("Write exceeds buffer limit".into());
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if offset
        .checked_add(bytes.len() as u64)
        .is_none_or(|end| end > size)
    {
        return Err("Write exceeds declared file size".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn vfs_write(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let header = |key| {
        request
            .headers()
            .get(key)
            .and_then(|value| value.to_str().ok())
            .map(String::from)
            .ok_or_else(|| format!("Missing {key}"))
    };
    let mount_id = header("x-vfs-mount")?;
    // JSON escaped as ASCII in the header, preserving non-ASCII filenames.
    let path: String = serde_json::from_str(&header("x-vfs-path")?).map_err(|e| e.to_string())?;
    let offset: u64 = header("x-vfs-offset")?
        .parse::<u64>()
        .map_err(|e| e.to_string())?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected binary file content".into());
    };
    if bytes.len() > MAX_IO {
        return Err("Write exceeds buffer limit".into());
    }
    let bytes = bytes.clone();
    blocking(move || {
        write_range(
            &scoped(&root(&app, &mount_id)?, &path, false)?,
            offset,
            &bytes,
        )
    })
    .await
}
#[tauri::command]
pub async fn vfs_sync(
    app: tauri::AppHandle,
    mount_id: String,
    path: String,
) -> Result<Stat, String> {
    blocking(move || {
        let path = scoped(&root(&app, &mount_id)?, &path, false)?;
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        stat(&path)?.ok_or_else(|| "File is unavailable".into())
    })
    .await
}
#[tauri::command]
pub async fn vfs_remove(
    app: tauri::AppHandle,
    mount_id: String,
    path: String,
) -> Result<(), String> {
    blocking(move || {
        if path.is_empty() {
            return Err("Cannot remove a mounted root".into());
        }
        let path = scoped(&root(&app, &mount_id)?, &path, false)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
}

fn move_file(
    root: &Path,
    source: &str,
    destination: &str,
    revision: &str,
) -> Result<Option<Stat>, String> {
    if source.is_empty() || destination.is_empty() || source == destination {
        return Err("Invalid move paths".into());
    }
    let source = scoped(root, source, false)?;
    let destination = scoped(root, destination, false)?;
    let before = stat(&source)?.ok_or("File is unavailable")?;
    if before.kind != "file" || before.revision != revision {
        return Err("File changed before moving".into());
    }
    if source.parent() != destination.parent() {
        return Err("Moves must stay in the same directory".into());
    }
    let mut temporary = tempfile::TempPath::try_from_path(source).map_err(|e| e.to_string())?;
    // Failed publication must never delete the resumable source on drop.
    temporary.disable_cleanup(true);
    match temporary.persist_noclobber(&destination) {
        Ok(()) => stat(&destination),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(None),
        Err(error) => Err(error.error.to_string()),
    }
}

#[tauri::command]
pub async fn vfs_move(
    app: tauri::AppHandle,
    mount_id: String,
    path: String,
    destination: String,
    revision: String,
) -> Result<Option<Stat>, String> {
    blocking(move || move_file(&root(&app, &mount_id)?, &path, &destination, &revision)).await
}
#[tauri::command]
pub async fn vfs_watch(
    app: tauri::AppHandle,
    mount_id: String,
    on_change: Channel<()>,
) -> Result<String, String> {
    let generation = app
        .state::<Service>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .generation;
    blocking(move || {
        let path = root(&app, &mount_id)?;
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if event
                    .as_ref()
                    .is_ok_and(|event| matches!(event.kind, notify::EventKind::Access(_)))
                {
                    return;
                }
                let _ = on_change.send(());
            })
            .map_err(|e| e.to_string())?;
        watcher
            .watch(&path, notify::RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let service = app.state::<Service>();
        let mut state = service.0.lock().map_err(|e| e.to_string())?;
        if state.generation != generation {
            return Err("Watch owner was closed".into());
        }
        state.watchers.insert(id.clone(), watcher);
        Ok(id)
    })
    .await
}
#[tauri::command]
pub fn vfs_unwatch(app: tauri::AppHandle, id: String) -> Result<(), String> {
    app.state::<Service>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .watchers
        .remove(&id);
    Ok(())
}
#[tauri::command]
pub async fn vfs_media(
    app: tauri::AppHandle,
    mount_id: String,
    path: String,
    mime: String,
    revision: String,
) -> Result<String, String> {
    blocking(move || {
        let root = root(&app, &mount_id)?;
        let current = stat(&scoped(&root, &path, false)?)?.ok_or("File is unavailable")?;
        if current.revision != revision {
            return Err("File changed while opening".into());
        }
        let service = app.state::<Service>();
        let mut state = service.0.lock().map_err(|e| e.to_string())?;
        if let Some((id, _)) = state.media.iter().find(|(_, file)| {
            file.root == root && file.path == path && file.revision == revision && file.mime == mime
        }) {
            return Ok(id.clone());
        }
        state
            .media
            .retain(|_, file| file.root != root || file.path != path || file.revision == revision);
        let id = uuid::Uuid::new_v4().to_string();
        state.media.insert(
            id.clone(),
            MediaFile {
                root,
                path,
                revision,
                mime,
            },
        );
        Ok(id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reveal_confines_files_to_the_mount_and_accepts_unfinished_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let relative = "资料/report.pdf.part";
        let file = root.join(relative);
        fs::create_dir(file.parent().unwrap()).unwrap();
        fs::write(&file, b"unfinished").unwrap();
        assert_eq!(reveal_path(&root, relative).unwrap(), file);
        assert!(reveal_path(&root, "../outside").is_err());
        assert!(reveal_path(&root, "").is_err());
        assert!(reveal_path(&root, "资料").is_err());
        assert!(reveal_path(&root, "missing.pdf").is_err());
        #[cfg(unix)]
        {
            let link = root.join("link.pdf");
            std::os::unix::fs::symlink(&file, link).unwrap();
            assert!(reveal_path(&root, "link.pdf").is_err());
        }
    }

    #[test]
    fn moving_a_completed_partial_preserves_existing_files_and_failed_sources() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let source = root.join("file.bin.part");
        let target = root.join("file.bin");
        fs::write(&source, b"received").unwrap();
        fs::write(&target, b"original").unwrap();
        let revision = stat(&source).unwrap().unwrap().revision;
        assert!(move_file(&root, "file.bin.part", "file.bin", &revision)
            .unwrap()
            .is_none());
        assert_eq!(fs::read(&source).unwrap(), b"received");
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert!(move_file(&root, "file.bin.part", "../escape.bin", &revision).is_err());
        assert!(move_file(&root, "file.bin.part", "other.bin", "stale").is_err());
        assert!(move_file(&root, "file.bin.part", "file (1).bin", &revision)
            .unwrap()
            .is_some());
        assert_eq!(fs::read(root.join("file (1).bin")).unwrap(), b"received");
        assert!(!source.exists());
    }

    #[test]
    fn system_open_revalidates_the_capability_path_and_file_revision() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let path = root.join("file.txt");
        std::fs::write(&path, b"original").unwrap();
        let mut media = MediaFile {
            root: root.clone(),
            path: "file.txt".into(),
            revision: stat(&path).unwrap().unwrap().revision,
            mime: "text/plain".into(),
        };
        assert_eq!(media.checked_path().unwrap(), path);
        std::fs::write(&path, b"changed content").unwrap();
        assert!(media.checked_path().is_err());
        media.path = "../file.txt".into();
        assert!(media.checked_path().is_err());
        media.path = "".into();
        media.revision = stat(&root).unwrap().unwrap().revision;
        assert!(media.checked_path().is_err());
        media.path = "missing.txt".into();
        assert!(media.checked_path().is_err());
    }
    #[test]
    fn preallocation_and_out_of_order_writes_preserve_offsets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("partial");
        let file = fs::File::create(&path).unwrap();
        file.set_len(10).unwrap();
        write_range(&path, 8, &[9, 10]).unwrap();
        write_range(&path, 0, &[1, 2, 3, 4]).unwrap();
        write_range(&path, 4, &[5, 6, 7, 8]).unwrap();
        file.sync_all().unwrap();
        assert_eq!(
            read_range(&path, 0, 10, None).unwrap(),
            (1..=10).collect::<Vec<_>>()
        );
        assert!(write_range(&path, 9, &[0, 0]).is_err());
        assert!(read_range(&path, 0, MAX_IO + 1, None).is_err());
        assert!(read_range(&path, 0, 1, Some("stale")).is_err());
    }
}
