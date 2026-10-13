//! A cancellable OLE preview while browser file data is still protected.
use super::*;
use std::thread::JoinHandle;

struct State {
    scope: Scope,
    target: Target,
    point: Mutex<Position>,
    cancelled: AtomicBool,
    created: Instant,
}
#[derive(Clone)]
pub(super) struct Preview {
    state: Arc<State>,
    worker: Arc<Mutex<Option<JoinHandle<Result<(), String>>>>>,
}
static ACTIVE: LazyLock<Mutex<HashMap<String, Preview>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

impl Preview {
    pub(super) fn move_to(
        &self,
        scope: &Scope,
        target: &Target,
        point: Position,
    ) -> Result<(), String> {
        if &self.state.scope != scope
            || &self.state.target != target
            || self.state.cancelled.load(Ordering::Acquire)
        {
            return Err("Stale file drag".into());
        }
        if self
            .worker
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .is_none_or(|worker| worker.is_finished())
        {
            return Err("Native file drag ended".into());
        }
        *self.state.point.lock().map_err(|e| e.to_string())? = point;
        Ok(())
    }
    pub(super) fn stop(&self) {
        self.state.cancelled.store(true, Ordering::Release);
        if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Preview {
    fn drop(&mut self) {
        if Arc::strong_count(&self.worker) == 1 {
            self.stop();
        }
    }
}
pub(super) fn update(
    service: Shared,
    scope: Scope,
    id: String,
    target: Target,
    point: Position,
    types: Vec<String>,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "Invalid drag operation")?;
    position(&service, &scope, &target, &point)?;
    if types.len() > 16 || types.iter().any(|t| t.len() > 128 || !t.is_ascii()) {
        return Err("Invalid file drag types".into());
    }
    let mut active = ACTIVE.lock().map_err(|e| e.to_string())?;
    active.retain(|_, preview| {
        !preview
            .worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_none_or(|w| w.is_finished())
    });
    if let Some(preview) = active.get(&id) {
        return preview.move_to(&scope, &target, point);
    }
    if active.len() >= 16 {
        return Err("Too many file drags".into());
    }
    // Only hints are exposed during dragover. These empty files can never be dropped;
    // the final operation always uses the separately transferred, validated real files.
    let entries = preview_names(&types)
        .into_iter()
        .map(|name| FileEntry {
            name,
            data: String::new(),
        })
        .collect();
    let staged = staged_files::stage(entries, 1)?;
    let state = Arc::new(State {
        scope,
        target,
        point: Mutex::new(point),
        cancelled: AtomicBool::new(false),
        created: Instant::now(),
    });
    let lifetime = state.clone();
    let (ready, started) = std::sync::mpsc::sync_channel(1);
    let worker = std::thread::Builder::new()
        .name("weblink-file-hover".into())
        .spawn(move || {
            let Ok(_dragging) = DROPPING.try_lock() else {
                let _ = ready.send(Err("Another file drop is running".to_string()));
                return Err("Another file drop is running".into());
            };
            let _ = ready.send(Ok(()));
            windows::preview(
                &staged.paths,
                Box::new(move || {
                    if lifetime.cancelled.load(Ordering::Acquire)
                        || lifetime.created.elapsed() >= LIFETIME
                    {
                        return None;
                    }
                    let point = lifetime.point.lock().ok()?;
                    position(&service, &lifetime.scope, &lifetime.target, &point).ok()
                }),
            )
        })
        .map_err(|e| e.to_string())?;
    started.recv().map_err(|e| e.to_string())??;
    active.insert(
        id,
        Preview {
            state,
            worker: Arc::new(Mutex::new(Some(worker))),
        },
    );
    Ok(())
}
pub(super) fn take(scope: &Scope, id: &str) -> Result<Option<Preview>, String> {
    let mut active = ACTIVE.lock().map_err(|e| e.to_string())?;
    if active.get(id).is_some_and(|p| p.state.scope != *scope) {
        return Err("Stale file drag".into());
    }
    Ok(active.remove(id))
}
pub(super) fn shutdown() {
    for (_, preview) in ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).drain() {
        preview.stop();
    }
}
fn preview_names(types: &[String]) -> Vec<String> {
    let types = if types.is_empty() {
        vec![String::new()]
    } else {
        types.to_vec()
    };
    types
        .iter()
        .enumerate()
        .map(|(i, kind)| {
            let extension = match kind.as_str() {
                "image/png" => "png",
                "image/jpeg" => "jpg",
                "image/webp" => "webp",
                "image/gif" => "gif",
                "image/bmp" => "bmp",
                "image/avif" => "avif",
                "video/mp4" => "mp4",
                "video/webm" => "webm",
                "audio/mpeg" => "mp3",
                "application/pdf" => "pdf",
                "text/plain" => "txt",
                _ => "bin",
            };
            format!("drag-preview-{}.{}", i + 1, extension)
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_names_never_contain_remote_paths() {
        assert_eq!(preview_names(&[]), ["drag-preview-1.bin"]);
        assert_eq!(
            preview_names(&["image/jpeg".into(), "../bad".into()]),
            ["drag-preview-1.jpg", "drag-preview-2.bin"]
        );
    }
}
