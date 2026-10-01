use super::*;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use weblink_desktop_capture::{geometry::PixelRect, media::control::Sender, CaptureService};
use weblink_desktop_input::{
    authorization::{Binding, Grant, RequestResult},
    engine::TrustedTarget,
    input::{Geometry, Rect},
    protocol::{self, Signal, Target},
    windows::Worker,
    wire::{self, Sequencer},
};
fn error(e: weblink_desktop_input::input::Error) -> String {
    format!("Native input: {e:?}")
}
const LEASE: Duration = Duration::from_secs(2);
struct Queue {
    reliable: VecDeque<(Instant, Vec<u8>)>,
    movement: Option<(Instant, Vec<u8>)>,
}
struct Endpoint {
    closed: Arc<AtomicBool>,
    sender: Mutex<Option<Arc<dyn Sender>>>,
    queue: Mutex<Queue>,
}
impl Endpoint {
    fn new() -> Self {
        Self {
            closed: Arc::new(AtomicBool::new(false)),
            sender: Mutex::new(None),
            queue: Mutex::new(Queue {
                reliable: VecDeque::new(),
                movement: None,
            }),
        }
    }
    fn send(&self, value: &impl Serialize) -> bool {
        let ok = !self.closed.load(Ordering::Acquire)
            && serde_json::to_vec(value).ok().is_some_and(|data| {
                self.sender
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                    .is_some_and(|sender| sender.send(&data))
            });
        if !ok {
            self.closed();
        }
        ok
    }
    fn dispose(&self) {
        self.closed();
        let sender = self.sender.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(sender) = sender {
            sender.close();
        }
    }
    fn pop(&self) -> Option<(bool, Instant, Vec<u8>)> {
        let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        q.reliable
            .pop_front()
            .map(|(at, data)| (false, at, data))
            .or_else(|| q.movement.take().map(|(at, data)| (true, at, data)))
    }
}
impl Port for Endpoint {
    fn opened(&self, sender: Arc<dyn Sender>) {
        *self.sender.lock().unwrap_or_else(|e| e.into_inner()) = Some(sender);
    }
    fn message(&self, movement: bool, data: &[u8]) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        if data.len() > protocol::MAX_MESSAGE_BYTES || (!movement && q.reliable.len() >= 128) {
            self.closed();
            return;
        }
        if movement {
            q.movement = Some((Instant::now(), data.to_vec()));
        } else {
            q.reliable.push_back((Instant::now(), data.to_vec()));
        }
    }
    fn closed(&self) {
        self.closed.store(true, Ordering::Release);
    }
}
struct Peer {
    binding: Binding,
    endpoint: Arc<Endpoint>,
    capture: Arc<CaptureService>,
    ready: bool,
    last_geometry: Instant,
}
struct Consent {
    view: Pending,
    media: String,
    requested: Instant,
}
struct Active {
    grant: Grant,
    sequencer: Sequencer,
}
struct Host {
    worker: Worker,
    peers: HashMap<String, Peer>,
    pending: Option<Consent>,
    active: Option<Active>,
}
impl Host {
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            pending: self.pending.as_ref().map(|p| p.view.clone()),
            client_id: self
                .active
                .as_ref()
                .map(|a| a.grant.binding.client_id.clone()),
            closed: self.worker.status().closed,
        }
    }
    fn end_grant(&mut self) {
        if let Some(active) = self.active.take() {
            if let Some(peer) = self.peers.get(&active.grant.binding.target.media_id) {
                peer.endpoint.send(&Signal::Revoke {
                    grant_id: active.grant.id,
                    reason: protocol::RevocationReason::Local,
                });
            }
        }
    }
    fn tick(&mut self) {
        let now = Instant::now();
        if self.pending.as_ref().is_some_and(|p| {
            self.worker.status().pending_consent.as_deref() != Some(&p.view.consent_id)
        }) {
            self.pending = None;
        }
        if self.worker.status().grant.as_ref() != self.active.as_ref().map(|a| &a.grant) {
            self.end_grant();
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|p| now.duration_since(p.requested) >= Duration::from_secs(30))
        {
            self.pending = None;
        }
        let ids: Vec<_> = self.peers.keys().cloned().collect();
        for id in ids {
            let peer = self.peers.get_mut(&id).unwrap();
            if now.duration_since(peer.last_geometry) >= Duration::from_millis(100) {
                peer.last_geometry = now;
                if !peer
                    .capture
                    .display_geometry(peer.binding.capture_session_id.clone())
                    .is_ok_and(|l| l.revision == peer.binding.target.geometry_revision)
                {
                    peer.endpoint.closed();
                }
            }
            if self.worker.status().closed {
                peer.endpoint.closed();
            }
            if peer.endpoint.closed.load(Ordering::Acquire) {
                let peer = self.peers.remove(&id).unwrap();
                peer.endpoint.dispose();
                let _ = self.worker.invalidate(peer.binding);
                if self.pending.as_ref().is_some_and(|p| p.media == id) {
                    self.pending = None;
                }
                if self
                    .active
                    .as_ref()
                    .is_some_and(|a| a.grant.binding.target.media_id == id)
                {
                    self.end_grant();
                }
                continue;
            }
            if !peer.ready
                && peer
                    .endpoint
                    .sender
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .is_some()
            {
                peer.ready=peer.endpoint.send(&serde_json::json!({"type":"ready","target":peer.binding.target,"generation":id}));
            }
            let endpoint = peer.endpoint.clone();
            for _ in 0..32 {
                let Some((movement, at, data)) = endpoint.pop() else {
                    break;
                };
                // Never execute a delayed burst of input, even if heartbeats are queued behind it.
                if at.elapsed() > Duration::from_millis(100) {
                    endpoint.closed();
                    break;
                }
                self.message(&id, movement, &data, at);
                if endpoint.closed.load(Ordering::Acquire) {
                    break;
                }
            }
        }
    }
    fn message(&mut self, id: &str, movement: bool, data: &[u8], at: Instant) {
        let Some(peer) = self.peers.get(id) else {
            return;
        };
        if !peer.ready {
            return;
        }
        if let Some(packet) = wire::parse(data) {
            let Some(active) = self
                .active
                .as_mut()
                .filter(|a| a.grant.binding == peer.binding)
            else {
                return;
            };
            let epoch = packet.input_epoch.clone();
            let events = active.sequencer.accept_at(packet, movement, at);
            if events.is_empty() {
                return;
            }
            for event in events {
                if self.worker.input(active.grant.clone(), event).is_err() {
                    peer.endpoint.closed();
                    return;
                }
            }
            // Acknowledge transitions only after native release completed, never merely queued.
            if !movement
                && self
                    .worker
                    .flush()
                    .is_ok_and(|s| s.grant.as_ref() == Some(&active.grant))
            {
                peer.endpoint.send(&serde_json::json!({"type":"state","grantId":active.grant.id,"inputEpoch":epoch,"active":active.sequencer.active()}));
            }
            return;
        }
        if movement {
            return;
        }
        let Ok(text) = std::str::from_utf8(data) else {
            peer.endpoint.closed();
            return;
        };
        if let Some(signal) = protocol::parse(text.as_bytes()) {
            match &signal {
                Signal::Request { .. } => match self.worker.request(id.into(), signal) {
                    Ok(Some(RequestResult::Pending { consent_id })) => {
                        let _ = self.worker.flush();
                        self.pending = Some(Consent {
                            view: Pending {
                                consent_id,
                                client_id: peer.binding.client_id.clone(),
                                source_id: peer.binding.target.source_id.clone(),
                            },
                            media: id.into(),
                            requested: Instant::now(),
                        })
                    }
                    Ok(Some(RequestResult::Reply(reply))) => {
                        peer.endpoint.send(&reply);
                    }
                    _ => {}
                },
                Signal::Cancel { .. } | Signal::Revoke { .. }
                    if self
                        .worker
                        .receive_end(id.into(), signal.clone())
                        .unwrap_or(false) =>
                {
                    self.pending = None;
                    self.end_grant();
                }
                _ => {}
            }
            return;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(data) else {
            return;
        };
        if value["type"] == "heartbeat" {
            if let Some(active) = self.active.as_ref().filter(|a| {
                a.grant.binding == peer.binding
                    && value["grantId"] == a.grant.id
                    && value["generation"] == id
                    && value["geometryRevision"] == peer.binding.target.geometry_revision
            }) {
                if self.worker.renew(active.grant.clone()).unwrap_or(false) {
                    peer.endpoint
                        .send(&serde_json::json!({"type":"heartbeat","grantId":active.grant.id}));
                }
            }
        }
    }
}
struct Owner {
    id: String,
    lease: Mutex<Instant>,
    alive: AtomicBool,
    host: Mutex<Host>,
    thread: Mutex<Option<JoinHandle<()>>>,
}
impl Owner {
    fn live(&self) -> bool {
        self.alive.load(Ordering::Acquire)
            && self
                .lease
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .elapsed()
                < LEASE
    }
    fn shutdown(&self) {
        self.alive.store(false, Ordering::Release);
        if let Some(t) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = t.join();
        }
    }
}
#[derive(Default)]
pub struct Service {
    owner: Mutex<Option<Arc<Owner>>>,
}
impl Service {
    fn owner(&self, id: &str) -> Result<Arc<Owner>, String> {
        self.owner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|o| o.id == id && o.live())
            .cloned()
            .ok_or_else(|| "Remote control owner expired".into())
    }
    pub fn open(&self) -> Result<String, String> {
        self.start(None)
    }
    fn start(&self, test_window: Option<usize>) -> Result<String, String> {
        let mut slot = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = slot.take() {
            old.shutdown();
        }
        let worker = Worker::start(test_window).map_err(error)?;
        let owner = Arc::new(Owner {
            id: uuid::Uuid::new_v4().to_string(),
            lease: Mutex::new(Instant::now()),
            alive: AtomicBool::new(true),
            host: Mutex::new(Host {
                worker,
                peers: HashMap::new(),
                pending: None,
                active: None,
            }),
            thread: Mutex::new(None),
        });
        let weak = Arc::downgrade(&owner);
        let thread = thread::Builder::new()
            .name("weblink-control".into())
            .spawn(move || {
                while let Some(owner) = weak.upgrade() {
                    if !owner.live() {
                        let mut h = owner.host.lock().unwrap_or_else(|e| e.into_inner());
                        for p in h.peers.values() {
                            p.endpoint.dispose();
                        }
                        h.worker.shutdown();
                        h.pending = None;
                        h.end_grant();
                        break;
                    }
                    owner.host.lock().unwrap_or_else(|e| e.into_inner()).tick();
                    drop(owner);
                    thread::sleep(Duration::from_millis(4));
                }
            })
            .map_err(|e| e.to_string())?;
        *owner.thread.lock().unwrap_or_else(|e| e.into_inner()) = Some(thread);
        let id = owner.id.clone();
        *slot = Some(owner);
        Ok(id)
    }
    pub fn close(&self) {
        let mut slot = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(owner) = slot.take() {
            owner.shutdown();
        }
    }
    pub fn end(&self, id: &str) {
        let mut slot = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|o| o.id == id) {
            if let Some(owner) = slot.take() {
                owner.shutdown();
            }
        }
    }
    pub fn status(&self, id: &str) -> Result<Snapshot, String> {
        let o = self.owner(id)?;
        *o.lease.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        let state = o.host.lock().unwrap_or_else(|e| e.into_inner()).snapshot();
        Ok(state)
    }
    pub fn revoke(&self, id: &str) -> Result<(), String> {
        let o = self.owner(id)?;
        let mut h = o.host.lock().unwrap_or_else(|e| e.into_inner());
        h.worker.revoke().map_err(error)?;
        h.pending = None;
        h.end_grant();
        Ok(())
    }
    pub fn approve(&self, id: &str, consent: &str, approve: bool) -> Result<(), String> {
        let o = self.owner(id)?;
        let mut h = o.host.lock().unwrap_or_else(|e| e.into_inner());
        h.tick();
        let p = h
            .pending
            .as_ref()
            .filter(|p| p.view.consent_id == consent)
            .ok_or("Control request expired")?;
        let media = p.media.clone();
        let signal = if approve {
            h.worker.approve(consent.into())
        } else {
            h.worker.decline(consent.into())
        }
        .map_err(error)?
        .ok_or("Control request expired or input unavailable")?;
        h.worker.flush().map_err(error)?;
        h.pending = None;
        if let Signal::Grant { grant_id, .. } = &signal {
            let binding = h.peers.get(&media).ok_or("Media ended")?.binding.clone();
            h.active = Some(Active {
                sequencer: Sequencer::new(
                    grant_id.clone(),
                    media.clone(),
                    binding.target.geometry_revision.clone(),
                ),
                grant: Grant {
                    id: grant_id.clone(),
                    binding,
                },
            });
        }
        if !h
            .peers
            .get(&media)
            .is_some_and(|p| p.endpoint.send(&signal))
        {
            let _ = h.worker.revoke();
            h.end_grant();
            return Err("Control channel ended".into());
        }
        Ok(())
    }
    pub fn attach(
        &self,
        capture: Arc<CaptureService>,
        context: Context,
        session: String,
        media: String,
    ) -> Result<Arc<dyn Port>, String> {
        let o = self.owner(&context.owner_id)?;
        if ![
            &context.peer_generation,
            &context.client_id,
            &context.source_id,
            &media,
        ]
        .into_iter()
        .all(|s| protocol::valid_id(s))
        {
            return Err("Invalid local control binding".into());
        }
        let layout = capture.display_geometry(session.clone())?;
        let status = capture.status(session.clone())?;
        let source = status.source.ok_or("Capture stopped")?;
        let display = layout
            .displays
            .iter()
            .find(|d| d.source_id == source.id)
            .ok_or("Display unavailable")?;
        let rect = |r: &PixelRect| Rect {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
        };
        let binding = Binding {
            room_generation: o.id.clone(),
            peer_generation: context.peer_generation,
            client_id: context.client_id,
            capture_session_id: session,
            target: Target {
                source_id: context.source_id,
                media_id: media.clone(),
                geometry_revision: layout.revision,
            },
        };
        let endpoint = Arc::new(Endpoint::new());
        let mut h = o.host.lock().unwrap_or_else(|e| e.into_inner());
        if h.peers.contains_key(&media)
            || !h
                .worker
                .register_until(
                    TrustedTarget {
                        binding: binding.clone(),
                        geometry: Geometry {
                            display: rect(&display.bounds),
                            desktop: rect(&layout.virtual_bounds),
                        },
                    },
                    endpoint.closed.clone(),
                )
                .map_err(error)?
        {
            return Err("Native control binding unavailable".into());
        }
        h.peers.insert(
            media,
            Peer {
                binding,
                endpoint: endpoint.clone(),
                capture,
                ready: false,
                last_geometry: Instant::now(),
            },
        );
        Ok(endpoint)
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
#[allow(dead_code)]
#[path = "../../../../../crates/desktop-input/examples/support/mod.rs"]
mod test_window;
#[cfg(test)]
mod tests;
