//! Single-owner authorization + pressed-state machine. All device calls are serialized.
use crate::{
    authorization::{Authority, Backend, Binding, Grant, RequestResult},
    input::*,
    protocol::Signal,
};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

pub const MAX_INPUT_AGE: Duration = Duration::from_millis(100);

/// Implementations must not block on frontend/network work. Err may mean partial insertion.
pub trait Device {
    fn available(&self) -> bool;
    fn geometry_current(&self, geometry: Geometry) -> bool;
    fn ready_to_approve(&self) -> bool;
    fn physically_held(&self, held: Held) -> bool;
    fn submit(&mut self, actions: &[Action]) -> Result<(), Error>;
}
#[derive(Clone, Debug)]
pub struct TrustedTarget {
    pub binding: Binding,
    pub geometry: Geometry,
}
struct InputState<D: Device> {
    device: D,
    targets: HashMap<String, TrustedTarget>,
    held: Vec<Held>,
    unicode: Option<u16>,
    failure: Option<Error>,
    submitted: u64,
}
impl<D: Device> InputState<D> {
    fn release_action(&mut self, action: Action) -> bool {
        // Cleanup must not double-panic while unwinding a failed device operation.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.device.submit(&[action])
        }))
        .is_ok_and(|result| result.is_ok())
    }
    fn release_all(&mut self) -> bool {
        let mut ok = true;
        if let Some(unit) = self.unicode.take() {
            ok &= self.release_action(Action::Unicode { unit, down: false });
        }
        // Reverse order releases ordinary keys before their modifiers. Never release local ownership.
        for held in std::mem::take(&mut self.held).into_iter().rev() {
            if !self.device.physically_held(held) {
                ok &= self.release_action(held.up());
            }
        }
        if !ok {
            self.failure = Some(Error::Release);
        }
        ok
    }
    fn apply(&mut self, grant: &Grant, event: Event) -> Result<(), Error> {
        let geometry = self
            .targets
            .get(&grant.binding.target.media_id)
            .ok_or(Error::Unavailable)?
            .geometry;
        let mut actions = Vec::with_capacity(3);
        let mut transition = None;
        let move_to = |p| {
            geometry
                .absolute(p)
                .map(|(x, y)| Action::Move { x, y })
                .ok_or(Error::Invalid)
        };
        match event {
            Event::Move(p) => actions.push(move_to(p)?),
            Event::Button {
                position,
                button,
                down,
            } => {
                actions.push(move_to(position)?);
                transition = Some((Held::Button(button), down));
            }
            Event::Wheel {
                position,
                horizontal,
                vertical,
            } => {
                if !(-1200..=1200).contains(&horizontal) || !(-1200..=1200).contains(&vertical) {
                    return Err(Error::Invalid);
                }
                actions.push(move_to(position)?);
                if horizontal != 0 {
                    actions.push(Action::Wheel {
                        horizontal: true,
                        delta: horizontal,
                    });
                }
                if vertical != 0 {
                    actions.push(Action::Wheel {
                        horizontal: false,
                        delta: vertical,
                    });
                }
            }
            Event::Key { key, down } => transition = Some((Held::Key(key), down)),
            Event::Text(text) => {
                let started = Instant::now();
                if text.is_empty()
                    || text.len() > 256
                    || text.encode_utf16().count() > 64
                    || text.chars().any(char::is_control)
                    || !self.held.is_empty()
                {
                    return Err(Error::Invalid);
                }
                for unit in text.encode_utf16() {
                    if started.elapsed() > MAX_INPUT_AGE {
                        return Err(Error::Stale);
                    }
                    self.unicode = Some(unit); // also covers a partially inserted pair
                    self.device.submit(&[
                        Action::Unicode { unit, down: true },
                        Action::Unicode { unit, down: false },
                    ])?;
                    self.unicode = None;
                }
                self.submitted += 1;
                return Ok(());
            }
            Event::ReleaseAll => {
                return if self.release_all() {
                    Ok(())
                } else {
                    Err(Error::Release)
                }
            }
        }
        if let Some((held, down)) = transition {
            if down {
                if self.device.physically_held(held) {
                    return Err(Error::Unavailable);
                }
                if !self.held.contains(&held) {
                    // Record before SendInput, which may partially succeed.
                    self.held.push(held);
                } else if matches!(held, Held::Button(_)) {
                    return Ok(());
                }
                actions.push(match held {
                    Held::Key(key) => Action::Key { key, down },
                    Held::Button(button) => Action::Button { button, down },
                });
            } else if self.held.contains(&held) && !self.device.physically_held(held) {
                actions.push(held.up());
            }
        }
        self.device.submit(&actions)?;
        if let Some((held, false)) = transition {
            self.held.retain(|h| *h != held);
        }
        self.submitted += 1;
        Ok(())
    }
}
impl<D: Device> Backend for InputState<D> {
    fn is_current(&self, binding: &Binding) -> bool {
        self.failure.is_none()
            && self.device.available()
            && self
                .targets
                .get(&binding.target.media_id)
                .is_some_and(|t| t.binding == *binding && self.device.geometry_current(t.geometry))
    }
    fn release(&mut self, _: &Grant) -> bool {
        self.release_all()
    }
}
#[derive(Clone, Debug)]
pub struct Status {
    pub grant: Option<Grant>,
    pub failure: Option<Error>,
    pub closed: bool,
    pub submitted: u64,
}
pub struct Engine<D: Device> {
    authority: Authority<InputState<D>>,
}
impl<D: Device> Engine<D> {
    pub fn new(device: D) -> Self {
        Self {
            authority: Authority::new(InputState {
                device,
                targets: HashMap::new(),
                held: vec![],
                unicode: None,
                failure: None,
                submitted: 0,
            }),
        }
    }
    /// Local trusted owner only. Network/IPC callers must never construct this registration.
    pub fn register(&mut self, target: TrustedTarget) -> bool {
        if self.authority.is_closed() || !target.geometry.valid() {
            return false;
        }
        let state = self.authority.backend_mut();
        if !state.device.available() || !state.device.geometry_current(target.geometry) {
            return false;
        }
        let id = target.binding.target.media_id.clone();
        if let Some(old) = state.targets.get(&id) {
            return old.binding == target.binding && old.geometry == target.geometry;
        }
        if state.targets.len() >= 32 || !state.device.geometry_current(target.geometry) {
            return false;
        }
        let binding = target.binding.clone();
        state.targets.insert(id.clone(), target);
        if !self.authority.register(binding) {
            self.authority.backend_mut().targets.remove(&id);
            return false;
        }
        true
    }
    pub fn request(&mut self, media: &str, signal: &Signal, now: Instant) -> Option<RequestResult> {
        self.authority.request(media, signal, now)
    }
    pub fn approve(&mut self, consent: &str, now: Instant) -> Option<Signal> {
        self.authority.tick(now);
        if !self.authority.pending_matches(consent) {
            return None;
        }
        if !self.authority.backend_mut().device.ready_to_approve() {
            self.authority.revoke();
            return None;
        }
        self.authority.approve(consent, now)
    }
    pub fn renew(&mut self, grant: &Grant, now: Instant) -> bool {
        self.authority.renew(&grant.binding, &grant.id, now)
    }
    pub fn receive_end(&mut self, media: &str, signal: &Signal) -> bool {
        self.authority.receive_end(media, signal)
    }
    pub fn invalidate(&mut self, binding: &Binding) {
        self.authority.invalidate(binding);
        let targets = &mut self.authority.backend_mut().targets;
        if targets
            .get(&binding.target.media_id)
            .is_some_and(|t| t.binding == *binding)
        {
            targets.remove(&binding.target.media_id);
        }
    }
    pub fn input(&mut self, grant: &Grant, event: Event, now: Instant) -> Result<(), Error> {
        self.queued_input(grant, event, now, now)
    }
    pub fn queued_input(
        &mut self,
        grant: &Grant,
        event: Event,
        queued: Instant,
        now: Instant,
    ) -> Result<(), Error> {
        if !self.authority.permits(&grant.binding, &grant.id, now) {
            return Err(Error::Unauthorized);
        }
        if now
            .checked_duration_since(queued)
            .is_none_or(|age| age > MAX_INPUT_AGE)
        {
            self.fail(Error::Stale);
            return Err(Error::Stale);
        }
        let result = self.authority.backend_mut().apply(grant, event);
        if let Err(error) = result {
            self.fail(error);
        }
        result
    }
    pub fn tick(&mut self, now: Instant) {
        self.authority.tick(now);
    }
    pub fn revoke(&mut self) {
        self.authority.revoke();
    }
    pub fn fail(&mut self, error: Error) {
        self.authority.backend_mut().failure = Some(error);
        self.shutdown();
    }
    pub fn shutdown(&mut self) {
        self.authority.shutdown();
    }
    pub fn status(&mut self) -> Status {
        let grant = self.authority.grant().cloned();
        let closed = self.authority.is_closed();
        let state = self.authority.backend_mut();
        Status {
            grant,
            closed,
            failure: state.failure,
            submitted: state.submitted,
        }
    }
}
