//! Manual handoff is requested on an authenticated media binding and committed
//! only by local approval. A pending request never displaces the current grant.
use super::{
    host::{Consent, Host},
    input_error, ControllerKind, Pending,
};
use std::time::{Duration, Instant};
use weblink_desktop_input::protocol::{self, DenialReason, Signal};

impl Host {
    pub(super) fn handoff_message(&mut self, id: &str, data: &[u8], at: Instant) -> bool {
        let Some(signal) = protocol::parse(data) else {
            return false;
        };
        if let Signal::Cancel { request_id } = &signal {
            let before = self.pending.len();
            self.pending
                .retain(|p| !(p.handoff.is_some() && p.media == id && p.request_id == *request_id));
            return before != self.pending.len();
        }
        let Signal::Request { request_id, target } = signal else {
            return false;
        };
        let key = (id.to_owned(), request_id.clone());
        self.handoff_seen.retain(|_, expires| *expires > at);
        if self.handoff_seen.contains_key(&key) {
            return true;
        }
        let Some(active) = self.active.as_ref() else {
            return false;
        };
        let Some(peer) = self.peers.get(id) else {
            return false;
        };
        if !peer.ready
            || peer.endpoint.is_closed()
            || peer.binding.target != target
            || !peer.capture.is_current(&peer.binding)
            || peer.connection_generation.is_none()
        {
            return false;
        }
        let same_device = active.grant.binding.client_id == peer.binding.client_id
            && self
                .peers
                .get(&active.grant.binding.target.media_id)
                .is_some_and(|old| old.connection_generation == peer.connection_generation);
        if active.kind != ControllerKind::Automation && !same_device {
            return false;
        }
        if self.handoff_seen.len() >= 256
            || self.pending.len() >= 32
            || self
                .pending
                .iter()
                .any(|p| p.view.client_id == peer.binding.client_id)
        {
            peer.endpoint.send(&Signal::Deny {
                request_id,
                reason: DenialReason::Busy,
            });
            return true;
        }
        self.handoff_seen.insert(key, at + Duration::from_secs(60));
        self.pending.push(Consent {
            view: Pending {
                consent_id: uuid::Uuid::new_v4().to_string(),
                client_id: peer.binding.client_id.clone(),
                source_id: peer.binding.target.source_id.clone(),
                peer_generation: peer.binding.peer_generation.clone(),
            },
            media: id.to_owned(),
            request_id,
            requested: at,
            handoff: Some(active.grant.clone()),
        });
        true
    }

    pub(super) fn approve_handoff(
        &mut self,
        consent: &str,
        accepted: bool,
    ) -> Result<Signal, String> {
        let pending = self
            .pending
            .iter()
            .find(|p| p.view.consent_id == consent)
            .ok_or("Control request expired")?;
        let previous = pending.handoff.clone().ok_or("Control request expired")?;
        let media = pending.media.clone();
        let request_id = pending.request_id.clone();
        if !accepted {
            return Ok(Signal::Deny {
                request_id,
                reason: DenialReason::Declined,
            });
        }
        let active = self
            .active
            .as_ref()
            .filter(|a| a.grant == previous)
            .ok_or("Control owner changed")?;
        let remove_old = active.kind == ControllerKind::Automation;
        let peer = self
            .peers
            .get(&media)
            .filter(|p| !p.endpoint.is_closed() && p.capture.is_current(&p.binding))
            .ok_or("Control target ended")?;
        let request = Signal::Request {
            request_id,
            target: peer.binding.target.clone(),
        };
        let Some(signal @ Signal::Grant { .. }) = self
            .worker
            .approve_handoff(previous.clone(), media, request)
            .map_err(input_error)?
        else {
            return Err("Control target unavailable".into());
        };
        self.end_grant();
        if remove_old {
            self.remove_peer(&previous.binding.target.media_id);
        }
        Ok(signal)
    }
}
