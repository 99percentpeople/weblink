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
    shortcut_unavailable: AtomicBool,
    shortcut: Mutex<Option<weblink_desktop_input::shortcut::Shortcut>>,
    available: AtomicBool,
    status_reads: std::sync::atomic::AtomicUsize,
    owner: Mutex<Option<std::thread::Thread>>,
    observations: Mutex<Vec<Observation>>,
}
impl Default for DeviceState {
    fn default() -> Self {
        Self {
            available: AtomicBool::new(true),
            shortcut_unavailable: AtomicBool::new(false),
            shortcut: Mutex::new(None),
            status_reads: Default::default(),
            owner: Default::default(),
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
    fn configure_shortcut(
        &self,
        shortcut: weblink_desktop_input::shortcut::Shortcut,
    ) -> Result<(), Error> {
        if self.state.shortcut_unavailable.load(Ordering::Acquire) {
            return Err(Error::Unavailable);
        }
        *self.state.shortcut.lock().unwrap() = Some(shortcut);
        Ok(())
    }
    fn set_waker(&self, owner: std::thread::Thread) -> bool {
        *self.state.owner.lock().unwrap() = Some(owner.clone());
        owner.unpark();
        true
    }
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
        self.state.status_reads.fetch_add(1, Ordering::Relaxed);
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

#[test]
#[ignore = "Opt-in idle host measurement with fake OS injection"]
fn idle_host_status_reads() {
    let state = Arc::new(DeviceState::default());
    let service = Service::default();
    let shared = state.clone();
    service
        .start(move || Ok(Box::new(TestSession::new(shared))))
        .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    state.status_reads.store(0, Ordering::Relaxed);
    std::thread::sleep(Duration::from_secs(1));
    let reads = state.status_reads.load(Ordering::Relaxed);
    service.close();
    println!(
        "PERF {}",
        json!({"scenario":"idle-host-1-second", "statusReads":reads})
    );
}

#[test]
fn an_idle_notifying_backend_wakes_the_host_without_periodic_status_reads() {
    let state = Arc::new(DeviceState::default());
    let service = Service::default();
    let shared = state.clone();
    service
        .start(move || Ok(Box::new(TestSession::new(shared))))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    while state.status_reads.load(Ordering::Relaxed) < 3 {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    // Let the retained startup token drain before observing steady-state idle.
    thread::sleep(Duration::from_millis(50));
    let reads = state.status_reads.load(Ordering::Relaxed);
    thread::sleep(Duration::from_millis(150));
    assert_eq!(state.status_reads.load(Ordering::Relaxed), reads);
    state.owner.lock().unwrap().as_ref().unwrap().unpark();
    let deadline = Instant::now() + Duration::from_secs(1);
    while state.status_reads.load(Ordering::Relaxed) == reads {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    service.close();
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
fn clipboard_access_requires_current_native_grant_and_capture() {
    let rig = Rig::new();
    let grant = rig.approve();
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let read = |client: &str, id: &str| {
        rig.service.with_clipboard(&rig.owner, client, id, || {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })
    };
    assert!(read("wrong-client", &grant).is_err());
    assert!(read("client", "old-grant").is_err());
    assert!(read("client", &grant).is_ok());
    rig.source.0.store(false, Ordering::Release);
    assert!(read("client", &grant).is_err());
    rig.source.0.store(true, Ordering::Release);
    rig.service.revoke(&rig.owner).unwrap();
    assert!(read("client", &grant).is_err());
    assert_eq!(calls.load(Ordering::Relaxed), 1);
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

#[test]
fn observers_push_initial_consent_grant_revoke_and_owner_close_in_order() {
    let rig = Rig::new();
    let (send, receive) = std::sync::mpsc::channel();
    rig.service
        .watch(&rig.owner, "view".into(), move |status| {
            send.send(status).is_ok()
        })
        .unwrap();
    let next = || receive.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(!next().closed);
    let consent = rig.request();
    assert_eq!(next().pending.unwrap().consent_id, consent);
    rig.service.approve(&rig.owner, &consent, true).unwrap();
    assert_eq!(next().client_id.as_deref(), Some("client"));
    rig.service.revoke(&rig.owner).unwrap();
    assert!(next().client_id.is_none());
    rig.tick();
    assert!(receive.try_recv().is_err());
    rig.service.end(&rig.owner);
    assert!(next().closed);
    assert!(receive.try_recv().is_err());
}

#[test]
fn replacing_and_unwatching_status_does_not_revoke_input_or_remove_a_new_watcher() {
    let rig = Rig::new();
    rig.approve();
    rig.service
        .watch(&rig.owner, "old".into(), |_| true)
        .unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    rig.service
        .watch(&rig.owner, "new".into(), move |status| {
            send.send(status).is_ok()
        })
        .unwrap();
    assert_eq!(receive.recv().unwrap().client_id.as_deref(), Some("client"));
    rig.service.unwatch(&rig.owner, "old");
    assert!(rig.service.status(&rig.owner).unwrap().client_id.is_some());
    rig.service.revoke(&rig.owner).unwrap();
    assert!(receive
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .client_id
        .is_none());
    rig.service.unwatch(&rig.owner, "new");
    rig.service.end(&rig.owner);
    assert!(receive.try_recv().is_err());
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
fn cursor_shape_stream_requires_authorization_and_stops_with_input() {
    use crate::remote_control::cursor::{Monitor, Shape};
    for reason in [
        "unwatch",
        "pause",
        "interrupt",
        "revoke",
        "disconnect",
        "capture",
        "shutdown",
    ] {
        let rig = Rig::new();
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        rig.service
            .owner(&rig.owner)
            .unwrap()
            .host
            .lock()
            .unwrap()
            .cursor = Monitor::new(move |_| {
            count.fetch_add(1, Ordering::Relaxed);
            Shape::System { name: "text" }
        });
        let packet = |grant: &str| json!({"type":"cursor-watch", "grantId":grant, "inputEpoch":"epoch-1", "watchId":"watch-1"});
        rig.send(packet("unapproved"));
        let grant = rig.approve();
        rig.send(packet(&grant));
        rig.input(&grant, 1, 1, json!({"type":"activate"}));
        for (field, wrong) in [
            ("grantId", json!("wrong")),
            ("inputEpoch", json!("old")),
            ("watchId", json!(false)),
        ] {
            let mut invalid = packet(&grant);
            invalid[field] = wrong;
            rig.send(invalid);
        }
        rig.endpoint
            .message(true, &serde_json::to_vec(&packet(&grant)).unwrap());
        rig.tick();
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        rig.send(packet(&grant));
        assert!(rig.sender.sent.lock().unwrap().iter().any(|v| *v
            == json!({"type":"cursor-state",
            "grantId":grant, "inputEpoch":"epoch-1", "watchId":"watch-1", "sequence":1,
            "shape":{"type":"system", "name":"text"}})));
        // Auto-keyboard subscriptions must remain independent of cursor subscriptions.
        rig.send(json!({"type":"text-input-watch", "grantId":grant, "inputEpoch":"epoch-1", "watchId":null}));
        assert!(rig
            .service
            .owner(&rig.owner)
            .unwrap()
            .host
            .lock()
            .unwrap()
            .cursor
            .watching());
        match reason {
            "unwatch" => {
                let mut off = packet(&grant);
                off["watchId"] = Value::Null;
                rig.send(off);
            }
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
        if let Ok(owner) = rig.service.owner(&rig.owner) {
            assert!(
                !owner.host.lock().unwrap().cursor.watching(),
                "still watching after {reason}"
            );
        }
        if reason == "pause" {
            rig.input(&grant, 2, 1, json!({"type":"activate"}));
            rig.send(packet(&grant));
            assert!(!rig
                .service
                .owner(&rig.owner)
                .unwrap()
                .host
                .lock()
                .unwrap()
                .cursor
                .watching());
        }
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
fn text_input_stream_requires_active_authorization_and_stops_at_epoch_boundaries() {
    use crate::remote_control::text_focus::{Focus, Monitor};
    use std::sync::atomic::AtomicUsize;
    let rig = Rig::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let value = Arc::new(Mutex::new(Focus::Editable {
        id: "field-a".into(),
    }));
    let count = calls.clone();
    let current = value.clone();
    rig.service
        .owner(&rig.owner)
        .unwrap()
        .host
        .lock()
        .unwrap()
        .text_focus = Monitor::new(move || {
        Box::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            current.lock().unwrap().clone()
        })
    });
    let grant = rig.approve();
    let watch = json!({"type":"text-input-watch", "watchId":"watch-1", "grantId":grant, "inputEpoch":"epoch-1"});
    rig.send(watch.clone());
    rig.activate_and_hold(&grant, 1);
    for field in ["grantId", "inputEpoch"] {
        let mut invalid = watch.clone();
        invalid[field] = json!("old");
        rig.send(invalid);
    }
    let mut invalid = watch.clone();
    invalid["watchId"] = json!(false);
    rig.send(invalid);
    std::thread::sleep(Duration::from_millis(130));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let updates = || {
        rig.sender
            .sent
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["type"] == "text-input-state")
            .cloned()
            .collect::<Vec<_>>()
    };
    let wait = |length| {
        let deadline = Instant::now() + Duration::from_secs(2);
        while updates().len() < length {
            rig.send(json!({"type":"heartbeat", "grantId":grant, "generation":"media", "geometryRevision":"layout"}));
            assert!(Instant::now() < deadline, "missing focus update");
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    rig.send(watch.clone());
    wait(1);
    assert_eq!(
        updates()[0],
        json!({"type":"text-input-state", "watchId":"watch-1", "grantId":grant,
        "inputEpoch":"epoch-1", "sequence":1, "focus":{"type":"editable", "id":"field-a"}})
    );
    std::thread::sleep(Duration::from_millis(250));
    rig.tick();
    assert_eq!(
        updates().len(),
        1,
        "unchanged samples must not generate packets"
    );
    *value.lock().unwrap() = Focus::Unknown;
    wait(2);
    assert_eq!(updates()[1]["focus"], json!({"type":"unknown"}));
    *value.lock().unwrap() = Focus::None;
    wait(3);
    assert_eq!(updates()[2]["focus"], json!({"type":"none"}));
    assert_eq!(updates()[2]["sequence"], 3);
    let mut off = watch.clone();
    off["watchId"] = Value::Null;
    rig.send(off);
    std::thread::sleep(Duration::from_millis(30));
    let stopped = calls.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(230));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        stopped,
        "unsubscribe must stop polling"
    );
    let mut refreshed = watch;
    refreshed["watchId"] = json!("watch-2");
    rig.send(refreshed);
    wait(4);
    assert_eq!(updates()[3]["sequence"], 1);
    rig.input(&grant, 1, 3, json!({"type":"pause"}));
    rig.input(&grant, 2, 1, json!({"type":"activate"}));
    *value.lock().unwrap() = Focus::Editable {
        id: "field-b".into(),
    };
    std::thread::sleep(Duration::from_millis(250));
    rig.tick();
    assert_eq!(updates().len(), 4, "retired epoch must stop the stream");
}
#[test]
fn refreshed_or_cancelled_focus_watch_discards_an_inflight_sample() {
    use crate::remote_control::text_focus::{Focus, Monitor, Watch};
    use std::sync::mpsc;
    let rig = Rig::new();
    rig.approve();
    let grant = rig
        .service
        .owner(&rig.owner)
        .unwrap()
        .host
        .lock()
        .unwrap()
        .active
        .as_ref()
        .unwrap()
        .grant
        .clone();
    for refresh in [false, true] {
        let (started, starting) = mpsc::channel();
        let (resume, resumed) = mpsc::channel();
        let monitor = Monitor::new(move || {
            let mut first = true;
            Box::new(move || {
                if std::mem::take(&mut first) {
                    started.send(()).unwrap();
                    resumed.recv_timeout(Duration::from_secs(2)).unwrap();
                    Focus::Editable {
                        id: "obsolete".into(),
                    }
                } else {
                    Focus::None
                }
            })
        });
        let mut watch = Watch {
            grant: grant.clone(),
            epoch: "epoch".into(),
            id: "old".into(),
        };
        monitor.watch(watch.clone());
        starting.recv_timeout(Duration::from_secs(2)).unwrap();
        if refresh {
            watch.id = "new".into();
            monitor.watch(watch);
        } else {
            monitor.cancel();
        }
        resume.send(()).unwrap();
        if refresh {
            let deadline = Instant::now() + Duration::from_secs(2);
            let update = loop {
                if let Some(update) = monitor.take() {
                    break update;
                }
                assert!(Instant::now() < deadline, "missing refreshed snapshot");
                std::thread::sleep(Duration::from_millis(5));
            };
            assert_eq!(update.watch.id, "new");
            assert_eq!(update.sequence, 1);
            assert_eq!(update.focus, Focus::None);
        } else {
            std::thread::sleep(Duration::from_millis(250));
            assert!(monitor.take().is_none(), "cancelled watch leaked a sample");
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
    assert!(service.open_with_shortcut(None).is_err());
    assert!(service.owner.lock().unwrap().is_none());
}

#[test]
fn changing_emergency_shortcut_keeps_owner_and_retains_previous_on_listener_failure() {
    let state = Arc::new(DeviceState::default());
    let service = Service::default();
    let id = service
        .start(|| Ok(Box::new(TestSession::new(state.clone()))))
        .unwrap();
    let first = "ctrl-shift-f8".to_owned().try_into().unwrap();
    let second = "ctrl-alt-f9".to_owned().try_into().unwrap();
    service.configure_shortcut(first).unwrap();
    assert_eq!(service.with_shortcut(|key| key), first);
    assert_eq!(*state.shortcut.lock().unwrap(), Some(first));
    state.shortcut_unavailable.store(true, Ordering::Release);
    assert!(service.configure_shortcut(second).is_err());
    assert_eq!(service.with_shortcut(|key| key), first);
    assert_eq!(*state.shortcut.lock().unwrap(), Some(first));
    assert!(!service.status(&id).unwrap().closed);
    service.close();
}
