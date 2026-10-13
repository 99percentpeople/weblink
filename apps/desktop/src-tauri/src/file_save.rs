//! Saves target a picker-selected path or Downloads, then use only an opaque ID.
use std::{collections::HashMap, io::Write, path::PathBuf, sync::Mutex};
use tauri::{
    ipc::{InvokeBody, Request},
    Manager,
};
use tauri_plugin_dialog::DialogExt;

const MAX_CHUNK: usize = 1024 * 1024;
const MAX_SAVES: usize = 8;

struct Pending {
    temporary: tempfile::NamedTempFile,
    destination: PathBuf,
    size: u64,
    written: u64,
    automatic: bool,
}

impl Pending {
    fn new(destination: PathBuf, size: u64) -> Result<Self, String> {
        let directory = destination.parent().ok_or("Invalid destination")?;
        let temporary = tempfile::Builder::new()
            .prefix(".weblink-save-")
            .tempfile_in(directory)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            temporary,
            destination,
            size,
            written: 0,
            automatic: false,
        })
    }

    fn write(&mut self, offset: u64, bytes: &[u8]) -> Result<(), String> {
        if offset != self.written || bytes.is_empty() || bytes.len() > MAX_CHUNK {
            return Err("Invalid file save chunk".into());
        }
        let next = self
            .written
            .checked_add(bytes.len() as u64)
            .ok_or("Invalid file size")?;
        if next > self.size {
            return Err("File save exceeds declared size".into());
        }
        self.temporary
            .write_all(bytes)
            .map_err(|error| error.to_string())?;
        self.written = next;
        Ok(())
    }

    fn finish(mut self) -> Result<(), String> {
        if self.written != self.size {
            return Err("File save is incomplete".into());
        }
        self.temporary.flush().map_err(|error| error.to_string())?;
        self.temporary
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        // Replacement happens only after every byte has been written successfully.
        // Dropping a failed persist removes the temporary file and preserves the destination.
        if self.automatic {
            let mut temporary = self.temporary;
            for counter in 0..10_000 {
                let destination = numbered_path(&self.destination, counter);
                match temporary.persist_noclobber(destination) {
                    Ok(_) => return Ok(()),
                    Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                        temporary = error.file;
                    }
                    Err(error) => return Err(error.to_string()),
                }
            }
            return Err("Could not find an unused download filename".into());
        }
        self.temporary
            .persist(&self.destination)
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn numbered_path(path: &std::path::Path, counter: usize) -> PathBuf {
    if counter == 0 {
        return path.to_owned();
    }
    let mut name = path.file_stem().unwrap_or_default().to_os_string();
    name.push(format!(" ({counter})"));
    if let Some(extension) = path.extension() {
        name.push(".");
        name.push(extension);
    }
    path.with_file_name(name)
}

#[derive(Default)]
struct State {
    generation: u64,
    saves: HashMap<String, Pending>,
}

#[derive(Default)]
pub struct Service(Mutex<State>);

impl Service {
    pub fn clear(&self) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.saves.clear();
    }
}

fn suggested_name(name: &str) -> &str {
    let name = name.rsplit(['/', '\\']).next().unwrap_or("");
    if crate::staged_files::file_name(name).is_ok() {
        name
    } else {
        "download"
    }
}

#[tauri::command]
pub async fn file_save_begin(
    window: tauri::WebviewWindow,
    name: String,
    size: u64,
    automatic: bool,
) -> Result<Option<String>, String> {
    let service = window.state::<Service>();
    let generation = service
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .generation;
    let directory = window
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let destination = if automatic {
        directory.join(suggested_name(&name))
    } else {
        let (send, receive) = tokio::sync::oneshot::channel();
        window
            .dialog()
            .file()
            .set_parent(&window)
            .set_directory(&directory)
            .set_file_name(suggested_name(&name))
            .save_file(move |path| {
                let _ = send.send(path);
            });
        let Some(path) = receive.await.map_err(|error| error.to_string())? else {
            return Ok(None);
        };
        path.into_path().map_err(|error| error.to_string())?
    };
    let mut state = service.0.lock().map_err(|error| error.to_string())?;
    if state.generation != generation {
        return Err("File save owner was closed".into());
    }
    if state.saves.len() >= MAX_SAVES {
        return Err("Too many pending file saves".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut pending = Pending::new(destination, size)?;
    pending.automatic = automatic;
    state.saves.insert(id.clone(), pending);
    Ok(Some(id))
}

#[tauri::command]
pub async fn file_save_write(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-save-id")
        .and_then(|value| value.to_str().ok())
        .ok_or("Missing save ID")?;
    let offset = request
        .headers()
        .get("x-save-offset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or("Missing save offset")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected binary file content".into());
    };
    let service = app.state::<Service>();
    let mut state = service.0.lock().map_err(|error| error.to_string())?;
    let result = state
        .saves
        .get_mut(id)
        .ok_or("Unknown file save")?
        .write(offset, bytes);
    if result.is_err() {
        state.saves.remove(id);
    }
    result
}

#[tauri::command]
pub async fn file_save_finish(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let service = app.state::<Service>();
    let mut state = service.0.lock().map_err(|error| error.to_string())?;
    state.saves.remove(&id).ok_or("Unknown file save")?.finish()
}

#[tauri::command]
pub async fn file_save_abort(app: tauri::AppHandle, id: String) -> Result<(), String> {
    app.state::<Service>()
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .saves
        .remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_exact_bytes_and_only_replaces_the_destination_on_finish() {
        let folder = tempfile::tempdir().unwrap();
        let destination = folder.path().join("received.bin");
        std::fs::write(&destination, b"original").unwrap();
        let mut save = Pending::new(destination.clone(), 5).unwrap();
        save.write(0, &[0, 255]).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        save.write(2, &[12, 34, 56]).unwrap();
        save.finish().unwrap();
        assert_eq!(std::fs::read(destination).unwrap(), [0, 255, 12, 34, 56]);
    }

    #[test]
    fn aborting_or_finishing_early_preserves_an_existing_file() {
        let folder = tempfile::tempdir().unwrap();
        let destination = folder.path().join("received.bin");
        std::fs::write(&destination, b"original").unwrap();
        for finish in [false, true] {
            let mut save = Pending::new(destination.clone(), 5).unwrap();
            let temporary = save.temporary.path().to_owned();
            save.write(0, &[1, 2]).unwrap();
            if finish {
                assert!(save.finish().is_err());
            } else {
                drop(save);
            }
            assert!(!temporary.exists());
            assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        }
    }

    #[test]
    fn rejects_duplicate_oversized_and_overflowing_chunks() {
        let folder = tempfile::tempdir().unwrap();
        let mut save = Pending::new(folder.path().join("received.bin"), 4).unwrap();
        assert!(save.write(1, &[0]).is_err());
        assert!(save.write(0, &[]).is_err());
        assert!(save.write(0, &vec![0; MAX_CHUNK + 1]).is_err());
        assert!(save.write(0, &[0; 5]).is_err());
        save.write(0, &[0, 255]).unwrap();
        assert!(save.write(0, &[0, 255]).is_err());
    }

    #[test]
    fn supports_empty_files_and_cleans_up_on_page_reload() {
        let folder = tempfile::tempdir().unwrap();
        let destination = folder.path().join("empty.bin");
        Pending::new(destination.clone(), 0)
            .unwrap()
            .finish()
            .unwrap();
        assert_eq!(std::fs::metadata(destination).unwrap().len(), 0);
        let save = Pending::new(folder.path().join("cancelled.bin"), 1).unwrap();
        let temporary = save.temporary.path().to_owned();
        let service = Service::default();
        service
            .0
            .lock()
            .unwrap()
            .saves
            .insert("pending".into(), save);
        service.clear();
        assert!(!temporary.exists());
        let state = service.0.lock().unwrap();
        assert!(state.saves.is_empty());
        assert_eq!(state.generation, 1);
    }

    #[test]
    fn picker_suggestions_never_include_paths_or_reserved_names() {
        assert_eq!(suggested_name("../document.txt"), "document.txt");
        assert_eq!(suggested_name("C:\\folder\\document.txt"), "document.txt");
        assert_eq!(suggested_name("中文.zip"), "中文.zip");
        for name in ["", "NUL.txt", "..", "bad:name.txt"] {
            assert_eq!(suggested_name(name), "download");
        }
    }

    #[test]
    fn automatic_downloads_keep_existing_files_and_choose_an_unused_name() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("received.txt");
        std::fs::write(&destination, b"existing").unwrap();
        std::fs::write(directory.path().join("received (1).txt"), b"previous").unwrap();
        let mut pending = Pending::new(destination.clone(), 3).unwrap();
        pending.automatic = true;
        pending.write(0, b"new").unwrap();
        pending.finish().unwrap();
        assert_eq!(std::fs::read(destination).unwrap(), b"existing");
        assert_eq!(
            std::fs::read(directory.path().join("received (1).txt")).unwrap(),
            b"previous"
        );
        assert_eq!(
            std::fs::read(directory.path().join("received (2).txt")).unwrap(),
            b"new"
        );
    }
}
