//! Sequential output capabilities are page-scoped and never accept host paths.
use super::*;
use std::io::{Seek, SeekFrom};
use std::sync::Arc;
use tauri::ipc::{InvokeBody, Request};

#[derive(Deserialize)]
pub struct MetadataPatch {
    offset: u64,
    data: Vec<u8>,
}

pub(super) struct SequentialFile {
    root: PathBuf,
    path: String,
    file: Option<fs::File>,
    revision: String,
    size: u64,
    synced: u64,
    failed: bool,
    closed: bool,
}
impl SequentialFile {
    fn open(root: PathBuf, path: String) -> Result<Self, String> {
        let target = scoped(&root, &path, true)?;
        let file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target)
            .map_err(|e| e.to_string())?;
        let revision = stat(&target)?.ok_or("File is unavailable")?.revision;
        Ok(Self {
            root,
            path,
            file: Some(file),
            revision,
            size: 0,
            synced: 0,
            failed: false,
            closed: false,
        })
    }
    fn check(&self) -> Result<Stat, String> {
        let current =
            stat(&scoped(&self.root, &self.path, false)?)?.ok_or("Recording file was removed")?;
        if current.revision != self.revision || current.size != self.size {
            return Err("Recording file changed while writing".into());
        }
        Ok(current)
    }
    fn append(&mut self, offset: u64, bytes: &[u8]) -> Result<(), String> {
        if self.closed
            || self.failed
            || bytes.len() > 1024 * 1024
            || offset != self.size
            || offset
                .checked_add(bytes.len() as u64)
                .is_none_or(|end| end > 9_007_199_254_740_991)
        {
            return Err("Invalid sequential write".into());
        }
        self.check()?;
        self.failed = true;
        let file = self.file.as_mut().ok_or("Recording writer is closed")?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        self.size += bytes.len() as u64;
        if self.size - self.synced >= 4 * 1024 * 1024 {
            file.sync_data().map_err(|e| e.to_string())?;
            self.synced = self.size;
        }
        self.revision = stat(&scoped(&self.root, &self.path, false)?)?
            .ok_or("Recording file was removed")?
            .revision;
        self.failed = false;
        Ok(())
    }
    fn finish(&mut self, patches: &[MetadataPatch]) -> Result<Stat, String> {
        self.closed = true;
        if self.failed {
            return Err("Recording write failed".into());
        }
        self.check()?;
        if patches.len() > 16
            || patches.iter().map(|patch| patch.data.len()).sum::<usize>() > 64 * 1024
            || patches.iter().any(|patch| {
                patch
                    .offset
                    .checked_add(patch.data.len() as u64)
                    .is_none_or(|end| end > self.size)
            })
        {
            return Err("Invalid file metadata update".into());
        }
        let file = self.file.as_mut().ok_or("Recording writer is closed")?;
        for patch in patches {
            file.seek(SeekFrom::Start(patch.offset))
                .map_err(|e| e.to_string())?;
            file.write_all(&patch.data).map_err(|e| e.to_string())?;
        }
        if !patches.is_empty() {
            self.revision = stat(&scoped(&self.root, &self.path, false)?)?
                .ok_or("Recording file was removed")?
                .revision;
        }
        self.file
            .as_ref()
            .ok_or("Recording writer is closed")?
            .sync_all()
            .map_err(|e| e.to_string())?;
        self.check()?;
        // Windows may update the last-write timestamp when the final write
        // handle closes. Publish the revision only after releasing our handle.
        self.file.take();
        let result =
            stat(&scoped(&self.root, &self.path, false)?)?.ok_or("Recording file was removed")?;
        if result.size != self.size {
            return Err("Recording file changed while closing".into());
        }
        Ok(result)
    }
    pub(super) fn retire(&mut self) {
        self.closed = true;
        self.file.take();
    }
}

#[tauri::command]
pub async fn vfs_writer_open(
    app: tauri::AppHandle,
    mount_id: String,
    path: String,
) -> Result<String, String> {
    blocking(move || {
        let root = root(&app, &mount_id)?;
        let service = app.state::<Service>();
        let mut state = service.0.lock().map_err(|e| e.to_string())?;
        if state.writers.len() >= 8 {
            return Err("Too many file writers".into());
        }
        let writer = SequentialFile::open(root, path)?;
        let id = uuid::Uuid::new_v4().to_string();
        state
            .writers
            .insert(id.clone(), Arc::new(Mutex::new(writer)));
        Ok(id)
    })
    .await
}
#[tauri::command]
pub async fn vfs_writer_append(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-vfs-writer")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing writer capability")?
        .to_owned();
    let offset = request
        .headers()
        .get("x-vfs-offset")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing write offset")?
        .parse::<u64>()
        .map_err(|e| e.to_string())?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected binary content".into());
    };
    if bytes.len() > 1024 * 1024 {
        return Err("Write exceeds buffer limit".into());
    }
    let bytes = bytes.clone();
    blocking(move || {
        let writer = app
            .state::<Service>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .writers
            .get(&id)
            .cloned()
            .ok_or("Unknown writer capability")?;
        let result = writer
            .lock()
            .map_err(|e| e.to_string())?
            .append(offset, &bytes);
        result
    })
    .await
}
#[tauri::command]
pub async fn vfs_writer_close(
    app: tauri::AppHandle,
    id: String,
    patches: Option<Vec<MetadataPatch>>,
) -> Result<Stat, String> {
    blocking(move || {
        let writer = app
            .state::<Service>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .writers
            .remove(&id)
            .ok_or("Unknown writer capability")?;
        let result = writer
            .lock()
            .map_err(|e| e.to_string())?
            .finish(&patches.unwrap_or_default());
        result
    })
    .await
}
#[tauri::command]
pub async fn vfs_writer_abort(app: tauri::AppHandle, id: String) -> Result<(), String> {
    blocking(move || {
        let writer = app
            .state::<Service>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .writers
            .remove(&id);
        if let Some(writer) = writer {
            let mut writer = writer.lock().map_err(|e| e.to_string())?;
            writer.closed = true;
            let result = writer.file.as_ref().map(|file| file.sync_all()).transpose();
            writer.file.take();
            result.map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commits_metadata_without_changing_the_file_size() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let mut writer = SequentialFile::open(root.clone(), "video.part".into()).unwrap();
        writer.append(0, b"0000payload").unwrap();
        let result = writer
            .finish(&[MetadataPatch {
                offset: 0,
                data: b"1234".to_vec(),
            }])
            .unwrap();
        assert_eq!(result.size, 11);
        assert_eq!(fs::read(root.join("video.part")).unwrap(), b"1234payload");
        assert_eq!(
            result.revision,
            stat(&root.join("video.part")).unwrap().unwrap().revision
        );
    }
    #[test]
    fn refuses_out_of_bounds_metadata_before_mutating() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let mut writer = SequentialFile::open(root.clone(), "video.part".into()).unwrap();
        writer.append(0, b"payload").unwrap();
        assert!(writer
            .finish(&[MetadataPatch {
                offset: 7,
                data: vec![1]
            }])
            .is_err());
        assert_eq!(fs::read(root.join("video.part")).unwrap(), b"payload");
    }
    #[test]
    fn grows_without_preallocation_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let mut writer = SequentialFile::open(root.clone(), "video.part".into()).unwrap();
        assert!(SequentialFile::open(root.clone(), "video.part".into()).is_err());
        writer.append(0, b"first").unwrap();
        assert!(writer.append(0, b"duplicate").is_err());
        writer.append(5, b"last").unwrap();
        let final_stat = writer.finish(&[]).unwrap();
        assert_eq!(final_stat.size, 9);
        assert_eq!(
            final_stat.revision,
            stat(&root.join("video.part")).unwrap().unwrap().revision
        );
        assert!(writer.append(9, b"late").is_err());
        assert_eq!(fs::read(root.join("video.part")).unwrap(), b"firstlast");
        assert!(SequentialFile::open(root, "../escape".into()).is_err());
    }
    #[test]
    fn refuses_external_edits() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let mut writer = SequentialFile::open(root.clone(), "video.part".into()).unwrap();
        writer.append(0, b"first").unwrap();
        fs::write(root.join("video.part"), b"external edit").unwrap();
        assert!(writer.append(5, b"last").is_err());
        assert!(writer.finish(&[]).is_err());
    }
}
