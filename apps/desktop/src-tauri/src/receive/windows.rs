use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{atomic::AtomicU64, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager, State, Webview};
use weblink_desktop_capture::{
    media::{IceCandidate, IceServer},
    receive::Receiver,
};
#[path = "buffers.rs"]
mod buffers;
#[path = "delivery.rs"]
mod delivery;
#[path = "shared_frame.rs"]
mod shared_frame;
#[path = "timing.rs"]
mod timing;
use delivery::Delivery;

pub fn release_script(key: &str, origins: &[tauri::Url]) -> String {
    let origins: Vec<_> = origins
        .iter()
        .map(|url| url.origin().ascii_serialization())
        .collect();
    include_str!("release.js")
        .replace("__INVOKE_KEY__", &serde_json::to_string(key).unwrap())
        .replace("__ORIGINS__", &serde_json::to_string(&origins).unwrap())
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ReleaseNotification {
    id: String,
    releases: Vec<delivery::Release>,
}
fn parse_release(body: &Value) -> Option<ReleaseNotification> {
    // Check bounds before allocating a vector from an untrusted notification.
    let id = body.get("id")?.as_str()?;
    let releases = body.get("releases")?.as_array()?;
    if id.is_empty()
        || id.len() > 128
        || releases.is_empty()
        || releases.len() > delivery::SLOT_COUNT
    {
        return None;
    }
    serde::Deserialize::deserialize(body).ok()
}
/// Tauri has already checked the invoke key, origin and command capability.
/// This notification intentionally has no response and registers no JS callback.
pub fn release_notification(invoke: &tauri::ipc::Invoke<tauri::Wry>) -> bool {
    if invoke.message.command() != "receive_release" {
        return false;
    }
    if let tauri::ipc::InvokeBody::Json(body) = invoke.message.payload() {
        if let Some(message) = parse_release(body) {
            let webview = invoke.message.webview_ref();
            if let Ok(delivery) = webview
                .state::<Shared>()
                .delivery(webview.label(), &message.id)
            {
                delivery.release(&message.releases);
            }
        }
    }
    true
}

struct Entry {
    owner: String,
    receiver: Arc<Receiver>,
    delivery: Arc<Delivery>,
    renewed: Instant,
}
#[derive(Default)]
pub struct Service {
    entries: Mutex<HashMap<String, Entry>>,
    // Shared by opens, so delayed notifications cannot acknowledge a reused id.
    next_lease: Arc<AtomicU64>,
}
pub type Shared = Arc<Service>;
impl Service {
    pub fn gpu_source(
        &self,
        owner: &str,
        id: &str,
    ) -> Result<Arc<weblink_desktop_capture::presentation::Source>, String> {
        self.get(owner, id)?
            .gpu
            .clone()
            .ok_or("Native GPU receive is unavailable".into())
    }
    fn get(&self, owner: &str, id: &str) -> Result<Arc<Receiver>, String> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .filter(|e| e.owner == owner)
            .map(|e| e.receiver.clone())
            .ok_or("Native receiver closed".into())
    }
    fn delivery(&self, owner: &str, id: &str) -> Result<Arc<Delivery>, String> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .filter(|e| e.owner == owner)
            .map(|e| e.delivery.clone())
            .ok_or("Native receiver closed".into())
    }
    pub fn clear(&self, owner: Option<&str>) {
        let removed = {
            let mut entries = self.entries.lock().unwrap();
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
            e.delivery.close();
        }
    }
}
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
    let _ = window.run_on_main_thread(move || buffers::clear(&owner));
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
    gpu: Option<bool>,
    events: Channel<Value>,
) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("Invalid receiver id".into());
    }
    let gpu = gpu.unwrap_or(false);
    let owner = webview.label().to_owned();
    let delivery = {
        let mut entries = service.entries.lock().unwrap();
        if entries.contains_key(&id) || entries.values().any(|e| e.owner == owner) {
            return Err("Native receiver is busy".into());
        }
        let wake = Arc::new(tokio::sync::Notify::new());
        let frame_wake = wake.clone();
        let forwarded = events.clone();
        let receiver = Receiver::new_with_presentation(
            ice_servers,
            relay_only,
            Arc::new(move |event| {
                if event["type"] == "frame" {
                    frame_wake.notify_one();
                    true
                } else {
                    forwarded.send(event).is_ok()
                }
            }),
            gpu,
        )?;
        let delivery = Delivery::new(receiver.clone(), events, wake, service.next_lease.clone());
        entries.insert(
            id.clone(),
            Entry {
                owner: owner.clone(),
                receiver,
                delivery: delivery.clone(),
                renewed: Instant::now(),
            },
        );
        delivery
    };
    let buffer_id = id.clone();
    let buffer_owner = owner.clone();
    let creating = delivery.clone();
    let result = if gpu {
        Ok(())
    } else {
        on_view(webview.clone(), move |view| {
            buffers::create(view, buffer_owner, buffer_id, creating)
        })
        .await
    };
    let attached = service
        .entries
        .lock()
        .unwrap()
        .get(&id)
        .is_some_and(|entry| Arc::ptr_eq(&entry.delivery, &delivery));
    if result.is_err() || !attached {
        {
            let mut entries = service.entries.lock().unwrap();
            if entries
                .get(&id)
                .is_some_and(|entry| Arc::ptr_eq(&entry.delivery, &delivery))
            {
                entries.remove(&id);
            }
        }
        delivery.close();
        let error = result
            .err()
            .unwrap_or_else(|| "Native receiver closed during startup".into());
        let _ = on_view(webview, move |_| {
            buffers::remove(&owner, &id, &delivery);
            Ok(())
        })
        .await;
        return Err(error);
    }
    if !gpu {
        delivery.start();
    }
    let weak = Arc::downgrade(&service);
    let opened = Arc::downgrade(&delivery);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(15)).await;
            let Some(service) = weak.upgrade() else { break };
            let expired = {
                let mut entries = service.entries.lock().unwrap();
                let Some(e) = entries.get(&id) else { break };
                if !opened.ptr_eq(&Arc::downgrade(&e.delivery)) {
                    break;
                }
                if e.renewed.elapsed() > Duration::from_secs(45) {
                    entries.remove(&id)
                } else {
                    None
                }
            };
            if let Some(e) = expired {
                e.delivery.close();
                let _ = on_view(webview, move |_| {
                    buffers::remove(&e.owner, &id, &e.delivery);
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
    let delivery = service.delivery(webview.label(), &id)?;
    let mut reports = receiver.stats().await?;
    if let Some(reports) = reports.as_array_mut() {
        for report in reports {
            if report["type"] == "inbound-rtp" && report["kind"] == "video" {
                report["nativeReceive"] = if receiver.gpu.is_some() {
                    serde_json::json!({"mode":"gpu", "slots":0, "decodedFrames":receiver.decoded_frames()})
                } else {
                    delivery.stats()
                };
            }
        }
    }
    Ok(reports)
}
#[tauri::command]
pub fn receive_renew(
    webview: Webview,
    service: State<'_, Shared>,
    id: String,
) -> Result<(), String> {
    let mut entries = service.entries.lock().unwrap();
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
    service.delivery(webview.label(), &id)?.visible(visible);
    Ok(())
}
#[tauri::command]
pub async fn receive_close(
    webview: Webview,
    service: State<'_, Shared>,
    id: String,
) -> Result<(), String> {
    let owner = webview.label().to_owned();
    let removed = {
        let mut entries = service.entries.lock().unwrap();
        if entries.get(&id).is_some_and(|e| e.owner == owner) {
            entries.remove(&id)
        } else {
            None
        }
    };
    if let Some(e) = removed {
        e.delivery.close();
        on_view(webview, move |_| {
            buffers::remove(&owner, &id, &e.delivery);
            Ok(())
        })
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn release_notifications_are_bounded_and_strict() {
        let body = json!({"id":"receiver","releases":[{"slot":0,"lease":1},{"slot":1,"lease":2}]});
        assert_eq!(parse_release(&body).unwrap().releases.len(), 2);
        for body in [
            json!({"id":"","releases":[{"slot":0,"lease":1}]}),
            json!({"id":"receiver","releases":[]}),
            json!({"id":"receiver","releases":vec![json!({"slot":0,"lease":1});3]}),
            json!({"id":"receiver","releases":[{"slot":0,"lease":-1}]}),
            json!({"id":"receiver","releases":[{"slot":0,"lease":1,"other":true}]}),
            json!({"id":"receiver","releases":[{"slot":0,"lease":1}],"other":true}),
        ] {
            assert!(parse_release(&body).is_none());
        }
    }
}
