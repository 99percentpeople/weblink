//! Root-scoped filesystem capabilities. JavaScript never submits an absolute path.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::Manager;
pub mod commands;
pub mod protocol;
pub mod writer;

#[derive(Clone, Serialize, Deserialize)]
pub struct Root {
    pub id: String,
    pub name: String,
    path: PathBuf,
}
#[derive(Clone)]
pub struct MediaFile {
    pub root: PathBuf,
    pub path: String,
    pub revision: String,
    pub mime: String,
}
impl MediaFile {
    fn checked_path(&self) -> Result<PathBuf, String> {
        let path = scoped(&self.root, &self.path, false)?;
        let current = stat(&path)?.ok_or("File is unavailable")?;
        if current.kind != "file" || current.revision != self.revision {
            return Err("File changed while opening".into());
        }
        Ok(path)
    }
}
#[derive(Default)]
struct State {
    generation: u64,
    roots: Option<Vec<Root>>,
    watchers: HashMap<String, notify::RecommendedWatcher>,
    media: HashMap<String, MediaFile>,
    writers: HashMap<String, std::sync::Arc<Mutex<writer::SequentialFile>>>,
}
#[derive(Default)]
pub struct Service(Mutex<State>);
impl Service {
    pub fn clear_page(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.generation = state.generation.wrapping_add(1);
            state.watchers.clear();
            state.media.clear();
            for (_, writer) in state.writers.drain() {
                if let Ok(mut writer) = writer.lock() {
                    writer.retire();
                }
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub kind: &'static str,
    pub size: u64,
    pub modified: u64,
    pub revision: String,
}
#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    #[serde(flatten)]
    pub stat: Stat,
}
#[derive(Serialize)]
pub struct Volume {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
}
impl From<&Root> for Volume {
    fn from(root: &Root) -> Self {
        Self {
            id: root.id.clone(),
            name: root.name.clone(),
            kind: "native",
        }
    }
}

fn registry(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("vfs-roots.json"))
}
pub fn roots(app: &tauri::AppHandle) -> Result<Vec<Root>, String> {
    let service = app.state::<Service>();
    let mut state = service.0.lock().map_err(|e| e.to_string())?;
    if let Some(roots) = &state.roots {
        return Ok(roots.clone());
    }
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("files");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut roots: Vec<Root> = match fs::read(registry(app)?) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Cannot read stored directories: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.to_string()),
    };
    roots.retain(|root| root.id != "native-default");
    roots.insert(
        0,
        Root {
            id: "native-default".into(),
            name: directory.to_string_lossy().into_owned(),
            path: fs::canonicalize(directory).map_err(|e| e.to_string())?,
        },
    );
    state.roots = Some(roots.clone());
    Ok(roots)
}
pub fn root(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    roots(app)?
        .into_iter()
        .find(|root| root.id == id)
        .map(|root| root.path)
        .ok_or_else(|| "Unknown directory capability".into())
}
pub fn add_root(app: &tauri::AppHandle, path: PathBuf) -> Result<Volume, String> {
    let canonical = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err("Expected a directory".into());
    }
    roots(app)?;
    let service = app.state::<Service>();
    let mut state = service.0.lock().map_err(|e| e.to_string())?;
    let roots = state
        .roots
        .as_ref()
        .ok_or("Directories are not initialized")?;
    if let Some(existing) = roots.iter().find(|root| root.path == canonical) {
        return Ok(existing.into());
    }
    let added = Root {
        id: format!("native-{}", uuid::Uuid::new_v4()),
        name: canonical.to_string_lossy().into_owned(),
        path: canonical,
    };
    let mut updated = roots.clone();
    updated.push(added.clone());
    let destination = registry(app)?;
    let mut temp =
        tempfile::NamedTempFile::new_in(destination.parent().ok_or("Missing registry directory")?)
            .map_err(|e| e.to_string())?;
    temp.write_all(&serde_json::to_vec(&updated).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(destination).map_err(|e| e.to_string())?;
    state.roots = Some(updated);
    Ok((&added).into())
}

/// Reject traversal, Windows alternate streams, and symlink escapes on every operation.
pub fn scoped(root: &Path, relative: &str, create_parents: bool) -> Result<PathBuf, String> {
    if relative.contains(['\\', ':', '\0'])
        || relative
            .split('/')
            .any(|part| part == "." || part == ".." || (!relative.is_empty() && part.is_empty()))
    {
        return Err("Invalid relative file path".into());
    }
    let canonical = fs::canonicalize(root).map_err(|e| e.to_string())?;
    if canonical != root {
        return Err("Mounted directory was replaced by a symbolic link".into());
    }
    let root = canonical;
    let mut path = root.clone();
    let components: Vec<_> = Path::new(relative).components().collect();
    for (index, part) in components.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err("Invalid relative file path".into());
        };
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err("Symbolic links are not followed".into());
                }
                if !fs::canonicalize(&path)
                    .map_err(|e| e.to_string())?
                    .starts_with(&root)
                {
                    return Err("File escapes its directory".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if create_parents && index + 1 < components.len() {
                    fs::create_dir(&path).map_err(|e| e.to_string())?;
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(path)
}
pub fn stat(path: &Path) -> Result<Option<Stat>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("Unsupported file type".into());
    }
    let modified = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    let created = metadata
        .created()
        .ok()
        .and_then(|date| date.duration_since(UNIX_EPOCH).ok())
        .map(|date| date.as_nanos())
        .unwrap_or_default();
    Ok(Some(Stat {
        kind: if metadata.is_dir() {
            "directory"
        } else {
            "file"
        },
        size: metadata.len(),
        modified: modified.as_millis() as u64,
        revision: format!("{}:{}:{created}", metadata.len(), modified.as_nanos()),
    }))
}
pub async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confines_paths_to_the_granted_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        for path in [
            "../outside",
            "/etc/passwd",
            "a/../b",
            "a\\b",
            "file:stream",
            "a//b",
        ] {
            assert!(scoped(&root, path, true).is_err(), "{path}");
        }
        let file = scoped(&root, "nested/file", true).unwrap();
        assert!(file.parent().unwrap().is_dir());
        assert!(file.starts_with(&root));
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlink_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        assert!(scoped(&fs::canonicalize(root.path()).unwrap(), "escape/file", true).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn refuses_a_replaced_mount_root() {
        let directory = tempfile::tempdir().unwrap();
        let path = fs::canonicalize(directory.path()).unwrap().join("mounted");
        fs::create_dir(&path).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::remove_dir(&path).unwrap();
        std::os::unix::fs::symlink(outside.path(), &path).unwrap();
        assert!(scoped(&path, "file", true).is_err());
    }
}
