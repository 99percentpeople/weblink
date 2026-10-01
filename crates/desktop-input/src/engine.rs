//! Single-owner authorization + pressed-state machine. All device calls are serialized.
use crate::{
    authorization::{Authority, Backend, Binding, Grant, RequestResult},
    input::*,
    protocol::Signal,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub const MAX_INPUT_AGE: Duration = Duration::from_millis(100);

/// Implementations must not block on frontend/network work. Err may mean partial insertion.
pub trait Device {
    fn pan_supported(&self) -> bool {
        false
    }
    fn submit_pan(&mut self, _: crate::pan::Pan) -> Result<(), Error> {
        Err(Error::Unavailable)
    }
    fn cancel_pan(&mut self) -> Result<(), Error> {
        Ok(())
    }
    /// Physical desktop coordinates, queried on the serialized native input thread.
    fn cursor_position(&self) -> Result<(i32, i32), Error> {
        Err(Error::Unavailable)
    }
    fn touch_supported(&self) -> bool {
        false
    }
    fn submit_touch(&mut self, _: &[crate::touch::Action]) -> Result<(), Error> {
        Err(Error::Unavailable)
    }
    fn cancel_touch(&mut self) -> Result<(), Error> {
        Ok(())
    }
    fn available(&self) -> bool;
    fn geometry_current(&self, geometry: Geometry) -> bool;
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
    invalidated: HashMap<String, Arc<AtomicBool>>,
    held: Vec<Held>,
    touches: crate::touch::Contacts,
    panning: bool,
    interrupted: bool,
    cursor: crate::trackpad::Cursor,
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
        self.touches.clear();
        self.panning = false;
        ok &= std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.device.cancel_pan()))
            .is_ok_and(|result| result.is_ok());
        self.cursor = Default::default();
        ok &= std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.device.cancel_touch()))
            .is_ok_and(|result| result.is_ok());
        if let Some(unit) = self.unicode.take() {
            ok &= self.release_action(Action::Unicode { unit, down: false });
        }
        // Release only inputs recorded for this grant, in reverse order (keys before modifiers).
        for held in std::mem::take(&mut self.held).into_iter().rev() {
            ok &= self.release_action(held.up());
        }
        if !ok {
            self.failure = Some(Error::Release);
        }
        ok
    }
    fn apply(&mut self, grant: &Grant, event: Event) -> Result<(), Error> {
        if self.panning
            && !matches!(
                event,
                Event::Trackpad(crate::trackpad::Event::Pan { .. }) | Event::ReleaseAll
            )
        {
            return Err(Error::Invalid);
        }
        if !self.touches.is_empty() && !matches!(event, Event::Touch(_) | Event::ReleaseAll) {
            return Err(Error::Invalid);
        }
        let geometry = self
            .targets
            .get(&grant.binding.target.media_id)
            .ok_or(Error::Unavailable)?
            .geometry;
        if let Event::Trackpad(crate::trackpad::Event::Pan { gesture }) = event {
            use crate::pan::Pan;
            if !gesture.valid() {
                return Err(Error::Invalid);
            }
            if !self.device.pan_supported() || !self.held.is_empty() || self.unicode.is_some() {
                return Err(Error::Unavailable);
            }
            match gesture {
                Pan::Start if !self.panning => {
                    // Pan targets the actual cursor, clamped to the authorized shared display.
                    let position = self.cursor.resolve(
                        crate::trackpad::Event::Move { x: 0.0, y: 0.0 },
                        self.device.cursor_position()?,
                        geometry,
                    )?;
                    let Event::Move(position) = position else {
                        unreachable!()
                    };
                    let (x, y) = geometry.absolute(position).ok_or(Error::Invalid)?;
                    self.device.submit(&[Action::Move { x, y }])?;
                    self.panning = true;
                }
                Pan::Update { .. } | Pan::End if self.panning => (),
                Pan::Cancel => (),
                _ => return Err(Error::Invalid),
            }
            self.device.submit_pan(gesture)?;
            if matches!(gesture, Pan::End | Pan::Cancel) {
                self.panning = false;
            }
            self.submitted += 1;
            return Ok(());
        }
        let event = if let Event::Trackpad(event) = event {
            self.cursor
                .resolve(event, self.device.cursor_position()?, geometry)?
        } else {
            self.cursor = Default::default();
            event
        };
        let mut actions = Vec::with_capacity(3);
        let mut transition = None;
        let move_to = |p| {
            geometry
                .absolute(p)
                .map(|(x, y)| Action::Move { x, y })
                .ok_or(Error::Invalid)
        };
        match event {
            Event::Trackpad(_) => unreachable!("resolved above"),
            Event::Touch(contacts) => {
                if !self.device.touch_supported() || !self.held.is_empty() || self.unicode.is_some()
                {
                    return Err(Error::Unavailable);
                }
                let actions = self.touches.frame(&contacts, geometry)?;
                self.device.submit_touch(&actions)?;
                self.submitted += 1;
                return Ok(());
            }
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
                if !crate::input::valid_text(&text) || !self.held.is_empty() {
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
            } else if self.held.contains(&held) {
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
            && !self
                .invalidated
                .get(&binding.target.media_id)
                .is_some_and(|flag| flag.load(Ordering::Acquire))
            && self.device.available()
            && self
                .targets
                .get(&binding.target.media_id)
                .is_some_and(|t| t.binding == *binding && self.device.geometry_current(t.geometry))
    }
    fn release(&mut self, _: &Grant) -> bool {
        self.interrupted = true;
        self.release_all()
    }
}
#[derive(Clone, Debug)]
pub struct Status {
    pub input_suspended: bool,
    pub pan_supported: bool,
    pub touch_supported: bool,
    pub pending_consent: Option<String>,
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
                invalidated: HashMap::new(),
                held: vec![],
                touches: Default::default(),
                panning: false,
                interrupted: false,
                cursor: Default::default(),
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
    /// Native media callbacks atomically invalidate before any queued input can execute.
    pub fn register_until(&mut self, target: TrustedTarget, invalidated: Arc<AtomicBool>) -> bool {
        if invalidated.load(Ordering::Acquire) {
            return false;
        }
        let id = target.binding.target.media_id.clone();
        let flags = &mut self.authority.backend_mut().invalidated;
        let inserted = !flags.contains_key(&id);
        if let Some(existing) = flags.get(&id) {
            if !Arc::ptr_eq(existing, &invalidated) {
                return false;
            }
        } else {
            flags.insert(id.clone(), invalidated);
        }
        if self.register(target) {
            true
        } else {
            if inserted {
                self.authority.backend_mut().invalidated.remove(&id);
            }
            false
        }
    }
    pub fn request(&mut self, media: &str, signal: &Signal, now: Instant) -> Option<RequestResult> {
        self.authority.request(media, signal, now)
    }
    pub fn approve(&mut self, consent: &str, now: Instant) -> Option<Signal> {
        self.authority.tick(now);
        if !self.authority.pending_matches(consent) {
            return None;
        }
        let approved = self.authority.approve(consent, now);
        if approved.is_some() {
            self.authority.backend_mut().interrupted = false;
        }
        approved
    }
    pub fn decline(&mut self, consent: &str) -> Option<Signal> {
        self.authority.decline(consent)
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
            self.authority
                .backend_mut()
                .invalidated
                .remove(&binding.target.media_id);
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
            self.interrupt();
            return Err(Error::Stale);
        }
        if self.authority.backend_mut().interrupted && !matches!(event, Event::ReleaseAll) {
            return Err(Error::Unauthorized);
        }
        let reset = matches!(event, Event::ReleaseAll);
        let result = self.authority.backend_mut().apply(grant, event);
        if reset && result.is_ok() {
            self.authority.backend_mut().interrupted = false;
        }
        if let Err(error) = result {
            self.fail(error);
        }
        result
    }
    pub fn tick(&mut self, now: Instant) {
        self.authority.tick(now);
    }
    /// Release interrupted gestures while retaining this connection's local consent.
    /// A fresh activation barrier is required before accepting further input.
    pub fn interrupt(&mut self) {
        let state = self.authority.backend_mut();
        state.interrupted = true;
        if !state.release_all() {
            self.fail(Error::Release);
        }
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
        let pending_consent = self.authority.pending_consent().map(str::to_owned);
        let state = self.authority.backend_mut();
        Status {
            input_suspended: state.interrupted,
            pan_supported: state.device.pan_supported(),
            touch_supported: state.device.touch_supported(),
            pending_consent,
            grant,
            closed,
            failure: state.failure,
            submitted: state.submitted,
        }
    }
}
