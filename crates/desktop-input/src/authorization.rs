//! One authority per host, shared by all viewers and sources. Call from one native actor.
use crate::protocol::{valid_id, DenialReason, Signal, Target, LEASE_MS, REQUEST_TIMEOUT_MS};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub room_generation: String,
    pub peer_generation: String,
    pub client_id: String,
    pub capture_session_id: String,
    pub target: Target,
}
impl Binding {
    fn valid(&self) -> bool {
        [
            &self.room_generation,
            &self.peer_generation,
            &self.client_id,
            &self.capture_session_id,
        ]
        .into_iter()
        .all(|id| valid_id(id))
            && self.target.valid()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub id: String,
    pub binding: Binding,
}
/// The native owner resolves active capture/peer/geometry; network data cannot register peers.
/// A real implementation must serialize release with injection before reporting completion.
pub trait Backend {
    fn is_current(&self, binding: &Binding) -> bool;
    /// False permanently closes this authority: OS cleanup could not be confirmed.
    fn release(&mut self, grant: &Grant) -> bool;
}

struct Pending {
    consent_id: String,
    request_id: String,
    binding: Binding,
    deadline: Instant,
}
enum State {
    Idle,
    Pending(Pending),
    Granted {
        grant: Grant,
        deadline: Option<Instant>,
    },
}
#[derive(Debug, PartialEq, Eq)]
pub enum RequestResult {
    /// Local-only token, distinct from the requester-supplied request ID.
    Pending {
        consent_id: String,
    },
    Reply(Signal),
    Duplicate,
}

pub struct Authority<B: Backend> {
    backend: B,
    bindings: HashMap<String, Binding>,
    seen: HashMap<(String, String), Instant>,
    state: State,
    closed: bool,
}
impl<B: Backend> Authority<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            bindings: HashMap::new(),
            seen: HashMap::new(),
            state: State::Idle,
            closed: false,
        }
    }
    /// Register only from the trusted local room/media owner, never an IPC/network payload.
    /// Reusing a media ID for a different generation requires explicit invalidation first.
    pub fn register(&mut self, binding: Binding) -> bool {
        if self.closed || !binding.valid() || !self.backend.is_current(&binding) {
            return false;
        }
        if let Some(existing) = self.bindings.get(&binding.target.media_id) {
            return existing == &binding;
        }
        if self.bindings.len() >= 32 {
            return false;
        }
        self.bindings
            .insert(binding.target.media_id.clone(), binding);
        true
    }
    pub fn request(
        &mut self,
        media_id: &str,
        signal: &Signal,
        now: Instant,
    ) -> Option<RequestResult> {
        if self.closed {
            return None;
        }
        self.tick(now);
        if self.closed {
            return None;
        }
        let Signal::Request { request_id, target } = signal else {
            return None;
        };
        if !signal.valid() {
            return None;
        }
        let deny = |reason| {
            Some(RequestResult::Reply(Signal::Deny {
                request_id: request_id.clone(),
                reason,
            }))
        };
        let Some(binding) = self
            .bindings
            .get(media_id)
            .filter(|binding| binding.target == *target && self.backend.is_current(binding))
            .cloned()
        else {
            return deny(DenialReason::Unavailable);
        };
        self.seen.retain(|_, deadline| *deadline > now);
        let key = (media_id.to_owned(), request_id.clone());
        if self.seen.contains_key(&key) {
            return Some(RequestResult::Duplicate);
        }
        if self.seen.len() >= 256 {
            return deny(DenialReason::Busy);
        }
        self.seen
            .insert(key, now + Duration::from_millis(REQUEST_TIMEOUT_MS));
        if !matches!(self.state, State::Idle) {
            return deny(DenialReason::Busy);
        }
        let consent_id = uuid::Uuid::new_v4().to_string();
        self.state = State::Pending(Pending {
            consent_id: consent_id.clone(),
            request_id: request_id.clone(),
            binding,
            deadline: now + Duration::from_millis(REQUEST_TIMEOUT_MS),
        });
        Some(RequestResult::Pending { consent_id })
    }
    /// Only an explicit local approval may call this. There is no remote "approve" handler.
    pub fn approve(&mut self, consent_id: &str, now: Instant) -> Option<Signal> {
        self.tick(now);
        if self.closed {
            return None;
        }
        if !matches!(&self.state, State::Pending(p) if p.consent_id == consent_id) {
            return None;
        }
        let State::Pending(pending) = std::mem::replace(&mut self.state, State::Idle) else {
            return None;
        };
        let grant = Grant {
            id: uuid::Uuid::new_v4().to_string(),
            binding: pending.binding,
        };
        let signal = Signal::Grant {
            request_id: pending.request_id,
            target: grant.binding.target.clone(),
            grant_id: grant.id.clone(),
            lease_ms: LEASE_MS,
        };
        self.state = State::Granted {
            grant,
            deadline: Some(now + Duration::from_millis(LEASE_MS)),
        };
        Some(signal)
    }
    pub fn decline(&mut self, consent_id: &str) -> Option<Signal> {
        if !matches!(&self.state, State::Pending(p) if p.consent_id == consent_id) {
            return None;
        }
        let State::Pending(pending) = std::mem::replace(&mut self.state, State::Idle) else {
            return None;
        };
        Some(Signal::Deny {
            request_id: pending.request_id,
            reason: DenialReason::Declined,
        })
    }
    /// Only cancel/revoke messages from the exact registered connection affect this authority.
    pub fn receive_end(&mut self, media_id: &str, signal: &Signal) -> bool {
        if !signal.valid() {
            return false;
        }
        let matches = match (&self.state, signal) {
            (State::Pending(p), Signal::Cancel { request_id }) => {
                p.binding.target.media_id == media_id && p.request_id == *request_id
            }
            (State::Granted { grant, .. }, Signal::Revoke { grant_id, .. }) => {
                grant.binding.target.media_id == media_id && grant.id == *grant_id
            }
            _ => false,
        };
        if matches {
            self.revoke();
        }
        matches
    }
    pub fn permits(&mut self, binding: &Binding, grant_id: &str, now: Instant) -> bool {
        self.tick(now);
        !self.closed
            && matches!(&self.state, State::Granted { grant, deadline: Some(_) } if grant.id == grant_id && grant.binding == *binding)
    }
    pub fn renew(&mut self, binding: &Binding, grant_id: &str, now: Instant) -> bool {
        self.tick(now);
        if self.closed
            || !matches!(&self.state, State::Granted { grant, .. } if grant.id == grant_id && grant.binding == *binding)
        {
            return false;
        }
        if let State::Granted { deadline, .. } = &mut self.state {
            *deadline = Some(now + Duration::from_millis(LEASE_MS));
        }
        true
    }
    pub fn invalidate(&mut self, binding: &Binding) {
        if self.bindings.get(&binding.target.media_id) != Some(binding) {
            return;
        }
        self.bindings.remove(&binding.target.media_id);
        let current = match &self.state {
            State::Idle => false,
            State::Pending(p) => p.binding == *binding,
            State::Granted { grant, .. } => grant.binding == *binding,
        };
        if current {
            self.revoke();
        }
    }
    pub fn tick(&mut self, now: Instant) {
        if self.closed {
            return;
        }
        let invalid = match &self.state {
            State::Idle => false,
            State::Pending(p) => now >= p.deadline || !self.backend.is_current(&p.binding),
            State::Granted { grant, .. } => !self.backend.is_current(&grant.binding),
        };
        if invalid {
            self.revoke();
            return;
        }
        if let State::Granted { grant, deadline } = &mut self.state {
            if deadline.is_some_and(|at| now >= at) {
                // A liveness gap releases input once, but consent belongs to the
                // connection. Renewing it never restores an ended/replaced grant.
                *deadline = None;
                self.closed = true;
                self.closed = !self.backend.release(grant);
            }
        }
    }
    pub fn revoke(&mut self) {
        // Invalidate first: even a failed/panicking release cannot leave permission active.
        if let State::Granted { grant, .. } = std::mem::replace(&mut self.state, State::Idle) {
            let closed = self.closed;
            self.closed = true;
            let released = self.backend.release(&grant);
            self.closed = closed || !released;
        }
    }
    pub fn shutdown(&mut self) {
        self.closed = true;
        self.bindings.clear();
        self.revoke();
    }
    pub fn is_closed(&self) -> bool {
        self.closed
    }
    pub fn pending_consent(&self) -> Option<&str> {
        match &self.state {
            State::Pending(p) if !self.closed => Some(&p.consent_id),
            _ => None,
        }
    }
    pub fn grant(&self) -> Option<&Grant> {
        match &self.state {
            State::Granted { grant, .. } if !self.closed => Some(grant),
            _ => None,
        }
    }
    pub(crate) fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }
    pub(crate) fn pending_matches(&self, consent: &str) -> bool {
        !self.closed && matches!(&self.state, State::Pending(p) if p.consent_id == consent)
    }
}

impl<B: Backend> Drop for Authority<B> {
    fn drop(&mut self) {
        self.shutdown();
    }
}
