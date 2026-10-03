use super::*;
use crate::remote_control::{binding::GeometrySource, transport::Endpoint};
use serde_json::{json, Value};
use std::time::Instant;
use weblink_desktop_capture::media::control::{SendResult, Sender};
use weblink_desktop_input::{
    authorization::{Binding, RequestResult},
    engine::{Device, Engine, Status, TrustedTarget},
    input::{Action, Error, Event, Geometry, Rect, ScanCode},
    protocol::Target,
    session::Session,
};

#[derive(Debug, PartialEq)]
enum Observation {
    Input(Action),
    ChannelClosed,
    Shutdown,
}
struct DeviceState {
    available: AtomicBool,
    observations: Mutex<Vec<Observation>>,
}
impl Default for DeviceState {
    fn default() -> Self {
        Self {
            available: AtomicBool::new(true),
            observations: Mutex::default(),
        }
    }
}
struct TestDevice(Arc<DeviceState>);
impl Device for TestDevice {
    fn available(&self) -> bool {
        self.0.available.load(Ordering::Acquire)
    }
    fn geometry_current(&self, _: Geometry) -> bool {
        self.available()
    }
    fn submit(&mut self, actions: &[Action]) -> Result<(), Error> {
        self.0
            .observations
            .lock()
            .unwrap()
            .extend(actions.iter().copied().map(Observation::Input));
        Ok(())
    }
}
/// Use the production authorization/pressed-state engine, replacing only OS injection.
struct TestSession {
    engine: Mutex<Engine<TestDevice>>,
    state: Arc<DeviceState>,
}
impl TestSession {
    fn new(state: Arc<DeviceState>) -> Self {
        Self {
            engine: Mutex::new(Engine::new(TestDevice(state.clone()))),
            state,
        }
    }
}
impl Session for TestSession {
    fn register_until(
        &self,
        target: TrustedTarget,
        invalidated: Arc<AtomicBool>,
    ) -> Result<bool, Error> {
        Ok(self
            .engine
            .lock()
            .unwrap()
            .register_until(target, invalidated))
    }
    fn request(&self, media: String, signal: Signal) -> Result<Option<RequestResult>, Error> {
        Ok(self
            .engine
            .lock()
            .unwrap()
            .request(&media, &signal, Instant::now()))
    }
    fn approve(&self, consent: String) -> Result<Option<Signal>, Error> {
        Ok(self
            .engine
            .lock()
            .unwrap()
            .approve(&consent, Instant::now()))
    }
    fn decline(&self, consent: String) -> Result<Option<Signal>, Error> {
        Ok(self.engine.lock().unwrap().decline(&consent))
    }
    fn renew(&self, grant: Grant) -> Result<bool, Error> {
        Ok(self.engine.lock().unwrap().renew(&grant, Instant::now()))
    }
    fn receive_end(&self, media: String, signal: Signal) -> Result<bool, Error> {
        Ok(self.engine.lock().unwrap().receive_end(&media, &signal))
    }
    fn invalidate(&self, binding: Binding) -> Result<(), Error> {
        self.engine.lock().unwrap().invalidate(&binding);
        Ok(())
    }
    fn interrupt(&self) -> Result<(), Error> {
        self.engine.lock().unwrap().interrupt();
        Ok(())
    }
    fn revoke(&self) -> Result<(), Error> {
        self.engine.lock().unwrap().revoke();
        Ok(())
    }
    fn input(&self, grant: Grant, event: Event) -> Result<(), Error> {
        self.engine
            .lock()
            .unwrap()
            .input(&grant, event, Instant::now())
    }
    fn flush(&self) -> Result<Status, Error> {
        Ok(self.status())
    }
    fn status(&self) -> Status {
        let mut engine = self.engine.lock().unwrap();
        engine.tick(Instant::now());
        engine.status()
    }
    fn shutdown(&mut self) {
        let mut engine = self.engine.lock().unwrap();
        if !engine.status().closed {
            engine.shutdown();
            self.state
                .observations
                .lock()
                .unwrap()
                .push(Observation::Shutdown);
        }
    }
}
impl Drop for TestSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}
struct Source(AtomicBool, AtomicBool);
impl GeometrySource for Source {
    fn cursor_visibility_supported(&self, _: &Binding) -> bool {
        true
    }
    fn set_cursor_visible(&self, _: &Binding, visible: bool) -> Result<(), String> {
        self.1.store(visible, Ordering::Release);
        Ok(())
    }
    fn is_current(&self, _: &Binding) -> bool {
        self.0.load(Ordering::Acquire)
    }
}
struct TestSender {
    state: Arc<DeviceState>,
    sent: Mutex<Vec<Value>>,
}
impl Sender for TestSender {
    fn send(&self, data: &[u8]) -> SendResult {
        self.sent
            .lock()
            .unwrap()
            .push(serde_json::from_slice(data).unwrap());
        SendResult::Sent
    }
    fn close(&self) {
        self.state
            .observations
            .lock()
            .unwrap()
            .push(Observation::ChannelClosed);
    }
}
struct Rig {
    service: Service,
    owner: String,
    endpoint: Arc<Endpoint>,
    source: Arc<Source>,
    state: Arc<DeviceState>,
    sender: Arc<TestSender>,
}
#[test]
#[ignore = "Opt-in control handoff timing with mock injection; no OS input"]
fn control_handoff_latency() {
    let rig = Rig::new();
    let grant = rig.approve();
    rig.input(&grant, 1, 1, json!({"type":"activate"}));
    let mut waits = Vec::new();
    for sequence in 1..=120 {
        std::thread::sleep(Duration::from_millis(8));
        let before = rig.state.observations.lock().unwrap().len();
        let data = serde_json::to_vec(&json!({
            "type":"input", "grantId":grant, "generation":"media", "geometryRevision":"layout",
            "inputEpoch":"epoch-1", "activationSequence":1, "sequence":sequence, "after":1,
            "event":{"type":"move", "x":0.5, "y":0.5}
        }))
        .unwrap();
        let started = Instant::now();
        rig.endpoint.message(true, &data);
        while rig.state.observations.lock().unwrap().len() == before {
            assert!(
                started.elapsed() < Duration::from_secs(1),
                "Movement was not injected"
            );
            std::thread::yield_now();
        }
        waits.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    waits.sort_by(f64::total_cmp);
    println!(
        "CONTROL_HANDOFF samples={} mean_ms={:.3} p95_ms={:.3} max_ms={:.3}",
        waits.len(),
        waits.iter().sum::<f64>() / waits.len() as f64,
        waits[113],
        waits[119]
    );
}
fn target(owner: &str, capture: &str, media: &str) -> TrustedTarget {
    let rect = Rect {
        left: 0,
        top: 0,
        width: 1920,
        height: 1080,
    };
    TrustedTarget {
        binding: Binding {
            room_generation: owner.into(),
            peer_generation: "peer".into(),
            client_id: "client".into(),
            capture_session_id: capture.into(),
            target: Target {
                source_id: "source".into(),
                media_id: media.into(),
                geometry_revision: "layout".into(),
            },
        },
        geometry: Geometry {
            display: rect,
            desktop: rect,
        },
    }
}
impl Rig {
    fn new() -> Self {
        let service = Service::default();
        let state = Arc::new(DeviceState::default());
        let owner = service
            .start(|| Ok(Box::new(TestSession::new(state.clone()))))
            .unwrap();
        let source = Arc::new(Source(AtomicBool::new(true), AtomicBool::new(true)));
        let endpoint = service
            .owner(&owner)
            .unwrap()
            .host
            .lock()
            .unwrap()
            .register(source.clone(), target(&owner, "capture", "media"))
            .unwrap();
        let sender = Arc::new(TestSender {
            state: state.clone(),
            sent: Mutex::default(),
        });
        endpoint.opened(sender.clone());
        let rig = Self {
            service,
            owner,
            endpoint,
            source,
            state,
            sender,
        };
        rig.tick();
        rig
    }
    fn tick(&self) {
        self.service
            .owner(&self.owner)
            .unwrap()
            .host
            .lock()
            .unwrap()
            .tick();
    }
    fn send(&self, value: Value) {
        self.endpoint
            .message(false, &serde_json::to_vec(&value).unwrap());
        self.tick();
    }
    fn request(&self) -> String {
        self.send(json!({ "type": "request", "requestId": "request", "target": target(&self.owner,"capture","media").binding.target }));
        self.service
            .status(&self.owner)
            .unwrap()
            .pending
            .unwrap()
            .consent_id
    }
    fn approve(&self) -> String {
        let consent = self.request();
        self.service.approve(&self.owner, &consent, true).unwrap();
        self.sender
            .sent
            .lock()
            .unwrap()
            .iter()
            .find(|v| v["type"] == "grant")
            .unwrap()["grantId"]
            .as_str()
            .unwrap()
            .into()
    }
    fn input(&self, grant: &str, epoch: u64, sequence: u64, event: Value) {
        self.send(json!({"type":"input","grantId":grant,"generation":"media","geometryRevision":"layout",
            "inputEpoch":format!("epoch-{epoch}"),"activationSequence":epoch,"sequence":sequence,"event":event}));
    }
    fn activate_and_hold(&self, grant: &str, epoch: u64) {
        self.input(grant, epoch, 1, json!({"type":"activate"}));
        self.input(
            grant,
            epoch,
            2,
            json!({"type":"key","scanCode":30,"extended":false,"down":true}),
        );
    }
    fn submitted(&self) -> usize {
        self.state
            .observations
            .lock()
            .unwrap()
            .iter()
            .filter(|o| matches!(o, Observation::Input(_)))
            .count()
    }
    fn released(&self) {
        let state = self.state.observations.lock().unwrap();
        let key = ScanCode::new(30, false).unwrap();
        assert_eq!(
            state.iter().rfind(|o| matches!(o, Observation::Input(_))),
            Some(&Observation::Input(Action::Key { key, down: false }))
        );
    }
}

#[test]
fn cursor_visibility_requires_current_approved_input_and_restores_on_every_end() {
    for reason in [
        "pause",
        "interrupt",
        "revoke",
        "disconnect",
        "capture",
        "shutdown",
    ] {
        let rig = Rig::new();
        let packet = |grant: &str| {
            json!({"type":"cursor", "grantId":grant,
            "generation":"media", "geometryRevision":"layout", "inputEpoch":"epoch-1", "visible":false})
        };
        rig.send(packet("unapproved"));
        assert!(rig.source.1.load(Ordering::Acquire));
        let grant = rig.approve();
        rig.send(packet(&grant));
        assert!(rig.source.1.load(Ordering::Acquire));
        rig.input(&grant, 1, 1, json!({"type":"activate"}));
        for (field, wrong) in [
            ("grantId", json!("wrong")),
            ("generation", json!("wrong")),
            ("geometryRevision", json!("wrong")),
            ("inputEpoch", json!("old")),
            ("visible", json!(0)),
        ] {
            let mut invalid = packet(&grant);
            invalid[field] = wrong;
            rig.send(invalid);
            assert!(
                rig.source.1.load(Ordering::Acquire),
                "accepted invalid {field}"
            );
        }
        rig.endpoint
            .message(true, &serde_json::to_vec(&packet(&grant)).unwrap());
        rig.tick();
        assert!(rig.source.1.load(Ordering::Acquire));
        rig.send(packet(&grant));
        assert!(!rig.source.1.load(Ordering::Acquire));
        let mut show = packet(&grant);
        show["visible"] = json!(true);
        rig.send(show);
        assert!(rig.source.1.load(Ordering::Acquire));
        rig.send(packet(&grant));
        match reason {
            "pause" => rig.input(&grant, 1, 2, json!({"type":"pause"})),
            "interrupt" => {
                rig.service
                    .owner(&rig.owner)
                    .unwrap()
                    .host
                    .lock()
                    .unwrap()
                    .worker
                    .interrupt()
                    .unwrap();
                rig.tick();
            }
            "revoke" => rig.service.revoke(&rig.owner).unwrap(),
            "disconnect" => {
                rig.endpoint.closed();
                rig.tick();
            }
            "capture" => rig.service.stop_capture("capture"),
            "shutdown" => rig.service.close(),
            _ => unreachable!(),
        }
        assert!(
            rig.source.1.load(Ordering::Acquire),
            "cursor stayed hidden after {reason}"
        );
        if matches!(reason, "pause" | "interrupt") {
            rig.input(&grant, 2, 1, json!({"type":"activate"}));
            rig.send(packet(&grant));
            assert!(
                rig.source.1.load(Ordering::Acquire),
                "retired epoch hid cursor"
            );
        }
    }
}

#[test]
fn requests_require_current_local_approval_and_decline_never_injects() {
    let rig = Rig::new();
    rig.input("unapproved", 1, 1, json!({"type":"activate"}));
    assert_eq!(rig.submitted(), 0);
    let consent = rig.request();
    assert!(rig
        .service
        .approve(&rig.owner, "wrong-consent", true)
        .is_err());
    assert_eq!(rig.submitted(), 0);
    rig.service.approve(&rig.owner, &consent, false).unwrap();
    assert!(rig.service.status(&rig.owner).unwrap().pending.is_none());
    assert!(rig
        .sender
        .sent
        .lock()
        .unwrap()
        .iter()
        .any(|v| v["type"] == "deny" && v["reason"] == "declined"));
    assert!(rig.service.approve(&rig.owner, &consent, true).is_err());
    assert_eq!(rig.submitted(), 0);
}

#[test]
fn repeated_interruptions_resume_on_fresh_epochs_without_reapproval() {
    let rig = Rig::new();
    let grant = rig.approve();
    // Exercise the composed service beyond the former recovery limit.
    for epoch in 1..=300 {
        rig.activate_and_hold(&grant, epoch);
        let owner = rig.service.owner(&rig.owner).unwrap();
        owner.host.lock().unwrap().worker.interrupt().unwrap();
        rig.tick();
        rig.released();
        let submitted = rig.submitted();
        rig.input(
            &grant,
            epoch,
            3,
            json!({"type":"key","scanCode":30,"extended":false,"down":true}),
        );
        assert_eq!(rig.submitted(), submitted, "retired epoch injected input");
        assert_eq!(
            rig.service.status(&rig.owner).unwrap().client_id.as_deref(),
            Some("client")
        );
    }
    rig.activate_and_hold(&grant, 301);
    assert_eq!(
        rig.sender
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["type"] == "grant")
            .count(),
        1
    );
    rig.service.revoke(&rig.owner).unwrap();
    rig.released();
    let submitted = rig.submitted();
    rig.activate_and_hold(&grant, 302);
    assert_eq!(rig.submitted(), submitted);
}

#[test]
fn stopping_capture_invalidates_channels_and_releases_input_but_keeps_other_sources() {
    let rig = Rig::new();
    let grant = rig.approve();
    rig.activate_and_hold(&grant, 1);
    let other = rig
        .service
        .owner(&rig.owner)
        .unwrap()
        .host
        .lock()
        .unwrap()
        .register(
            rig.source.clone(),
            target(&rig.owner, "other-capture", "other-media"),
        )
        .unwrap();
    rig.service.stop_capture("capture");
    assert!(rig.endpoint.is_closed());
    assert!(!other.is_closed());
    rig.released();
    assert!(rig.service.status(&rig.owner).unwrap().client_id.is_none());
    let observations = rig.state.observations.lock().unwrap();
    let closed = observations
        .iter()
        .position(|o| *o == Observation::ChannelClosed)
        .unwrap();
    assert!(matches!(
        observations.get(closed + 1),
        Some(Observation::Input(Action::Key { down: false, .. }))
    ));
}

#[test]
fn source_end_cancels_pending_consent_and_geometry_change_releases_active_input() {
    let rig = Rig::new();
    let consent = rig.request();
    rig.service.stop_capture("capture");
    assert!(rig.service.approve(&rig.owner, &consent, true).is_err());
    assert!(rig.service.status(&rig.owner).unwrap().pending.is_none());

    let rig = Rig::new();
    let grant = rig.approve();
    rig.activate_and_hold(&grant, 1);
    rig.source.0.store(false, Ordering::Release);
    rig.service
        .owner(&rig.owner)
        .unwrap()
        .host
        .lock()
        .unwrap()
        .peers
        .get_mut("media")
        .unwrap()
        .last_geometry = Instant::now() - Duration::from_secs(1);
    rig.tick();
    assert!(rig.endpoint.is_closed());
    rig.released();
}

#[test]
fn channel_loss_and_native_access_loss_end_the_grant_and_release_pressed_keys() {
    for lose_channel in [true, false] {
        let rig = Rig::new();
        let grant = rig.approve();
        rig.activate_and_hold(&grant, 1);
        if lose_channel {
            rig.endpoint.closed();
        } else {
            rig.state.available.store(false, Ordering::Release);
        }
        rig.tick();
        assert!(rig.service.status(&rig.owner).unwrap().client_id.is_none());
        rig.released();
    }
}

#[test]
fn replacement_releases_old_owner_and_stale_end_cannot_close_new_owner() {
    let rig = Rig::new();
    let grant = rig.approve();
    rig.activate_and_hold(&grant, 1);
    let next_state = Arc::new(DeviceState::default());
    let next = rig
        .service
        .start(|| Ok(Box::new(TestSession::new(next_state.clone()))))
        .unwrap();
    assert!(rig.endpoint.is_closed());
    rig.released();
    assert!(rig.service.status(&rig.owner).unwrap().closed);
    rig.service.end(&rig.owner);
    assert!(!rig.service.status(&next).unwrap().closed);
    assert!(!next_state
        .observations
        .lock()
        .unwrap()
        .contains(&Observation::Shutdown));
    rig.service.close();
    assert!(rig.service.status(&next).unwrap().closed);
    assert!(next_state
        .observations
        .lock()
        .unwrap()
        .contains(&Observation::Shutdown));
}

#[test]
fn failed_backend_start_leaves_no_old_owner_or_pressed_keys() {
    let rig = Rig::new();
    let grant = rig.approve();
    rig.activate_and_hold(&grant, 1);
    assert!(rig.service.start(|| Err(Error::Unavailable)).is_err());
    assert!(rig.endpoint.is_closed());
    assert!(rig.service.status(&rig.owner).unwrap().closed);
    rig.released();
    assert!(rig.service.owner.lock().unwrap().is_none());
}

#[cfg(not(windows))]
#[test]
fn unsupported_backend_never_opens_an_input_owner() {
    assert!(!weblink_desktop_input::session::supported());
    let service = Service::default();
    assert!(service.open().is_err());
    assert!(service.owner.lock().unwrap().is_none());
}
