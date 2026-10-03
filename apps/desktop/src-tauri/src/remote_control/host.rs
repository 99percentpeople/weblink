use super::{
    binding::GeometrySource, input_error, transport::Endpoint, ControlEvent, Observer, Pending,
    Snapshot,
};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use weblink_desktop_capture::media::control::Port;
use weblink_desktop_input::{
    authorization::{Binding, Grant, RequestResult},
    engine::TrustedTarget,
    protocol::{self, Signal},
    session::Session,
    wire::{self, Sequencer},
};
pub(super) struct Peer {
    pub(super) binding: Binding,
    pub(super) endpoint: Arc<Endpoint>,
    pub(super) capture: Arc<dyn GeometrySource>,
    pub(super) ready: bool,
    pub(super) last_geometry: Instant,
    cursor_visibility: bool,
    cursor_visible: bool,
}
impl Peer {
    fn set_cursor_visible(&mut self, visible: bool) {
        if self.cursor_visibility
            && self.cursor_visible != visible
            && self
                .capture
                .set_cursor_visible(&self.binding, visible)
                .is_ok()
        {
            self.cursor_visible = visible;
        }
    }
}
pub(super) struct Consent {
    pub(super) view: Pending,
    pub(super) media: String,
    pub(super) requested: Instant,
}
pub(super) struct Active {
    pub(super) grant: Grant,
    pub(super) sequencer: Sequencer,
}
pub(super) struct Host {
    pub(super) worker: Box<dyn Session>,
    pub(super) peers: HashMap<String, Peer>,
    pub(super) pending: Option<Consent>,
    pub(super) active: Option<Active>,
    pub(super) observer: Option<Observer>,
}
impl Host {
    pub(super) fn register(
        &mut self,
        capture: Arc<dyn GeometrySource>,
        target: TrustedTarget,
    ) -> Result<Arc<Endpoint>, String> {
        let binding = target.binding.clone();
        let media = binding.target.media_id.clone();
        let endpoint = Arc::new(Endpoint::new());
        if self.peers.contains_key(&media)
            || !self
                .worker
                .register_until(target, endpoint.closed.clone())
                .map_err(input_error)?
        {
            return Err("Native control binding unavailable".into());
        }
        self.peers.insert(
            media,
            Peer {
                cursor_visibility: capture.cursor_visibility_supported(&binding),
                cursor_visible: true,
                binding,
                endpoint: endpoint.clone(),
                capture,
                ready: false,
                last_geometry: Instant::now(),
            },
        );
        Ok(endpoint)
    }
    pub(super) fn snapshot(&self) -> Snapshot {
        Snapshot {
            pending: self.pending.as_ref().map(|p| p.view.clone()),
            client_id: self
                .active
                .as_ref()
                .map(|a| a.grant.binding.client_id.clone()),
            closed: self.worker.status().closed,
        }
    }
    pub(super) fn end_grant(&mut self) {
        if let Some(active) = self.active.take() {
            if let Some(peer) = self.peers.get_mut(&active.grant.binding.target.media_id) {
                peer.set_cursor_visible(true);
                peer.endpoint.send(&Signal::Revoke {
                    grant_id: active.grant.id.clone(),
                    reason: protocol::RevocationReason::Local,
                });
            }
            if let Some(observer) = &self.observer {
                observer(ControlEvent::Ended);
            }
        }
    }
    pub(super) fn remove_peer(&mut self, id: &str) {
        let Some(peer) = self.peers.get(id) else {
            return;
        };
        // Atomically invalidate input before waiting for the worker. Disposing
        // the endpoint also closes the viewer's control channels immediately.
        peer.endpoint.dispose();
        let _ = self.worker.invalidate(peer.binding.clone());
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
        self.peers.remove(id);
    }
    fn synchronize_input(&mut self) {
        if !self.worker.status().input_suspended {
            return;
        }
        if let Some(active) = self.active.as_mut().filter(|a| a.sequencer.active()) {
            active.sequencer.suspend();
            if let Some(peer) = self.peers.get_mut(&active.grant.binding.target.media_id) {
                peer.set_cursor_visible(true);
                peer.endpoint.send(&serde_json::json!({"type":"state","grantId":active.grant.id,"inputEpoch":active.sequencer.epoch(),"active":false}));
            }
        }
    }
    pub(super) fn tick(&mut self) {
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
        self.synchronize_input();
        let ids: Vec<_> = self.peers.keys().cloned().collect();
        for id in ids {
            let peer = self.peers.get_mut(&id).unwrap();
            if now.duration_since(peer.last_geometry) >= Duration::from_millis(100) {
                peer.last_geometry = now;
                if !peer.capture.is_current(&peer.binding) {
                    peer.endpoint.closed();
                }
            }
            if self.worker.status().closed {
                peer.endpoint.closed();
            }
            peer.endpoint.flush();
            if peer.endpoint.is_closed() {
                self.remove_peer(&id);
                continue;
            }
            if !peer.ready && peer.endpoint.is_open() {
                peer.ready = peer.endpoint.send(&serde_json::json!({
                    "type": "ready",
                    "target": peer.binding.target,
                    "generation": id,
                    "relativePointer": true,
                    "cursorVisibility": peer.cursor_visibility,
                    "persistentControl": true,
                    "keyboard": true,
                    "textInput": true,
                    "touchpadPan": self.worker.status().pan_supported,
                    "touchContacts": if self.worker.status().touch_supported { weblink_desktop_input::touch::MAX_CONTACTS } else { 0 },
                }));
            }
            let endpoint = peer.endpoint.clone();
            if endpoint.take_interrupted()
                && self
                    .active
                    .as_ref()
                    .is_some_and(|a| a.grant.binding.target.media_id == id)
            {
                let _ = self.worker.interrupt();
                self.synchronize_input();
            }
            for _ in 0..32 {
                let Some((movement, at, data)) = endpoint.pop() else {
                    break;
                };
                // Never execute a delayed burst of input, even if heartbeats are queued behind it.
                if at.elapsed() > Duration::from_millis(100) {
                    if let Some(packet) = wire::parse(&data) {
                        if self.active.as_ref().is_some_and(|a| {
                            a.grant.binding.target.media_id == id
                                && packet.grant_id == a.grant.id
                                && packet.generation == id
                                && packet.geometry_revision
                                    == a.grant.binding.target.geometry_revision
                                && a.sequencer.epoch() == Some(packet.input_epoch.as_str())
                                && a.sequencer.active()
                        }) {
                            let _ = self.worker.interrupt();
                            self.synchronize_input();
                        }
                        continue;
                    }
                }
                self.message(&id, movement, &data, at);
                if endpoint.is_closed() {
                    break;
                }
            }
        }
    }
    fn message(&mut self, id: &str, movement: bool, data: &[u8], at: Instant) {
        self.synchronize_input();
        let Some(peer) = self.peers.get_mut(id) else {
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
            let transition = matches!(
                packet.event,
                wire::PointerEvent::Activate | wire::PointerEvent::Pause
            );
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
            // Acknowledge only completed native input. Interruptions retain the
            // grant but invalidate this input epoch before accepting another gesture.
            if !movement {
                if let Ok(status) = self.worker.flush() {
                    if status.grant.as_ref() == Some(&active.grant) {
                        if status.input_suspended {
                            active.sequencer.suspend();
                        }
                        if !active.sequencer.active() {
                            peer.set_cursor_visible(true);
                        }
                        if transition || status.input_suspended || !active.sequencer.active() {
                            peer.endpoint.send(&serde_json::json!({"type":"state","grantId":active.grant.id,"inputEpoch":epoch,"active":active.sequencer.active()}));
                        }
                    }
                }
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
                                peer_generation: peer.binding.peer_generation.clone(),
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
        if value["type"] == "cursor" {
            let status = self.worker.status();
            if let Some(visible) = value["visible"].as_bool().filter(|_| {
                self.active.as_ref().is_some_and(|a| {
                    a.grant.binding == peer.binding
                        && value["grantId"] == a.grant.id
                        && value["generation"] == id
                        && value["geometryRevision"] == peer.binding.target.geometry_revision
                        && value["inputEpoch"].as_str() == a.sequencer.epoch()
                        && a.sequencer.active()
                        && status.grant.as_ref() == Some(&a.grant)
                        && !status.input_suspended
                })
            }) {
                peer.set_cursor_visible(visible);
            }
            return;
        }
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
