use super::*;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

#[derive(Default, Clone)]
struct Fake {
    stops: Rc<Cell<usize>>,
    finished: Rc<Cell<bool>>,
    available: Rc<Cell<bool>>,
    fail_start: Rc<Cell<bool>>,
    fail_stop: Rc<Cell<bool>>,
    frames: Rc<RefCell<Option<Arc<Mutex<Frames>>>>>,
}

impl Backend for Fake {
    fn supported(&self) -> bool {
        true
    }
    fn sources(&self) -> Result<Vec<CaptureSource>> {
        Ok(if self.available.get() {
            vec![CaptureSource {
                id: "selected".into(),
                name: "Test window".into(),
                kind: SourceKind::Window,
                width: 640,
                height: 480,
            }]
        } else {
            vec![]
        })
    }
    fn start(&self, _: &CaptureSource, frames: Arc<Mutex<Frames>>) -> Result<Box<dyn Session>> {
        if self.fail_start.get() {
            return Err("GPU unavailable".into());
        }
        self.finished.set(false);
        self.frames.replace(Some(frames));
        Ok(Box::new(self.clone()))
    }
}
impl Session for Fake {
    fn is_finished(&self) -> bool {
        self.finished.get()
    }
    fn stop(self: Box<Self>) -> Result<()> {
        // Also prove stop/join is not called while the callback's lock is held.
        assert!(self.frames.borrow().as_ref().unwrap().try_lock().is_ok());
        self.stops.set(self.stops.get() + 1);
        if self.fail_stop.get() {
            Err("Device lost".into())
        } else {
            Ok(())
        }
    }
}
fn setup() -> (Engine<Fake>, Fake) {
    let fake = Fake::default();
    fake.available.set(true);
    (Engine::new(fake.clone()), fake)
}
fn start(engine: &mut Engine<Fake>) -> String {
    engine
        .start("selected", Instant::now())
        .unwrap()
        .session_id
        .unwrap()
}

#[test]
fn rejects_missing_sources_and_allows_retry_after_start_failure() {
    let (mut engine, fake) = setup();
    assert!(engine.start("unlisted-handle", Instant::now()).is_err());
    fake.available.set(false);
    assert!(engine.start("selected", Instant::now()).is_err());
    fake.available.set(true);
    fake.fail_start.set(true);
    assert!(engine.start("selected", Instant::now()).is_err());
    assert!(engine.active.is_none());
    fake.fail_start.set(false);
    start(&mut engine);
    engine.stop_active(StopReason::Shutdown, Instant::now());
    assert_eq!(fake.stops.get(), 1);
}

#[test]
fn rejects_concurrent_start_and_stale_stop_without_touching_new_session() {
    let (mut engine, fake) = setup();
    let old = start(&mut engine);
    assert!(engine.start("selected", Instant::now()).is_err());
    engine.stop(&old, Instant::now()).unwrap();
    engine.stop(&old, Instant::now()).unwrap();
    assert_eq!(fake.stops.get(), 1);
    let current = start(&mut engine);
    assert_ne!(old, current);
    assert!(engine.stop(&old, Instant::now()).is_err());
    assert!(engine.status(&old, Instant::now()).is_err());
    assert_eq!(
        engine.status(&current, Instant::now()).unwrap().state,
        CaptureState::Running
    );
    engine.stop(&current, Instant::now()).unwrap();
    assert_eq!(fake.stops.get(), 2);
}

#[test]
fn heartbeat_renews_only_current_session_and_expiry_stops_idle_capture() {
    let (mut engine, fake) = setup();
    let id = start(&mut engine);
    let now = engine.active.as_ref().unwrap().started;
    engine.status(&id, now + Duration::from_secs(9)).unwrap();
    engine.tick(now + Duration::from_secs(11));
    assert_eq!(fake.stops.get(), 0);
    assert!(engine
        .status("stale", now + Duration::from_secs(18))
        .is_err());
    engine.tick(now + Duration::from_secs(19));
    assert_eq!(
        engine.status.stop_reason,
        Some(StopReason::ClientDisconnected)
    );
    assert_eq!(fake.stops.get(), 1);
    // A late heartbeat cannot resurrect an expired session.
    assert_eq!(
        engine
            .status(&id, now + Duration::from_secs(20))
            .unwrap()
            .state,
        CaptureState::Stopped
    );
    assert!(engine.active.is_none());
}

#[test]
fn captures_dimensions_and_measures_arrivals_then_reports_zero_when_static() {
    let (mut engine, fake) = setup();
    let id = start(&mut engine);
    let now = engine.active.as_ref().unwrap().started;
    *fake.frames.borrow().as_ref().unwrap().lock().unwrap() = Frames {
        count: 30,
        width: 1920,
        height: 1080,
        last: Some(now),
        closed: false,
    };
    let stats = engine.status(&id, now + Duration::from_secs(1)).unwrap();
    assert_eq!((stats.width, stats.height, stats.frames), (1920, 1080, 30));
    assert_eq!(stats.fps, 30.0);
    assert_eq!(
        engine
            .status(&id, now + Duration::from_secs(2))
            .unwrap()
            .fps,
        0.0
    );
    fake.frames
        .borrow()
        .as_ref()
        .unwrap()
        .lock()
        .unwrap()
        .closed = true;
    engine.tick(now + Duration::from_secs(3));
    assert_eq!(engine.status.state, CaptureState::Closed);
    assert_eq!(fake.stops.get(), 1);
}

#[test]
fn reaps_finished_worker_and_surfaces_device_failure() {
    let (mut engine, fake) = setup();
    start(&mut engine);
    fake.finished.set(true);
    fake.fail_stop.set(true);
    engine.tick(Instant::now());
    assert_eq!(engine.status.state, CaptureState::Failed);
    assert_eq!(engine.status.error.as_deref(), Some("Device lost"));
    assert_eq!(fake.stops.get(), 1);
    fake.fail_stop.set(false);
    start(&mut engine);
    engine.stop_active(StopReason::Shutdown, Instant::now());
    assert_eq!(fake.stops.get(), 2);
}

#[test]
fn shutdown_is_idempotent_and_rejects_further_requests() {
    let service = CaptureService::new().unwrap();
    service.shutdown();
    service.shutdown();
    assert!(service.sources().is_err());
    assert!(!service.supported());
}
