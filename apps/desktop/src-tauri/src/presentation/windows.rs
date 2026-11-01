use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager, State, Webview};
use weblink_desktop_capture::presentation::{Compositor, Layout, Recording, Source, Subscription};

struct Entry {
    owner: String,
    source: Arc<Source>,
    subscription: Subscription,
    media: Option<std::sync::Weak<weblink_desktop_capture::media::MediaSession>>,
    key: u64,
    renewed: Instant,
    recordings: HashMap<String, Arc<Recording>>,
}
impl Drop for Entry {
    fn drop(&mut self) {
        for recording in self.recordings.values() {
            recording.close();
        }
    }
}
#[derive(Default)]
struct Data {
    entries: HashMap<String, Entry>,
    windows: HashMap<String, Compositor>,
    next: u64,
}
#[derive(Default)]
pub struct Service(Mutex<Data>);
impl Data {
    fn remove(&mut self, id: &str) {
        if let Some(entry) = self.entries.remove(id) {
            if let Some(window) = self.windows.get(&entry.owner) {
                window.remove(entry.key);
            }
        }
    }
}
impl Service {
    pub fn clear(&self, owner: Option<&str>) {
        let mut data = self.0.lock().unwrap();
        let ids: Vec<_> = data
            .entries
            .iter()
            .filter(|(_, e)| owner.is_none_or(|owner| owner == e.owner))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            data.remove(&id);
        }
        data.windows
            .retain(|label, _| !owner.is_none_or(|owner| owner == label));
    }
}
#[tauri::command]
pub async fn presentation_open(
    webview: Webview,
    service: State<'_, Service>,
    id: String,
    source_id: String,
    preview: bool,
    events: Channel<Value>,
) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || source_id.is_empty() || source_id.len() > 128 {
        return Err("Invalid native presentation ID".into());
    }
    let media = if preview {
        let source_id = source_id.clone();
        Some(
            crate::capture::run(webview.state::<crate::capture::Service>(), move |s| {
                s.media(source_id)
            })
            .await?,
        )
    } else {
        None
    };
    let source = if let Some(media) = &media {
        media.gpu_preview.clone()
    } else {
        webview
            .state::<crate::receive::Shared>()
            .gpu_source(webview.label(), &source_id)?
    };
    let owner = webview.label().to_string();
    // Layout IPC and WebView painting can land on adjacent frames. Exposed
    // areas behind the GPU visuals should match the video's black bars.
    let window = webview.window();
    window
        .set_background_color(Some(tauri::window::Color(0, 0, 0, 255)))
        .map_err(|e| e.to_string())?;
    // Transparent WebView content exposes the composition target below its HWND.
    webview
        .set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))
        .map_err(|e| e.to_string())?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    let mut data = service.0.lock().unwrap();
    let expired: Vec<_> = data
        .entries
        .iter()
        .filter(|(_, e)| e.renewed.elapsed() > Duration::from_secs(45))
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        data.remove(&id);
    }
    if data.entries.contains_key(&id) || data.entries.len() >= 16 {
        return Err("Native presentation already open or limit reached".into());
    }
    if !data.windows.contains_key(&owner) {
        data.windows.insert(owner.clone(), Compositor::new(hwnd)?);
    }
    let weak = Arc::downgrade(&source);
    let dimensions = Mutex::new(None);
    let subscription = source.subscribe(Arc::new(move || {
        let Some(source) = weak.upgrade() else { return };
        if source.closed() {
            let _ = events.send(json!({"type":"ended"}));
            return;
        }
        if let Some(error) = source.stats().error {
            let _ = events.send(json!({"type":"error", "error":error}));
            return;
        }
        if let Some(frame) = source.latest() {
            let size = frame.texture.size;
            let mut previous = dimensions.lock().unwrap();
            if *previous != Some(size) {
                *previous = Some(size);
                let _ = events.send(json!({"type":"surface", "width":size.0, "height":size.1}));
            }
        }
    }));
    data.next += 1;
    let key = data.next;
    data.entries.insert(
        id,
        Entry {
            owner,
            source,
            subscription,
            media: media.as_ref().map(Arc::downgrade),
            key,
            renewed: Instant::now(),
            recordings: HashMap::new(),
        },
    );
    drop(data);
    if let Some(media) = media {
        media.wake_gpu_preview();
    }
    Ok(())
}
#[tauri::command]
pub fn presentation_layout(
    webview: Webview,
    service: State<'_, Service>,
    id: String,
    layout: Layout,
) -> Result<(), String> {
    layout.validate()?;
    let mut data = service.0.lock().unwrap();
    let entry = data
        .entries
        .get_mut(&id)
        .filter(|e| e.owner == webview.label())
        .ok_or("Native presentation closed")?;
    entry.renewed = Instant::now();
    entry.subscription.set_active(layout.visible);
    entry.subscription.set_frames(layout.visible);
    if layout.visible {
        if let Some(media) = entry.media.as_ref().and_then(|m| m.upgrade()) {
            media.wake_gpu_preview();
        }
    }
    let source = entry.source.clone();
    let key = entry.key;
    data.windows
        .get(webview.label())
        .ok_or("Native presentation window closed")?
        .bind(key, source, layout)
}
#[tauri::command]
pub fn presentation_stats(
    webview: Webview,
    service: State<'_, Service>,
    id: String,
) -> Result<Value, String> {
    let mut data = service.0.lock().unwrap();
    let entry = data
        .entries
        .get_mut(&id)
        .filter(|e| e.owner == webview.label())
        .ok_or("Native presentation closed")?;
    entry.renewed = Instant::now();
    let stats = entry.source.stats();
    Ok(
        json!({"path":"d3d11-composition", "presentedFrames":stats.presented_frames, "uploadedFrames":stats.uploaded_frames,
        "decodedQueueMs":stats.decoded_queue_ms, "submitMs":stats.submit_ms, "error":stats.error}),
    )
}
#[tauri::command]
pub fn presentation_close(webview: Webview, service: State<'_, Service>, id: String) {
    let mut data = service.0.lock().unwrap();
    if data
        .entries
        .get(&id)
        .is_some_and(|e| e.owner == webview.label())
    {
        data.remove(&id);
    }
}
#[tauri::command]
pub fn presentation_recording_open(
    webview: Webview,
    service: State<'_, Service>,
    id: String,
    recording_id: String,
) -> Result<(), String> {
    if recording_id.is_empty() || recording_id.len() > 128 {
        return Err("Invalid native recording ID".into());
    }
    let mut data = service.0.lock().unwrap();
    let entry = data
        .entries
        .get_mut(&id)
        .filter(|e| e.owner == webview.label())
        .ok_or("Native presentation closed")?;
    // Allow a new recording while the previous session's asynchronous close is
    // in transit. Both ownership and readback work remain bounded.
    if entry.recordings.contains_key(&recording_id)
        || entry.recordings.len() >= 2
        || entry.source.closed()
    {
        return Err("Native recording limit reached or source closed".into());
    }
    entry
        .recordings
        .insert(recording_id, Arc::new(entry.source.recording()));
    entry.renewed = Instant::now();
    if let Some(media) = entry.media.as_ref().and_then(|m| m.upgrade()) {
        media.wake_gpu_preview();
    }
    Ok(())
}
#[tauri::command]
pub fn presentation_recording_close(
    webview: Webview,
    service: State<'_, Service>,
    id: String,
    recording_id: String,
) {
    let mut data = service.0.lock().unwrap();
    if let Some(entry) = data
        .entries
        .get_mut(&id)
        .filter(|e| e.owner == webview.label())
    {
        // A late close from a cancelled opening must not close a new recording.
        if let Some(recording) = entry.recordings.remove(&recording_id) {
            recording.close();
        }
    }
}
#[tauri::command]
pub async fn presentation_frame(
    webview: Webview,
    service: State<'_, Service>,
    id: String,
    recording_id: String,
    after: u64,
) -> Result<tauri::ipc::Response, String> {
    let recording = service
        .0
        .lock()
        .unwrap()
        .entries
        .get_mut(&id)
        .filter(|e| e.owner == webview.label())
        .and_then(|e| {
            e.renewed = Instant::now();
            e.recordings.get(&recording_id).cloned()
        })
        .ok_or("Native recording closed")?;
    let data = recording.read_frame(after).await?;
    Ok(tauri::ipc::Response::new(data))
}
