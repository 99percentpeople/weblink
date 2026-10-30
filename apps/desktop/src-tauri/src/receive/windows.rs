use serde_json::Value;
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, State, Webview};
use weblink_desktop_capture::{
    media::{IceCandidate, IceServer},
    receive::{Frame, Receiver, FRAME_CAPACITY},
};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment12, ICoreWebView2SharedBuffer, ICoreWebView2_17,
    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
};
use windows_core::{Interface, HSTRING};

struct Entry {
    owner: String,
    receiver: Arc<Receiver>,
    renewed: Instant,
}
#[derive(Default)]
pub struct Service(Mutex<HashMap<String, Entry>>);
pub type Shared = Arc<Service>;
impl Service {
    fn get(&self, owner: &str, id: &str) -> Result<Arc<Receiver>, String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .filter(|e| e.owner == owner)
            .map(|e| e.receiver.clone())
            .ok_or("Native receiver closed".into())
    }
    pub fn clear(&self, owner: Option<&str>) {
        let removed = {
            let mut entries = self.0.lock().unwrap();
            let ids: Vec<_> = entries
                .iter()
                .filter(|(_, e)| owner.is_none_or(|owner| e.owner == owner))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| entries.remove(&id))
                .collect::<Vec<_>>()
        };
        for e in removed {
            e.receiver.close();
        }
    }
}
struct Buffer {
    owner: String,
    shared: ICoreWebView2SharedBuffer,
}
impl Drop for Buffer {
    fn drop(&mut self) {
        let _ = unsafe { self.shared.Close() };
    }
}
thread_local! { static BUFFERS: RefCell<HashMap<String, Buffer>> = RefCell::new(HashMap::new()); }
async fn on_view<T: Send + 'static>(
    webview: Webview,
    f: impl FnOnce(tauri::webview::PlatformWebview) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |view| {
            let _ = tx.try_send(f(view));
        })
        .map_err(|e| e.to_string())?;
    rx.recv().await.ok_or("Receiver WebView closed")?
}
pub fn clear_buffers(window: &tauri::WebviewWindow) {
    let owner = window.label().to_owned();
    let _ = window.run_on_main_thread(move || {
        BUFFERS.with(|b| b.borrow_mut().retain(|_, b| b.owner != owner))
    });
}
#[tauri::command]
pub async fn receive_codecs() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(weblink_desktop_capture::receive::codecs)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn receive_open(
    webview: Webview,
    service: State<'_, Shared>,
    id: String,
    ice_servers: Vec<IceServer>,
    relay_only: bool,
    events: Channel<Value>,
) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("Invalid receiver id".into());
    }
    let owner = webview.label().to_owned();
    // Hold admission across construction so concurrent opens cannot exceed the limit.
    {
        let mut entries = service.0.lock().unwrap();
        if entries.contains_key(&id) || entries.values().any(|e| e.owner == owner) {
            return Err("Native receiver is busy".into());
        }
        let receiver = Receiver::new(
            ice_servers,
            relay_only,
            Arc::new(move |e| events.send(e).is_ok()),
        )?;
        entries.insert(
            id.clone(),
            Entry {
                owner: owner.clone(),
                receiver,
                renewed: Instant::now(),
            },
        );
    }
    let buffer_id = id.clone();
    let result = on_view(webview.clone(), move |view| {
        unsafe {
            let env: ICoreWebView2Environment12 =
                view.environment().cast().map_err(|e| e.to_string())?;
            let shared = env
                .CreateSharedBuffer(FRAME_CAPACITY as u64)
                .map_err(|e| e.to_string())?;
            let web: ICoreWebView2_17 = view
                .controller()
                .CoreWebView2()
                .and_then(|w| w.cast())
                .map_err(|e| e.to_string())?;
            let metadata = HSTRING::from(
                serde_json::json!({"kind":"weblink-receive","id":buffer_id}).to_string(),
            );
            web.PostSharedBufferToScript(
                &shared,
                COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                &metadata,
            )
            .map_err(|e| e.to_string())?;
            BUFFERS.with(|b| b.borrow_mut().insert(buffer_id, Buffer { owner, shared }));
        }
        Ok(())
    })
    .await;
    if let Err(error) = result {
        if let Some(e) = service.0.lock().unwrap().remove(&id) {
            e.receiver.close();
        }
        return Err(error);
    }
    let weak = Arc::downgrade(&service);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let Some(service) = weak.upgrade() else { break };
            let expired = {
                let mut entries = service.0.lock().unwrap();
                let Some(e) = entries.get(&id) else { break };
                if e.renewed.elapsed() > Duration::from_secs(45) {
                    entries.remove(&id)
                } else {
                    None
                }
            };
            if let Some(e) = expired {
                e.receiver.close();
                let _ = on_view(webview, move |_| {
                    BUFFERS.with(|b| b.borrow_mut().remove(&id));
                    Ok(())
                })
                .await;
                break;
            }
        }
    });
    Ok(())
}
#[tauri::command]
pub async fn receive_answer(
    webview: Webview,
    service: State<'_, Shared>,
    id: String,
    sdp: String,
) -> Result<String, String> {
    let receiver = service.get(webview.label(), &id)?;
    receiver.answer(&sdp).await
}
#[tauri::command]
pub async fn receive_candidate(
    webview: Webview,
    service: State<'_, Shared>,
    id: String,
    candidate: IceCandidate,
) -> Result<(), String> {
    let receiver = service.get(webview.label(), &id)?;
    receiver.candidate(candidate).await
}
#[tauri::command]
pub async fn receive_stats(
    webview: Webview,
    service: State<'_, Shared>,
    id: String,
) -> Result<Value, String> {
    let receiver = service.get(webview.label(), &id)?;
    receiver.stats().await
}
#[tauri::command]
pub fn receive_renew(
    webview: Webview,
    service: State<'_, Shared>,
    id: String,
) -> Result<(), String> {
    let mut entries = service.0.lock().unwrap();
    let e = entries
        .get_mut(&id)
        .filter(|e| e.owner == webview.label())
        .ok_or("Native receiver closed")?;
    e.renewed = Instant::now();
    Ok(())
}
#[tauri::command]
pub fn receive_send(
    webview: Webview,
    service: State<'_, Shared>,
    id: String,
    label: String,
    data: String,
) -> Result<(), String> {
    service.get(webview.label(), &id)?.send(&label, &data)
}
#[tauri::command]
pub fn receive_audio(
    webview: Webview,
    service: State<'_, Shared>,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(
        service.get(webview.label(), &id)?.audio(),
    ))
}
#[tauri::command]
pub fn receive_visible(
    webview: Webview,
    service: State<'_, Shared>,
    id: String,
    visible: bool,
) -> Result<(), String> {
    service.get(webview.label(), &id)?.visible(visible);
    Ok(())
}
#[tauri::command]
pub async fn receive_frame(
    webview: Webview,
    service: State<'_, Shared>,
    id: String,
    after: u64,
) -> Result<Option<Frame>, String> {
    let owner = webview.label().to_owned();
    let receiver = service.get(&owner, &id)?;
    on_view(webview, move |_| {
        BUFFERS.with(|buffers| {
            let buffers = buffers.borrow();
            let b = buffers
                .get(&id)
                .filter(|b| b.owner == owner)
                .ok_or("Receive buffer closed")?;
            unsafe {
                let mut ptr = std::ptr::null_mut();
                b.shared.Buffer(&mut ptr).map_err(|e| e.to_string())?;
                if ptr.is_null() {
                    return Err("Receive buffer closed".into());
                }
                receiver.copy_frame(after, std::slice::from_raw_parts_mut(ptr, FRAME_CAPACITY))
            }
        })
    })
    .await
}
#[tauri::command]
pub async fn receive_close(
    webview: Webview,
    service: State<'_, Shared>,
    id: String,
) -> Result<(), String> {
    let owner = webview.label().to_owned();
    let removed = {
        let mut entries = service.0.lock().unwrap();
        if entries.get(&id).is_some_and(|e| e.owner == owner) {
            entries.remove(&id)
        } else {
            None
        }
    };
    if let Some(e) = removed {
        e.receiver.close();
    }
    on_view(webview, move |_| {
        BUFFERS.with(|b| {
            let mut b = b.borrow_mut();
            if b.get(&id).is_some_and(|b| b.owner == owner) {
                b.remove(&id);
            }
        });
        Ok(())
    })
    .await
}
