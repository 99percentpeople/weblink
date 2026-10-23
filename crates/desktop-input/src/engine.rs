//! Single-owner authorization + pressed-state machine. All device calls are serialized.
use crate::{
    authorization::{Authority, Backend, Binding, Grant, RequestResult},
    devices::{self, Capability, Key, Kind, Manager},
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
    fn reset_gamepad_feedback(&mut self, _slot: u8) {}
    /// Nonblocking snapshot of the latest output from each virtual gamepad.
    fn gamepad_feedback(&mut self) -> Vec<(u8, crate::gamepad::Rumble)> {
        vec![]
    }
    fn submit_gamepad(&mut self, _: u8, _: crate::gamepad::State) -> Result<(), Error> {
        Err(Error::Unavailable)
    }
    fn capabilities(&self) -> Vec<Capability> {
        vec![
            Capability::system(Kind::Keyboard, true),
            Capability::system(Kind::Mouse, true),
            Capability::system(Kind::Touchpad, self.pan_supported()),
            Capability::system(Kind::Touchscreen, self.touch_supported()),
            Capability::system(Kind::Gamepad, false),
        ]
    }
    fn refresh_capabilities(&mut self) {}
    fn mount(&mut self, _: Key) -> Result<(), Error> {
        Ok(())
    }
    fn unmount(&mut self, key: Key) -> Result<(), Error> {
        match key.kind {
            Kind::Touchpad => self.cancel_pan(),
            Kind::Touchscreen => self.cancel_touch(),
            _ => Ok(()),
        }
    }
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
    /// Insert committed text into a supported focused editor. False guarantees
    /// nothing was submitted; an error may be partial and must not be retried.
    fn insert_text(
        &mut self,
        _text: &str,
        _window: Option<&crate::window::BoundWindow>,
    ) -> Result<bool, Error> {
        Ok(false)
    }
}
#[derive(Clone, Debug)]
pub struct TrustedTarget {
    pub binding: Binding,
    pub geometry: Geometry,
}
struct InputState<D: Device> {
    device: Manager<D>,
    targets: HashMap<String, TrustedTarget>,
    invalidated: HashMap<String, Arc<AtomicBool>>,
    held: Vec<Held>,
    window: Option<crate::window::BoundWindow>,
    window_error: Option<Error>,
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
            self.device.backend.submit(&[action])
        }))
        .is_ok_and(|result| result.is_ok())
    }
    fn release_all(&mut self) -> bool {
        let mut ok = self.device.release_gamepads();
        self.touches.clear();
        self.panning = false;
        ok &= std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.device.backend.cancel_pan()
        }))
        .is_ok_and(|result| result.is_ok());
        self.cursor = Default::default();
        ok &= std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.device.backend.cancel_touch()
        }))
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
        self.device.suspend();
        ok
    }
    fn check_window(&self, point: Option<(i32, i32)>) -> Result<(), Error> {
        self.window
            .as_ref()
            .map_or(Ok(()), |window| window.check(point))
    }
    fn apply(&mut self, grant: &Grant, event: Event, now: Instant) -> Result<(), Error> {
        if let Event::ReleaseInputs(inputs) = event {
            for held in inputs.into_iter().rev() {
                if self.held.contains(&held) {
                    if !self.release_action(held.up()) {
                        return Err(Error::Release);
                    }
                    self.held.retain(|input| *input != held);
                }
            }
            return Ok(());
        }
        if self.window.is_some()
            && matches!(
                event,
                Event::Gamepad(_) | Event::Touch(_) | Event::Trackpad(_)
            )
        {
            return Err(Error::Invalid);
        }
        if let Event::Gamepad(event) = event {
            return self.device.gamepad(event, now);
        }
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
        let kind = match &event {
            Event::Key { .. } | Event::Text(_) => Some(Kind::Keyboard),
            Event::Touch(_) => Some(Kind::Touchscreen),
            Event::Trackpad(crate::trackpad::Event::Pan { .. }) => Some(Kind::Touchpad),
            Event::ReleaseAll => None,
            _ => Some(Kind::Mouse),
        };
        if let Some(kind) = kind {
            self.device.ensure(Key::single(kind))?;
        }
        if let Event::Trackpad(crate::trackpad::Event::Pan { gesture }) = event {
            use crate::pan::Pan;
            if !gesture.valid() {
                return Err(Error::Invalid);
            }
            if !self.device.backend.pan_supported()
                || !self.held.is_empty()
                || self.unicode.is_some()
            {
                return Err(Error::Unavailable);
            }
            match gesture {
                Pan::Start if !self.panning => {
                    // Pan targets the actual cursor, clamped to the authorized shared display.
                    let position = self.cursor.resolve(
                        crate::trackpad::Event::Move { x: 0.0, y: 0.0 },
                        self.device.backend.cursor_position()?,
                        geometry,
                    )?;
                    let Event::Move(position) = position else {
                        unreachable!()
                    };
                    let (x, y) = geometry.absolute(position).ok_or(Error::Invalid)?;
                    self.device.backend.submit(&[Action::Move { x, y }])?;
                    self.panning = true;
                }
                Pan::Update { .. } | Pan::End if self.panning => (),
                Pan::Cancel => (),
                _ => return Err(Error::Invalid),
            }
            self.device.backend.submit_pan(gesture)?;
            if matches!(gesture, Pan::End | Pan::Cancel) {
                self.panning = false;
            }
            self.submitted += 1;
            return Ok(());
        }
        let event = if let Event::Trackpad(event) = event {
            self.cursor
                .resolve(event, self.device.backend.cursor_position()?, geometry)?
        } else {
            self.cursor = Default::default();
            event
        };
        let point = match &event {
            Event::Move(p)
            | Event::Button { position: p, .. }
            | Event::Wheel { position: p, .. } => Some(geometry.pixels(*p).ok_or(Error::Invalid)?),
            _ => None,
        };
        if !matches!(event, Event::ReleaseAll) {
            self.check_window(point)?;
        }
        let mut actions = Vec::with_capacity(3);
        let mut transition = None;
        let move_to = |p| {
            geometry
                .absolute(p)
                .map(|(x, y)| Action::Move { x, y })
                .ok_or(Error::Invalid)
        };
        match event {
            Event::Gamepad(_) => unreachable!("handled above"),
            Event::Trackpad(_) => unreachable!("resolved above"),
            Event::Touch(contacts) => {
                if !self.device.backend.touch_supported()
                    || !self.held.is_empty()
                    || self.unicode.is_some()
                {
                    return Err(Error::Unavailable);
                }
                let actions = self.touches.frame(&contacts, geometry)?;
                self.device.backend.submit_touch(&actions)?;
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
                self.check_window(None)?;
                if self
                    .device
                    .backend
                    .insert_text(&text, self.window.as_ref())?
                {
                    self.submitted += 1;
                    return Ok(());
                }
                for unit in text.encode_utf16() {
                    if started.elapsed() > MAX_INPUT_AGE {
                        return Err(Error::Stale);
                    }
                    self.check_window(None)?;
                    self.unicode = Some(unit); // also covers a partially inserted pair
                    self.device.backend.submit(&[
                        Action::Unicode { unit, down: true },
                        Action::Unicode { unit, down: false },
                    ])?;
                    self.unicode = None;
                }
                self.submitted += 1;
                return Ok(());
            }
            Event::ReleaseInputs(_) => unreachable!("handled above"),
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
        self.check_window(point)?;
        self.device.backend.submit(&actions)?;
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
            && self.device.backend.available()
            && self.targets.get(&binding.target.media_id).is_some_and(|t| {
                t.binding == *binding && self.device.backend.geometry_current(t.geometry)
            })
    }
    fn release(&mut self, _: &Grant) -> bool {
        self.interrupted = true;
        let released = self.release_all();
        self.window = None;
        self.window_error = None;
        let unmounted = self.device.unmount_all();
        if !unmounted {
            self.failure = Some(Error::Release);
        }
        released && unmounted
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub held: Vec<Held>,
    pub window_bound: bool,
    /// A window-scope failure, distinct from revocation or a stalled input queue.
    pub window_error: Option<Error>,
    pub devices: devices::Snapshot,
    pub input_suspended: bool,
    pub pan_supported: bool,
    pub touch_supported: bool,
    pub pending_consents: Vec<String>,
    pub grant: Option<Grant>,
    pub failure: Option<Error>,
    pub closed: bool,
    pub submitted: u64,
}
pub struct Engine<D: Device> {
    authority: Authority<InputState<D>>,
}
impl<D: Device> Engine<D> {
    pub fn gamepad_feedback(&mut self, now: Instant) -> Vec<crate::gamepad::Feedback> {
        let Some(grant) = self.authority.grant().cloned() else {
            return vec![];
        };
        if !self.authority.permits(&grant.binding, &grant.id, now)
            || self.authority.backend_mut().interrupted
        {
            return vec![];
        }
        self.authority
            .backend_mut()
            .device
            .gamepad_feedback(now)
            .into_iter()
            .map(|(slot, id, rumble)| crate::gamepad::Feedback {
                grant: grant.clone(),
                slot,
                id,
                rumble,
            })
            .collect()
    }
    pub fn new(device: D) -> Self {
        Self {
            authority: Authority::new(InputState {
                device: Manager::new(device),
                targets: HashMap::new(),
                invalidated: HashMap::new(),
                held: vec![],
                window: None,
                window_error: None,
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
        if !state.device.backend.available()
            || !state.device.backend.geometry_current(target.geometry)
        {
            return false;
        }
        let id = target.binding.target.media_id.clone();
        if let Some(old) = state.targets.get(&id) {
            return old.binding == target.binding && old.geometry == target.geometry;
        }
        if state.targets.len() >= 32 || !state.device.backend.geometry_current(target.geometry) {
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
            self.authority.backend_mut().window_error = None;
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
    pub fn bind_window(
        &mut self,
        grant: &Grant,
        window: crate::window::BoundWindow,
        now: Instant,
    ) -> Result<(), Error> {
        if !self.authority.permits(&grant.binding, &grant.id, now) {
            return Err(Error::Unauthorized);
        }
        let state = self.authority.backend_mut();
        if state.window.is_some()
            || state.interrupted
            || !state.held.is_empty()
            || state.unicode.is_some()
            || state.panning
            || !state.touches.is_empty()
        {
            return Err(Error::Invalid);
        }
        window.activate()?;
        window.check(None)?;
        state.window = Some(window);
        Ok(())
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
        self.queued_input_inner(grant, event, queued, now, None, false)
    }
    /// A borrowed caller's window guard applies to this submission only.
    pub fn queued_input_scoped(
        &mut self,
        grant: &Grant,
        event: Event,
        queued: Instant,
        now: Instant,
        window: Option<crate::window::BoundWindow>,
    ) -> Result<(), Error> {
        self.queued_input_inner(grant, event, queued, now, window, true)
    }
    fn queued_input_inner(
        &mut self,
        grant: &Grant,
        event: Event,
        queued: Instant,
        now: Instant,
        window: Option<crate::window::BoundWindow>,
        scoped: bool,
    ) -> Result<(), Error> {
        if !self.authority.permits(&grant.binding, &grant.id, now) {
            return Err(Error::Unauthorized);
        }
        if now
            .checked_duration_since(queued)
            .is_none_or(|age| age > MAX_INPUT_AGE)
        {
            if !scoped {
                self.interrupt();
            }
            return Err(Error::Stale);
        }
        if self.authority.backend_mut().interrupted
            && !matches!(event, Event::ReleaseAll | Event::ReleaseInputs(_))
        {
            return Err(Error::Unauthorized);
        }
        let reset = matches!(event, Event::ReleaseAll);
        let gamepad = matches!(event, Event::Gamepad(_));
        let previous = window.map(|window| self.authority.backend_mut().window.replace(window));
        let result = self.authority.backend_mut().apply(grant, event, now);
        if let Some(previous) = previous {
            self.authority.backend_mut().window = previous;
        }
        if reset && result.is_ok() {
            self.authority.backend_mut().interrupted = false;
            self.authority.backend_mut().window_error = None;
        }
        if let Err(error) = result {
            if matches!(
                error,
                Error::WindowUnavailable | Error::WindowFocusLost | Error::WindowPointOutside
            ) {
                if !scoped {
                    self.interrupt();
                    self.authority.backend_mut().window_error = Some(error);
                }
                return Err(error);
            }
            if scoped && error == Error::Stale {
                return Err(error);
            }
            if error != Error::Unavailable || !gamepad {
                self.fail(error);
            }
        }
        result
    }
    pub fn tick(&mut self, now: Instant) {
        self.authority.tick(now);
        let state = self.authority.backend_mut();
        if !state.interrupted && state.window.is_some() {
            if let Err(error) = state.check_window(None) {
                self.interrupt();
                self.authority.backend_mut().window_error = Some(error);
            }
        }
        if !self.authority.backend_mut().device.expire_gamepads(now) {
            self.fail(Error::Release);
        }
    }
    pub(crate) fn wait_duration(&mut self, now: Instant) -> Option<Duration> {
        let wait = self.authority.wait_duration(now);
        if self.authority.backend_mut().window.is_some() {
            Some(
                wait.unwrap_or(Duration::from_millis(50))
                    .min(Duration::from_millis(50)),
            )
        } else {
            wait
        }
    }
    /// Release interrupted gestures while retaining this connection's local consent.
    /// A fresh activation barrier is required before accepting further input.
    pub fn interrupt(&mut self) {
        let state = self.authority.backend_mut();
        state.interrupted = true;
        state.window_error = None;
        if !state.release_all() {
            self.fail(Error::Release);
        }
    }
    pub fn revoke(&mut self) {
        self.authority.revoke();
    }
    /// Report whether this cleanup, rather than an earlier external revoke,
    /// ended the exact grant. The comparison and release share the actor turn.
    pub fn revoke_matching(&mut self, grant: &Grant) -> bool {
        if self.authority.grant() != Some(grant) {
            return false;
        }
        self.revoke();
        true
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
        let pending_consents = self.authority.pending_consents();
        let state = self.authority.backend_mut();
        Status {
            held: state.held.clone(),
            window_bound: state.window.is_some(),
            window_error: state.window_error,
            devices: state.device.snapshot(),
            input_suspended: state.interrupted,
            pan_supported: state.device.backend.pan_supported(),
            touch_supported: state.device.backend.touch_supported(),
            pending_consents,
            grant,
            closed,
            failure: state.failure,
            submitted: state.submitted,
        }
    }
    pub fn refresh_devices(&mut self) -> devices::Snapshot {
        self.authority
            .backend_mut()
            .device
            .backend
            .refresh_capabilities();
        self.authority.backend_mut().device.snapshot()
    }
}
