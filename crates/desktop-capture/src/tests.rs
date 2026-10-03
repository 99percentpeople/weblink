use super::*;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

#[derive(Default, Clone)]
struct Fake {
    cursor_visible: Rc<Cell<bool>>,
    stops: Rc<Cell<usize>>,
    finished: Rc<Cell<bool>>,
    available: Rc<Cell<bool>>,
    fail_start: Rc<Cell<bool>>,
    fail_stop: Rc<Cell<bool>>,
    queried_running: Rc<Cell<Option<CaptureMethod>>>,
    support_probes: Rc<Cell<usize>>,
    frames: Rc<RefCell<Option<Arc<Mutex<Frames>>>>>,
    monitor: Rc<Cell<bool>>,
    displays: Rc<RefCell<Option<Vec<geometry::DisplayGeometry>>>>,
    #[cfg(windows)]
    snapshot: Rc<RefCell<Option<Vec<u8>>>>,
}

impl Backend for Fake {
    fn capabilities(&self, running: Option<CaptureMethod>) -> CaptureCapabilities {
        self.queried_running.set(running);
        if self.monitor.get() {
            return CaptureCapabilities {
                screen: vec![CaptureBackendInfo {
                    id: CaptureMethod::Wgc,
                    name: "WGC".into(),
                }],
                window: vec![],
            };
        }
        CaptureCapabilities {
            screen: vec![],
            window: vec![CaptureBackendInfo {
                id: CaptureMethod::Wgc,
                name: "WGC".into(),
            }],
        }
    }
    fn supported(&self) -> bool {
        self.support_probes.set(self.support_probes.get() + 1);
        true
    }
    fn sources(&self) -> Result<Vec<CaptureSource>> {
        Ok(if self.available.get() {
            vec![CaptureSource {
                id: "selected".into(),
                name: "Test window".into(),
                kind: if self.monitor.get() {
                    SourceKind::Monitor
                } else {
                    SourceKind::Window
                },
                width: 640,
                height: 480,
            }]
        } else {
            vec![]
        })
    }
    fn displays(&self) -> Result<Vec<geometry::DisplayGeometry>> {
        self.displays
            .borrow()
            .clone()
            .ok_or_else(|| "Display query failed".into())
    }
    #[cfg(windows)]
    fn thumbnail(&self, source: &CaptureSource) -> Result<Vec<u8>> {
        if let Some(bytes) = self.snapshot.borrow().as_ref() {
            return Ok(bytes.clone());
        }
        surface::thumbnail::capture(|frames| self.start(source, CaptureMethod::Wgc, frames))
    }
    fn start(
        &self,
        _: &CaptureSource,
        _: CaptureMethod,
        frames: Arc<Mutex<Frames>>,
    ) -> Result<Box<dyn Session>> {
        if self.fail_start.get() {
            return Err("GPU unavailable".into());
        }
        self.finished.set(false);
        self.frames.replace(Some(frames));
        Ok(Box::new(self.clone()))
    }
}
impl Session for Fake {
    fn cursor_visibility_supported(&self) -> bool {
        true
    }
    fn set_cursor_visible(&self, visible: bool) -> Result<()> {
        self.cursor_visible.set(visible);
        Ok(())
    }
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
fn cursor_visibility_is_scoped_to_a_live_capture_without_restarting_it() {
    let (mut engine, fake) = setup();
    let id = start(&mut engine);
    let heartbeat = engine.active[&id].heartbeat;
    engine.set_cursor_visible(&id, false).unwrap();
    assert!(!fake.cursor_visible.get());
    engine.set_cursor_visible(&id, true).unwrap();
    assert!(fake.cursor_visible.get());
    assert_eq!(fake.stops.get(), 0);
    assert_eq!(engine.active[&id].heartbeat, heartbeat);
    engine.stop(&id, Instant::now()).unwrap();
    assert!(engine.set_cursor_visible(&id, false).is_err());
    assert!(fake.cursor_visible.get());
}

#[test]
fn display_queries_require_an_active_monitor_and_do_not_renew_capture_leases() {
    let (mut engine, fake) = setup();
    fake.displays.replace(Some(vec![geometry::DisplayGeometry {
        source_id: "selected".into(),
        bounds: geometry::PixelRect {
            left: -640,
            top: 0,
            width: 640,
            height: 480,
        },
        rotation: 0,
        scale_percent: Some(150),
    }]));
    let window = start(&mut engine);
    assert!(engine.display_geometry(&window, Instant::now()).is_err());
    engine.stop(&window, Instant::now()).unwrap();
    fake.monitor.set(true);
    let id = start(&mut engine);
    let heartbeat = engine.active[&id].heartbeat;
    let first = engine.display_geometry(&id, heartbeat).unwrap();
    fake.displays.replace(None);
    assert!(engine.display_geometry(&id, heartbeat).is_err());
    fake.displays.replace(Some(first.displays.clone()));
    let restored = engine
        .display_geometry(&id, heartbeat + Duration::from_secs(9))
        .unwrap();
    assert_ne!(first.revision, restored.revision);
    assert!(engine.display_geometry(&id, heartbeat + LEASE).is_err());
    assert_eq!(
        engine.stopped.back().unwrap().stop_reason,
        Some(StopReason::ClientDisconnected)
    );
    let next = start(&mut engine);
    assert!(engine.display_geometry(&id, Instant::now()).is_err());
    fake.displays.borrow_mut().as_mut().unwrap()[0].source_id = "replacement".into();
    assert!(engine.display_geometry(&next, Instant::now()).is_err());
    engine.stop_all(StopReason::Shutdown, Instant::now());
}

#[test]
fn capability_queries_reuse_only_the_currently_owned_backend() {
    let (mut engine, fake) = setup();
    let id = start(&mut engine);
    assert_eq!(fake.queried_running.get(), None);
    engine.capabilities();
    assert_eq!(fake.queried_running.get(), Some(CaptureMethod::Wgc));
    assert!(engine.supported());
    assert_eq!(fake.support_probes.get(), 0);
    assert_eq!(fake.stops.get(), 0);

    engine.stop(&id, Instant::now()).unwrap();
    // A stopped status retains its backend, but must not skip fresh probing.
    assert_eq!(
        engine.stopped.back().unwrap().backend,
        Some(CaptureMethod::Wgc)
    );
    engine.capabilities();
    assert_eq!(fake.queried_running.get(), None);
    assert!(engine.supported());
    assert_eq!(fake.support_probes.get(), 1);
}

#[cfg(windows)]
#[test]
fn snapshot_does_not_open_streaming_capture_and_rejects_stale_sources() {
    let (mut engine, fake) = setup();
    let id = start(&mut engine);
    fake.snapshot.replace(Some(vec![1, 2, 3]));
    fake.fail_start.set(true);
    // A backend's snapshot is independent of streaming options and availability.
    let options = CaptureOptions {
        backend: CaptureMethod::Dxgi,
    };
    assert_eq!(engine.thumbnail("selected", options).unwrap(), [1, 2, 3]);
    assert_eq!(fake.stops.get(), 0);
    assert_eq!(
        engine.status(&id, Instant::now()).unwrap().state,
        CaptureState::Running
    );
    fake.available.set(false);
    assert!(engine.thumbnail("selected", options).is_err());
    engine.stop(&id, Instant::now()).unwrap();
    assert_eq!(fake.stops.get(), 1);
}

#[cfg(windows)]
#[test]
fn thumbnail_timeout_releases_its_session_without_replacing_active_capture() {
    let (mut engine, fake) = setup();
    let id = start(&mut engine);
    let error = engine
        .thumbnail("selected", CaptureOptions::default())
        .unwrap_err();
    assert!(error.contains("preview frame"), "{error}");
    assert_eq!(fake.stops.get(), 1);
    let current = engine.status(&id, Instant::now()).unwrap();
    assert_eq!(current.state, CaptureState::Running);
    assert_eq!(current.session_id.as_deref(), Some(id.as_str()));
    engine.stop(&id, Instant::now()).unwrap();
    assert_eq!(fake.stops.get(), 2);
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
    assert!(engine.active.is_empty());
    fake.fail_start.set(false);
    start(&mut engine);
    engine.stop_all(StopReason::Shutdown, Instant::now());
    assert_eq!(fake.stops.get(), 1);
}

#[test]
fn stopping_a_retired_capture_never_stops_a_new_session() {
    let (mut engine, fake) = setup();
    let old = start(&mut engine);
    engine.stop(&old, Instant::now()).unwrap();
    engine.stop(&old, Instant::now()).unwrap();
    assert_eq!(fake.stops.get(), 1);
    let current = start(&mut engine);
    assert_ne!(old, current);
    assert_eq!(
        engine.stop(&old, Instant::now()).unwrap().state,
        CaptureState::Stopped
    );
    assert_eq!(
        engine.status(&current, Instant::now()).unwrap().state,
        CaptureState::Running
    );
    assert_eq!(fake.stops.get(), 1);
    engine.stop(&current, Instant::now()).unwrap();
    assert_eq!(fake.stops.get(), 2);
}

#[test]
fn concurrent_captures_keep_separate_frames_and_stop_independently() {
    let (mut engine, fake) = setup();
    let first = start(&mut engine);
    let second = start(&mut engine);
    assert_ne!(first, second);
    for (id, width) in [(&first, 640), (&second, 1920)] {
        let mut frames = engine.active[id].frames.lock().unwrap();
        frames.width = width;
        frames.count = 10;
    }
    let now = Instant::now();
    assert_eq!(engine.status(&first, now).unwrap().width, 640);
    assert_eq!(engine.status(&second, now).unwrap().width, 1920);
    engine.stop(&first, now).unwrap();
    assert_eq!(fake.stops.get(), 1);
    assert_eq!(
        engine.status(&second, now).unwrap().state,
        CaptureState::Running
    );
    let third = start(&mut engine);
    engine.stop(&first, now).unwrap();
    assert_eq!(engine.active.len(), 2);
    assert!(engine.active.contains_key(&third));
    engine.stop_all(StopReason::Shutdown, now);
    assert_eq!(fake.stops.get(), 3);
    assert!(engine.active.is_empty());
}

#[test]
fn closing_one_source_and_expiring_one_lease_leave_other_captures_running() {
    let (mut engine, fake) = setup();
    let closed = start(&mut engine);
    let expired = start(&mut engine);
    let live = start(&mut engine);
    let now = Instant::now();
    engine.active[&closed].frames.lock().unwrap().closed = true;
    engine
        .status(&live, now + LEASE - Duration::from_secs(1))
        .unwrap();
    engine.tick(now + LEASE + Duration::from_secs(1));
    assert_eq!(fake.stops.get(), 2);
    assert_eq!(
        engine.status(&closed, now).unwrap().stop_reason,
        Some(StopReason::SourceClosed)
    );
    assert_eq!(
        engine.status(&expired, now).unwrap().stop_reason,
        Some(StopReason::ClientDisconnected)
    );
    assert_eq!(
        engine
            .status(&live, now + LEASE + Duration::from_secs(2))
            .unwrap()
            .state,
        CaptureState::Running
    );
    engine.stop_all(StopReason::Shutdown, now);
}

#[test]
fn failed_or_cancelled_addition_only_releases_its_own_capture() {
    let (mut engine, fake) = setup();
    let first = start(&mut engine);
    fake.fail_start.set(true);
    let result = engine.start("selected", Instant::now());
    assert!(result.is_err());
    let (reply, receiver) = mpsc::channel();
    drop(receiver);
    engine.reply_started(result, reply);
    assert_eq!(fake.stops.get(), 0);

    fake.fail_start.set(false);
    let result = engine.start("selected", Instant::now());
    assert!(result.is_ok());
    let (reply, receiver) = mpsc::channel();
    drop(receiver);
    engine.reply_started(result, reply);
    assert_eq!(fake.stops.get(), 1);
    assert_eq!(engine.active.len(), 1);
    assert_eq!(
        engine.status(&first, Instant::now()).unwrap().state,
        CaptureState::Running
    );
    engine.stop_all(StopReason::Shutdown, Instant::now());
}

#[test]
fn capture_limits_recover_after_stop_and_terminal_statuses_are_bounded() {
    let (mut engine, fake) = setup();
    let first = start(&mut engine);
    for _ in 1..MAX_SESSIONS {
        start(&mut engine);
    }
    assert!(engine.start("selected", Instant::now()).is_err());
    engine.stop(&first, Instant::now()).unwrap();
    start(&mut engine);
    engine.stop_all(StopReason::Shutdown, Instant::now());
    assert_eq!(fake.stops.get(), MAX_SESSIONS + 1);
    for _ in 0..MAX_RETIRED_SESSIONS {
        let id = start(&mut engine);
        engine.stop(&id, Instant::now()).unwrap();
    }
    assert_eq!(engine.stopped.len(), MAX_RETIRED_SESSIONS);
    assert!(engine.status(&first, Instant::now()).is_err());
}

#[test]
fn heartbeat_renews_only_current_session_and_expiry_stops_idle_capture() {
    let (mut engine, fake) = setup();
    let id = start(&mut engine);
    let now = engine.active.get(&id).unwrap().started;
    engine.status(&id, now + Duration::from_secs(9)).unwrap();
    engine.tick(now + Duration::from_secs(11));
    assert_eq!(fake.stops.get(), 0);
    assert!(engine
        .status("stale", now + Duration::from_secs(18))
        .is_err());
    engine.tick(now + Duration::from_secs(9) + LEASE);
    assert_eq!(
        engine.stopped.back().unwrap().stop_reason,
        Some(StopReason::ClientDisconnected)
    );
    assert_eq!(fake.stops.get(), 1);
    // A late heartbeat cannot resurrect an expired session.
    assert_eq!(
        engine
            .status(&id, now + Duration::from_secs(10) + LEASE)
            .unwrap()
            .state,
        CaptureState::Stopped
    );
    assert!(engine.active.is_empty());
}

#[test]
fn renderer_pause_can_resume_capture_but_expired_or_stopped_capture_never_restarts() {
    let (mut engine, fake) = setup();
    let id = start(&mut engine);
    let now = engine.active[&id].started;
    assert_eq!(
        engine
            .status(&id, now + Duration::from_secs(20))
            .unwrap()
            .state,
        CaptureState::Running
    );
    assert_eq!(fake.stops.get(), 0);
    engine.stop(&id, now + Duration::from_secs(21)).unwrap();
    assert_eq!(
        engine
            .status(&id, now + Duration::from_secs(22))
            .unwrap()
            .state,
        CaptureState::Stopped
    );
    assert_eq!(fake.stops.get(), 1);
}

#[test]
fn captures_dimensions_and_measures_arrivals_then_reports_zero_when_static() {
    let (mut engine, fake) = setup();
    let id = start(&mut engine);
    let now = engine.active.get(&id).unwrap().started;
    *fake.frames.borrow().as_ref().unwrap().lock().unwrap() = Frames {
        count: 30,
        width: 1920,
        height: 1080,
        last: Some(now),
        closed: false,
        ..Frames::default()
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
    assert_eq!(engine.stopped.back().unwrap().state, CaptureState::Closed);
    assert_eq!(fake.stops.get(), 1);
}

#[test]
fn reaps_finished_worker_and_surfaces_device_failure() {
    let (mut engine, fake) = setup();
    start(&mut engine);
    fake.finished.set(true);
    fake.fail_stop.set(true);
    engine.tick(Instant::now());
    assert_eq!(engine.stopped.back().unwrap().state, CaptureState::Failed);
    assert_eq!(
        engine.stopped.back().unwrap().error.as_deref(),
        Some("Device lost")
    );
    assert_eq!(fake.stops.get(), 1);
    fake.fail_stop.set(false);
    start(&mut engine);
    engine.stop_all(StopReason::Shutdown, Instant::now());
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

#[test]
fn window_backend_cannot_start_a_display_only_method() {
    let (mut engine, fake) = setup();
    assert!(engine
        .start_media(
            "selected",
            Instant::now(),
            None,
            CaptureOptions {
                backend: CaptureMethod::Dxgi
            },
            None
        )
        .is_err());
    assert!(fake.frames.borrow().is_none());
    let status = engine
        .start_media(
            "selected",
            Instant::now(),
            None,
            CaptureOptions {
                backend: CaptureMethod::Wgc,
            },
            None,
        )
        .unwrap();
    assert_eq!(status.backend, Some(CaptureMethod::Wgc));
    engine
        .stop(&status.session_id.unwrap(), Instant::now())
        .unwrap();
}

#[test]
fn automatic_display_capture_can_fallback_but_explicit_choice_cannot() {
    struct DisplayBackend(Fake);
    impl Backend for DisplayBackend {
        fn supported(&self) -> bool {
            true
        }
        fn capabilities(&self, _: Option<CaptureMethod>) -> CaptureCapabilities {
            CaptureCapabilities {
                screen: vec![
                    CaptureBackendInfo {
                        id: CaptureMethod::Dxgi,
                        name: "DXGI".into(),
                    },
                    CaptureBackendInfo {
                        id: CaptureMethod::Wgc,
                        name: "WGC".into(),
                    },
                ],
                window: vec![],
            }
        }
        fn sources(&self) -> Result<Vec<CaptureSource>> {
            let mut sources = self.0.sources()?;
            sources[0].kind = SourceKind::Monitor;
            Ok(sources)
        }
        fn start(
            &self,
            source: &CaptureSource,
            method: CaptureMethod,
            frames: Arc<Mutex<Frames>>,
        ) -> Result<Box<dyn Session>> {
            if method == CaptureMethod::Dxgi {
                return Err("This display cannot be duplicated".into());
            }
            self.0.start(source, method, frames)
        }
    }
    let (_, fake) = setup();
    let mut engine = Engine::new(DisplayBackend(fake.clone()));
    assert!(engine
        .start_media(
            "selected",
            Instant::now(),
            None,
            CaptureOptions {
                backend: CaptureMethod::Dxgi
            },
            None
        )
        .is_err());
    assert!(fake.frames.borrow().is_none());
    let status = engine.start("selected", Instant::now()).unwrap();
    assert_eq!(status.backend, Some(CaptureMethod::Wgc));
    engine
        .stop(&status.session_id.unwrap(), Instant::now())
        .unwrap();
    assert_eq!(fake.stops.get(), 1);
}
