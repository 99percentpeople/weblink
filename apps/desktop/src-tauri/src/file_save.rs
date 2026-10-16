//! Saves target a picker-selected path or Downloads, then use only an opaque ID.
use std::{collections::HashMap, io::Write, path::PathBuf, sync::Mutex};
use tauri::{
    ipc::{InvokeBody, Request},
    Manager,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MAX_CHUNK: usize = 1024 * 1024;
const MAX_SAVES: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileConflictAction {
    Overwrite,
    KeepBoth,
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DirectorySaveBegin {
    Ready {
        id: String,
    },
    Conflict {
        #[serde(rename = "fileName")]
        file_name: String,
        #[serde(rename = "canOverwrite")]
        can_overwrite: bool,
    },
}

struct Pending {
    temporary: tempfile::NamedTempFile,
    destination: PathBuf,
    size: u64,
    written: u64,
    automatic: bool,
    directory_id: Option<String>,
    open_directory: Option<tempfile::TempDir>,
}

impl Pending {
    fn for_open(name: &str, size: u64) -> Result<Self, String> {
        let directory = tempfile::Builder::new()
            .prefix("weblink-open-")
            .tempdir()
            .map_err(|error| error.to_string())?;
        let mut pending = Self::new(directory.path().join(suggested_name(name)), size)?;
        pending.open_directory = Some(directory);
        Ok(pending)
    }
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
            directory_id: None,
            open_directory: None,
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

    fn finish(mut self) -> Result<PathBuf, String> {
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
                match temporary.persist_noclobber(&destination) {
                    Ok(_) => return Ok(destination),
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
        Ok(self.destination)
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
    directories: HashMap<String, PathBuf>,
    // Keep opened copies alive across page reloads while the external app uses them.
    opened: Vec<tempfile::TempDir>,
}

impl State {
    fn add_directory(&mut self, directory: PathBuf) -> Result<String, String> {
        if self.directories.len() >= MAX_SAVES {
            return Err("Too many pending export directories".into());
        }
        let directory = directory
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !directory.is_dir() {
            return Err("Export destination is not a directory".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.directories.insert(id.clone(), directory);
        Ok(id)
    }

    fn begin_in_directory(
        &mut self,
        id: &str,
        name: &str,
        size: u64,
        action: Option<FileConflictAction>,
    ) -> Result<DirectorySaveBegin, String> {
        if self.saves.len() >= MAX_SAVES {
            return Err("Too many pending file saves".into());
        }
        let directory = self.directories.get(id).ok_or("Unknown export directory")?;
        if directory
            .canonicalize()
            .map_err(|error| error.to_string())?
            != *directory
        {
            return Err("Export directory was replaced".into());
        }
        let name = suggested_name(name);
        let destination = directory.join(name);
        match std::fs::symlink_metadata(&destination) {
            Ok(metadata) => {
                let can_overwrite = metadata.file_type().is_file();
                if action.is_none()
                    || (action == Some(FileConflictAction::Overwrite) && !can_overwrite)
                {
                    return Ok(DirectorySaveBegin::Conflict {
                        file_name: name.to_owned(),
                        can_overwrite,
                    });
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        let mut pending = Pending::new(destination, size)?;
        // Only an explicit overwrite choice allows replacement on commit.
        pending.automatic = action != Some(FileConflictAction::Overwrite);
        pending.directory_id = Some(id.to_owned());
        let save_id = uuid::Uuid::new_v4().to_string();
        self.saves.insert(save_id.clone(), pending);
        Ok(DirectorySaveBegin::Ready { id: save_id })
    }

    fn release_directory(&mut self, id: &str) {
        self.directories.remove(id);
        self.saves
            .retain(|_, save| save.directory_id.as_deref() != Some(id));
    }
}

#[derive(Default)]
pub struct Service(Mutex<State>);

impl Service {
    pub fn clear(&self) {
        let mut state = self.0.lock().unwrap_or_else(|error| error.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.saves.clear();
        state.directories.clear();
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
pub async fn file_open_begin(
    app: tauri::AppHandle,
    name: String,
    size: u64,
) -> Result<String, String> {
    let service = app.state::<Service>();
    let mut state = service.0.lock().map_err(|error| error.to_string())?;
    if state.saves.len() >= MAX_SAVES {
        return Err("Too many pending file saves".into());
    }
    let pending = Pending::for_open(&name, size)?;
    let id = uuid::Uuid::new_v4().to_string();
    state.saves.insert(id.clone(), pending);
    Ok(id)
}

#[tauri::command]
pub async fn file_save_directory_pick(
    window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    let service = window.state::<Service>();
    let generation = service
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .generation;
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .pick_folder(move |path| {
            let _ = send.send(path);
        });
    let Some(path) = receive.await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let directory = path.into_path().map_err(|error| error.to_string())?;
    let mut state = service.0.lock().map_err(|error| error.to_string())?;
    if state.generation != generation {
        return Err("File save owner was closed".into());
    }
    state.add_directory(directory).map(Some)
}

#[tauri::command]
pub async fn file_save_directory_release(app: tauri::AppHandle, id: String) -> Result<(), String> {
    app.state::<Service>()
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .release_directory(&id);
    Ok(())
}

#[tauri::command]
pub async fn file_save_directory_begin(
    app: tauri::AppHandle,
    directory_id: String,
    name: String,
    size: u64,
    action: Option<FileConflictAction>,
) -> Result<DirectorySaveBegin, String> {
    app.state::<Service>()
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .begin_in_directory(&directory_id, &name, size, action)
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
    let mut pending = state.saves.remove(&id).ok_or("Unknown file save")?;
    let open_directory = pending.open_directory.take();
    let path = pending.finish()?;
    if let Some(directory) = open_directory {
        app.opener()
            .open_path(path.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|error| error.to_string())?;
        state.opened.push(directory);
    }
    Ok(())
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
    fn opening_stages_exact_bytes_and_keeps_the_copy_alive_across_page_reload() {
        let service = Service::default();
        let mut pending = Pending::for_open("../文档.txt", 4).unwrap();
        let destination = pending.destination.clone();
        assert_eq!(destination.file_name().unwrap(), "文档.txt");
        assert!(!destination.exists());
        pending.write(0, b"data").unwrap();
        let directory = pending.open_directory.take().unwrap();
        assert_eq!(pending.finish().unwrap(), destination);
        service.0.lock().unwrap().opened.push(directory);
        service.clear();
        assert_eq!(std::fs::read(&destination).unwrap(), b"data");
        drop(service);
        assert!(!destination.exists());
    }

    #[test]
    fn abandoned_open_sessions_remove_their_temporary_directory() {
        let pending = Pending::for_open("report.pdf", 4).unwrap();
        let directory = pending.open_directory.as_ref().unwrap().path().to_owned();
        let service = Service::default();
        service
            .0
            .lock()
            .unwrap()
            .saves
            .insert("open".into(), pending);
        service.clear();
        assert!(!directory.exists());
    }

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

    #[test]
    fn directory_batch_preserves_existing_names_and_scopes_all_files_to_one_directory() {
        let directory = tempfile::tempdir().unwrap();
        let mut state = State::default();
        let id = state.add_directory(directory.path().to_owned()).unwrap();
        std::fs::write(directory.path().join("report.txt"), b"original").unwrap();
        std::fs::create_dir(directory.path().join("report (1).txt")).unwrap();
        for counter in 2..14 {
            let DirectorySaveBegin::Ready { id: save_id } = state
                .begin_in_directory(&id, "../report.txt", 1, Some(FileConflictAction::KeepBoth))
                .unwrap()
            else {
                panic!("Expected a save session");
            };
            let mut save = state.saves.remove(&save_id).unwrap();
            save.write(0, &[counter]).unwrap();
            let destination = save.finish().unwrap();
            assert_eq!(
                destination,
                directory.path().join(format!("report ({counter}).txt"))
            );
            assert_eq!(std::fs::read(destination).unwrap(), [counter]);
        }
        assert_eq!(
            std::fs::read(directory.path().join("report.txt")).unwrap(),
            b"original"
        );
        assert!(directory.path().join("report (1).txt").is_dir());
        state.release_directory(&id);
        assert!(state.begin_in_directory(&id, "later.txt", 0, None).is_err());
        assert!(state.saves.is_empty());
    }

    #[test]
    fn releasing_or_reloading_discards_pending_batch_bytes_and_revokes_directory_ids() {
        for reload in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let service = Service::default();
            let (directory_id, temporary) = {
                let mut state = service.0.lock().unwrap();
                let directory_id = state.add_directory(directory.path().to_owned()).unwrap();
                let DirectorySaveBegin::Ready { id: save_id } = state
                    .begin_in_directory(&directory_id, "unfinished.bin", 4, None)
                    .unwrap()
                else {
                    panic!("Expected a save session");
                };
                let save = state.saves.get_mut(&save_id).unwrap();
                save.write(0, b"ab").unwrap();
                (directory_id, save.temporary.path().to_owned())
            };
            if reload {
                service.clear();
            } else {
                service.0.lock().unwrap().release_directory(&directory_id);
            }
            assert!(!temporary.exists());
            assert!(!directory.path().join("unfinished.bin").exists());
            let mut state = service.0.lock().unwrap();
            assert!(state.directories.is_empty());
            assert!(state.saves.is_empty());
            assert!(state
                .begin_in_directory(&directory_id, "later.txt", 0, None)
                .is_err());
        }
    }

    #[test]
    fn export_directories_reject_files_and_unknown_ids() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut state = State::default();
        assert!(state.add_directory(file.path().to_owned()).is_err());
        assert!(state
            .begin_in_directory("unknown", "file.txt", 0, None)
            .is_err());
        assert!(state.saves.is_empty());
    }

    #[test]
    fn batch_overwrite_requires_a_choice_and_preserves_existing_bytes_until_commit() {
        for complete in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let destination = directory.path().join("report.txt");
            std::fs::write(&destination, b"original").unwrap();
            let mut state = State::default();
            let id = state.add_directory(directory.path().to_owned()).unwrap();
            assert!(matches!(
                state
                    .begin_in_directory(&id, "report.txt", 4, None)
                    .unwrap(),
                DirectorySaveBegin::Conflict {
                    can_overwrite: true,
                    ..
                }
            ));
            assert!(state.saves.is_empty());
            let DirectorySaveBegin::Ready { id: save_id } = state
                .begin_in_directory(&id, "report.txt", 4, Some(FileConflictAction::Overwrite))
                .unwrap()
            else {
                panic!("Expected a save session");
            };
            let mut save = state.saves.remove(&save_id).unwrap();
            let temporary = save.temporary.path().to_owned();
            save.write(0, b"ne").unwrap();
            assert_eq!(std::fs::read(&destination).unwrap(), b"original");
            if complete {
                save.write(2, b"w!").unwrap();
                save.finish().unwrap();
                assert_eq!(std::fs::read(&destination).unwrap(), b"new!");
            } else {
                assert!(save.finish().is_err());
                assert_eq!(std::fs::read(&destination).unwrap(), b"original");
            }
            assert!(!temporary.exists());
        }
    }

    #[test]
    fn a_same_name_directory_is_reported_and_cannot_be_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let existing = directory.path().join("report.txt");
        std::fs::create_dir(&existing).unwrap();
        std::fs::write(existing.join("child"), b"original").unwrap();
        let mut state = State::default();
        let id = state.add_directory(directory.path().to_owned()).unwrap();
        for action in [None, Some(FileConflictAction::Overwrite)] {
            assert!(matches!(
                state
                    .begin_in_directory(&id, "report.txt", 4, action)
                    .unwrap(),
                DirectorySaveBegin::Conflict {
                    can_overwrite: false,
                    ..
                }
            ));
        }
        assert!(state.saves.is_empty());
        assert_eq!(std::fs::read(existing.join("child")).unwrap(), b"original");
    }

    #[cfg(unix)]
    #[test]
    fn batch_overwrite_never_follows_a_destination_symlink() {
        let directory = tempfile::tempdir().unwrap();
        let target = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(target.path(), b"outside").unwrap();
        std::os::unix::fs::symlink(target.path(), directory.path().join("link.txt")).unwrap();
        let mut state = State::default();
        let id = state.add_directory(directory.path().to_owned()).unwrap();
        assert!(matches!(
            state
                .begin_in_directory(&id, "link.txt", 4, Some(FileConflictAction::Overwrite))
                .unwrap(),
            DirectorySaveBegin::Conflict {
                can_overwrite: false,
                ..
            }
        ));
        assert!(state.saves.is_empty());
        assert_eq!(std::fs::read(target.path()).unwrap(), b"outside");
    }
}
