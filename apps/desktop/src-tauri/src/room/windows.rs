use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tauri::{
    ipc::{Channel, InvokeBody, InvokeResponseBody, Request, Response},
    State, Webview,
};
use weblink_desktop_capture::{
    media::{IceCandidate, IceServer},
    room_peer::{CaptureSource, ChannelOptions, RoomPeer},
};

#[derive(Default)]
pub struct Service {
    peers: Mutex<HashMap<(String, String), Entry>>,
    sources: Mutex<HashMap<(String, String), Arc<CaptureSource>>>,
}
struct Entry {
    remote: String,
    peer: Arc<RoomPeer>,
    pending: Arc<AtomicUsize>,
}
impl Service {
    fn get(&self, owner: &str, id: &str) -> Result<Arc<RoomPeer>, String> {
        self.peers
            .lock()
            .unwrap()
            .get(&(owner.into(), id.into()))
            .map(|e| e.peer.clone())
            .ok_or_else(|| "Room connection closed".into())
    }
    fn source(&self, owner: &str, id: &str) -> Result<Arc<CaptureSource>, String> {
        self.sources
            .lock()
            .unwrap()
            .get(&(owner.into(), id.into()))
            .cloned()
            .ok_or_else(|| "Meeting capture stopped".into())
    }
    pub fn gpu_source(
        &self,
        owner: &str,
        id: &str,
    ) -> Result<Arc<weblink_desktop_capture::presentation::Source>, String> {
        let (peer, key) = id.split_once('/').ok_or("Invalid room video handle")?;
        self.get(owner, peer)?
            .output(key.parse().map_err(|_| "Invalid room track")?)
            .and_then(|o| o.gpu.clone())
            .ok_or_else(|| "Room video ended".into())
    }
    pub fn clear(&self, owner: Option<&str>) {
        let mut peers = self.peers.lock().unwrap();
        let keys: Vec<_> = peers
            .keys()
            .filter(|(o, _)| owner.is_none_or(|v| o == v))
            .cloned()
            .collect();
        let removed: Vec<_> = keys.iter().filter_map(|key| peers.remove(key)).collect();
        drop(peers);
        for e in removed {
            e.peer.close();
        }
        self.sources
            .lock()
            .unwrap()
            .retain(|(o, _), _| owner.is_some_and(|v| v != o));
    }
}

#[tauri::command]
pub async fn room_open(
    webview: Webview,
    state: State<'_, Service>,
    id: String,
    remote_id: String,
    ice_servers: Vec<IceServer>,
    relay: bool,
    events: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "Invalid room handle")?;
    let owner = webview.label().to_owned();
    let mut peers = state.peers.lock().unwrap();
    let key = (owner, id);
    if remote_id.is_empty()
        || remote_id.len() > 256
        || peers.len() >= 128
        || peers.contains_key(&key)
        || peers
            .iter()
            .any(|((o, _), entry)| o == &key.0 && entry.remote == remote_id)
    {
        return Err("Room connection limit or duplicate handle".into());
    }
    let dispatch = events.clone();
    let pending = Arc::new(AtomicUsize::new(0));
    let bytes = pending.clone();
    let peer = RoomPeer::open(
        ice_servers,
        relay,
        Arc::new(move |v| {
            dispatch
                .send(InvokeResponseBody::Json(v.to_string()))
                .is_ok()
        }),
        Arc::new(move |key, data, binary| {
            let size = 5 + data.len();
            if bytes.fetch_add(size, Ordering::AcqRel) + size > 32 * 1024 * 1024 {
                bytes.fetch_sub(size, Ordering::AcqRel);
                return false;
            }
            let mut packet = Vec::with_capacity(size);
            packet.extend_from_slice(&key.to_le_bytes());
            packet.push(u8::from(binary));
            packet.extend_from_slice(data);
            if events.send(InvokeResponseBody::Raw(packet)).is_err() {
                bytes.fetch_sub(size, Ordering::AcqRel);
                return false;
            }
            true
        }),
    )?;
    peers.insert(
        key,
        Entry {
            remote: remote_id,
            peer,
            pending,
        },
    );
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Operation {
    Receive {
        allowed: bool,
    },
    Local,
    Remote {
        kind: String,
        sdp: String,
    },
    Configure {
        servers: Vec<IceServer>,
        relay: bool,
    },
    Candidate {
        candidate: IceCandidate,
    },
    Channel {
        key: u32,
        options: ChannelOptions,
    },
    CloseChannel {
        key: u32,
    },
    Codecs {
        track: String,
        codecs: Vec<String>,
    },
    Limits {
        track: String,
        bitrate: Option<u64>,
        fps: Option<f64>,
        scale: Option<f64>,
        degradation: Option<String>,
    },
    DetachScreen {
        track: String,
    },
    ScreenReady {
        track: String,
    },
    Stats,
    Close,
    Ack {
        bytes: usize,
    },
    OpenSource {
        source: String,
        kind: String,
        channels: u32,
    },
    CloseSource {
        source: String,
    },
    Add {
        track: String,
        source: String,
        streams: Option<Vec<String>>,
    },
    Remove {
        track: String,
    },
}
#[tauri::command]
pub async fn room_operation(
    webview: Webview,
    state: State<'_, Service>,
    id: String,
    operation: Operation,
) -> Result<Value, String> {
    let owner = webview.label();
    if let Operation::Close = operation {
        let entry = state.peers.lock().unwrap().remove(&(owner.into(), id));
        if let Some(e) = entry {
            e.peer.close();
        }
        return Ok(Value::Null);
    }
    // Source leases belong to the page and may outlive the peer which first used them.
    if let Operation::CloseSource { source } = operation {
        state
            .sources
            .lock()
            .unwrap()
            .remove(&(owner.into(), source));
        return Ok(Value::Null);
    }
    let peer = state.get(owner, &id)?;
    match operation {
        Operation::Receive { allowed } => peer.receive_allowed(allowed),
        Operation::Local => {
            let description = peer.local_description().await?;
            return Ok(json!({"description":description,"mids":peer.mids()}));
        }
        Operation::Remote { kind, sdp } => {
            peer.remote_description(&kind, &sdp).await?;
            return Ok(json!(peer.mids()));
        }
        Operation::Configure { servers, relay } => peer.configure(servers, relay)?,
        Operation::Candidate { candidate } => peer.candidate(candidate).await?,
        Operation::Channel { key, options } => peer.create_channel(key, options)?,
        Operation::CloseChannel { key } => peer.close_channel(key),
        Operation::Codecs { track, codecs } => peer.set_codecs(&track, &codecs)?,
        Operation::Limits {
            track,
            bitrate,
            fps,
            scale,
            degradation,
        } => peer.set_limits(&track, bitrate, fps, scale, degradation.as_deref())?,
        Operation::DetachScreen { track } => peer.detach_screen(&track),
        Operation::ScreenReady { track } => peer.screen_ready(&track),
        Operation::Stats => return peer.stats().await,
        Operation::Ack { bytes } => {
            if let Some(e) = state.peers.lock().unwrap().get(&(owner.into(), id)) {
                e.pending
                    .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                        Some(n.saturating_sub(bytes))
                    })
                    .ok();
            }
        }
        Operation::OpenSource {
            source,
            kind,
            channels,
        } => {
            uuid::Uuid::parse_str(&source).map_err(|_| "Invalid capture handle")?;
            let mut sources = state.sources.lock().unwrap();
            let key = (owner.into(), source);
            if sources.len() >= 64 || sources.contains_key(&key) {
                return Err("Capture limit or duplicate handle".into());
            }
            let capture = match kind.as_str() {
                "video" => CaptureSource::video(),
                "audio" => CaptureSource::audio(channels)?,
                _ => return Err("Unknown capture kind".into()),
            };
            sources.insert(key, Arc::new(capture));
        }
        Operation::Add {
            track,
            source,
            streams,
        } => {
            // Older adapters sent only a track ID and used it as the stream ID.
            let streams = streams.unwrap_or_else(|| vec![track.clone()]);
            peer.add_capture(&track, state.source(owner, &source)?.as_ref(), streams)?
        }
        Operation::Remove { track } => peer.remove_capture(&track)?,
        Operation::Close | Operation::CloseSource { .. } => unreachable!(),
    }
    Ok(Value::Null)
}

#[tauri::command]
pub async fn room_write(
    webview: Webview,
    state: State<'_, Service>,
    request: Request<'_>,
) -> Result<(), String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .ok_or("Missing room packet header")
    };
    let InvokeBody::Raw(data) = request.body() else {
        return Err("Expected binary room packet".into());
    };
    let id = header("x-weblink-handle")?;
    let owner = webview.label();
    match header("x-weblink-payload")? {
        "bgra" => state.source(owner, id)?.bgra_frame(
            header("x-width")?.parse().map_err(|_| "Invalid width")?,
            header("x-height")?.parse().map_err(|_| "Invalid height")?,
            data,
        ),
        "audio" => state.source(owner, id)?.audio_frame(data),
        format @ ("i420" | "nv12") => state.source(owner, id)?.yuv_frame(
            header("x-width")?.parse().map_err(|_| "Invalid width")?,
            header("x-height")?.parse().map_err(|_| "Invalid height")?,
            data,
            format == "nv12",
        ),
        kind @ ("binary" | "text") => state.get(owner, id)?.write(
            header("x-channel")?
                .parse()
                .map_err(|_| "Invalid channel")?,
            data,
            kind == "binary",
        ),
        _ => Err("Unknown room packet".into()),
    }
}
#[tauri::command]
pub fn room_audio(
    webview: Webview,
    state: State<'_, Service>,
    id: String,
    key: u32,
) -> Result<Response, String> {
    let output = state
        .get(webview.label(), &id)?
        .output(key)
        .ok_or("Room audio ended")?;
    Ok(Response::new(output.audio()))
}

#[tauri::command]
pub async fn room_screen(
    webview: Webview,
    state: State<'_, Service>,
    capture: State<'_, crate::capture::Service>,
    controls: State<'_, crate::remote_control::Shared>,
    id: String,
    session_id: String,
    track: String,
    codecs: weblink_desktop_capture::media::SendCodecs,
    control: Option<crate::remote_control::Context>,
) -> Result<(), String> {
    let peer = state.get(webview.label(), &id)?;
    let captures = capture.inner().clone();
    let media = crate::capture::run(capture, {
        let id = session_id.clone();
        move |s| s.media(id)
    })
    .await?;
    let port = if let Some(context) = control {
        let service = controls.inner().clone();
        let capture_id = session_id.clone();
        let peer_id = track.clone();
        tauri::async_runtime::spawn_blocking(move || {
            service.attach(captures, context, capture_id, peer_id)
        })
        .await
        .map_err(|e| e.to_string())?
        .ok()
    } else {
        None
    };
    let result = peer.attach_screen(&media, &track, &codecs, port.clone());
    if result.is_err() {
        if let Some(port) = port {
            port.closed();
        }
    }
    result
}
