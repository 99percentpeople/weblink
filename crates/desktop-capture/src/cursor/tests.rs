use super::*;
use crate::{
    CaptureBackendInfo, CaptureCapabilities, CaptureOptions, CaptureSource, CaptureState, Session,
    SourceKind,
};
use std::{cell::Cell, cell::RefCell, rc::Rc, time::Instant};

#[derive(Clone, Copy, Default)]
enum Failure {
    #[default]
    None,
    Start,
    Cursor,
    Closed,
}

struct Running {
    frames: Arc<Mutex<Frames>>,
    visible: Cell<bool>,
    stops: Cell<usize>,
    unsupported: Cell<bool>,
    fail_cursor: bool,
}
impl Session for Rc<Running> {
    fn is_finished(&self) -> bool {
        self.frames.lock().unwrap().closed
    }
    fn cursor_visibility_supported(&self) -> bool {
        !self.unsupported.get()
    }
    fn set_cursor_visible(&self, visible: bool) -> Result<()> {
        if self.fail_cursor {
            return Err("Cursor settings rejected".into());
        }
        self.visible.set(visible);
        Ok(())
    }
    fn stop(self: Box<Self>) -> Result<()> {
        self.stops.set(self.stops.get() + 1);
        self.frames.try_lock().unwrap().closed = true;
        Ok(())
    }
}

#[derive(Default)]
struct Captures {
    started: RefCell<Vec<Rc<Running>>>,
    failure: Cell<Failure>,
}
impl Backend for Rc<Captures> {
    fn supported(&self) -> bool {
        true
    }
    fn capabilities(&self, _: Option<CaptureMethod>) -> CaptureCapabilities {
        CaptureCapabilities {
            screen: [CaptureMethod::Dxgi, CaptureMethod::Wgc]
                .into_iter()
                .map(|id| CaptureBackendInfo {
                    id,
                    name: format!("{id:?}"),
                })
                .collect(),
            window: vec![],
        }
    }
    fn sources(&self) -> Result<Vec<CaptureSource>> {
        Ok(vec![CaptureSource {
            id: "monitor".into(),
            kind: SourceKind::Monitor,
            name: "Display".into(),
            width: 640,
            height: 480,
        }])
    }
    fn start(
        &self,
        _: &CaptureSource,
        method: CaptureMethod,
        frames: Arc<Mutex<Frames>>,
    ) -> Result<Box<dyn Session>> {
        let failure = if method == CaptureMethod::Wgc && frames.lock().unwrap().cursor_hidden {
            let mut stats = frames.lock().unwrap();
            assert!(
                stats.cursor_hidden,
                "Exclude the cursor before capturing any pixels"
            );
            assert!(stats.media.is_none());
            #[cfg(windows)]
            assert!(
                stats.sink.is_none(),
                "Do not publish while DXGI can still deliver frames"
            );
            if matches!(self.failure.get(), Failure::Start) {
                // A partial WGC startup must not close the original session.
                stats.closed = true;
                return Err("WGC start failed".into());
            }
            stats.closed = matches!(self.failure.get(), Failure::Closed);
            self.failure.get()
        } else {
            Failure::None
        };
        frames.lock().unwrap().count = 3;
        let running = Rc::new(Running {
            frames,
            visible: Cell::new(true),
            stops: Cell::new(0),
            unsupported: Cell::new(false),
            fail_cursor: matches!(failure, Failure::Cursor),
        });
        self.started.borrow_mut().push(running.clone());
        Ok(Box::new(running))
    }
}

fn setup() -> (Engine<Rc<Captures>>, Rc<Captures>, String) {
    setup_with_backend(CaptureMethod::Auto)
}

fn setup_with_backend(backend: CaptureMethod) -> (Engine<Rc<Captures>>, Rc<Captures>, String) {
    let captures = Rc::new(Captures::default());
    let mut engine = Engine::new(captures.clone());
    let id = engine
        .start_media(
            "monitor",
            Instant::now(),
            None,
            CaptureOptions { backend },
            None,
        )
        .unwrap()
        .session_id
        .unwrap();
    (engine, captures, id)
}

#[test]
fn cursor_exclusion_preserves_explicit_backends_while_auto_shares_can_switch() {
    for backend in [CaptureMethod::Dxgi, CaptureMethod::Wgc] {
        let (mut engine, captures, id) = setup_with_backend(backend);
        let selected = captures.started.borrow()[0].clone();
        let automatic = engine
            .start("monitor", Instant::now())
            .unwrap()
            .session_id
            .unwrap();
        engine.set_cursor_visible(&automatic, false).unwrap();
        assert_eq!(
            engine.active[&automatic].status.backend,
            Some(CaptureMethod::Wgc)
        );
        // A neighboring Auto capture must not change this share's selection.
        for visible in [false, true, false, true] {
            engine.set_cursor_visible(&id, visible).unwrap();
            assert_eq!(selected.visible.get(), visible);
            assert_eq!(selected.frames.lock().unwrap().cursor_hidden, !visible);
            let status = engine.status(&id, Instant::now()).unwrap();
            assert_eq!(status.backend, Some(backend));
            assert_eq!(status.state, CaptureState::Running);
            assert_eq!(status.session_id.as_deref(), Some(id.as_str()));
        }
        assert_eq!(captures.started.borrow().len(), 3);
        assert_eq!(selected.stops.get(), 0);
        engine.stop(&id, Instant::now()).unwrap();
        engine.stop(&automatic, Instant::now()).unwrap();
    }
}

#[test]
fn cursor_exclusion_handover_preserves_the_share_and_only_runs_once() {
    let (mut engine, captures, id) = setup();
    let other = engine
        .start("monitor", Instant::now())
        .unwrap()
        .session_id
        .unwrap();
    let old = captures.started.borrow()[0].clone();
    let started = engine.active[&id].started;
    engine.set_cursor_visible(&id, true).unwrap();
    assert_eq!(captures.started.borrow().len(), 2);
    old.frames.lock().unwrap().count = 30;
    let before = engine.status(&id, Instant::now()).unwrap();
    let heartbeat = engine.active[&id].heartbeat;
    engine.set_cursor_visible(&id, false).unwrap();
    assert_eq!(old.stops.get(), 1);
    assert!(old.frames.lock().unwrap().closed);
    let current = captures.started.borrow()[2].clone();
    assert!(!current.visible.get());
    assert!(!current.frames.lock().unwrap().closed);
    assert_eq!(engine.active[&id].started, started);
    assert_eq!(engine.active[&id].heartbeat, heartbeat);
    let after = engine.status(&id, Instant::now()).unwrap();
    assert_eq!(after.session_id, before.session_id);
    assert_eq!(after.source, before.source);
    assert_eq!(after.state, CaptureState::Running);
    assert_eq!(after.backend, Some(CaptureMethod::Wgc));
    assert_eq!(after.frames, 33);
    for visible in [true, false, true, false, true] {
        engine.set_cursor_visible(&id, visible).unwrap();
        assert_eq!(current.visible.get(), visible);
        assert_eq!(current.frames.lock().unwrap().cursor_hidden, !visible);
    }
    assert_eq!(captures.started.borrow().len(), 3);
    assert_eq!(
        engine.active[&other].status.backend,
        Some(CaptureMethod::Dxgi)
    );
    assert_eq!(captures.started.borrow()[1].stops.get(), 0);
    engine.stop(&id, Instant::now()).unwrap();
    assert_eq!(current.stops.get(), 1);
    assert!(engine.set_cursor_visible(&id, false).is_err());
    engine.stop(&other, Instant::now()).unwrap();
}

#[test]
fn cursor_exclusion_startup_failures_leave_dxgi_running_and_allow_retry() {
    for failure in [Failure::Start, Failure::Cursor, Failure::Closed] {
        let (mut engine, captures, id) = setup();
        let old = captures.started.borrow()[0].clone();
        captures.failure.set(failure);
        assert!(engine.set_cursor_visible(&id, false).is_err());
        assert_eq!(old.stops.get(), 0);
        assert!(!old.frames.lock().unwrap().closed);
        assert!(!old.frames.lock().unwrap().cursor_hidden);
        assert!(old.visible.get());
        let status = engine.status(&id, Instant::now()).unwrap();
        assert_eq!(status.state, CaptureState::Running);
        assert_eq!(status.backend, Some(CaptureMethod::Dxgi));
        for failed in captures.started.borrow().iter().skip(1) {
            assert_eq!(failed.stops.get(), 1);
        }
        captures.failure.set(Failure::None);
        engine.set_cursor_visible(&id, false).unwrap();
        assert_eq!(old.stops.get(), 1);
        engine.stop(&id, Instant::now()).unwrap();
    }
}

#[test]
fn cursor_exclusion_does_not_replace_dxgi_without_os_support() {
    let (mut engine, captures, id) = setup();
    captures.started.borrow()[0].unsupported.set(true);
    assert!(engine.set_cursor_visible(&id, false).is_err());
    engine.set_cursor_visible(&id, true).unwrap();
    assert_eq!(captures.started.borrow().len(), 1);
    engine.stop(&id, Instant::now()).unwrap();
}

#[cfg(windows)]
#[test]
#[ignore = "Requires an unlocked Windows desktop; captures only in memory"]
fn dxgi_cursor_exclusion_switches_only_auto_and_keeps_native_preview_alive() {
    use crate::{
        media::{MediaOptions, MediaSession},
        CaptureOptions,
    };
    use std::time::Duration;
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _runtime = runtime.enter();
    let mut engine = Engine::new(crate::backend::NativeBackend::new());
    let source = engine
        .backend
        .sources()
        .unwrap()
        .into_iter()
        .find(|s| s.kind == SourceKind::Monitor)
        .unwrap();
    for backend in [CaptureMethod::Auto, CaptureMethod::Dxgi] {
        let media = MediaSession::new(MediaOptions {
            encoder: "software".into(),
            codec: Some("video/vp8".into()),
            max_width: 320,
            max_height: 180,
            ..Default::default()
        })
        .unwrap();
        let status = engine
            .start_media(
                &source.id,
                Instant::now(),
                Some(media.clone()),
                CaptureOptions { backend },
                None,
            )
            .unwrap();
        assert_eq!(status.backend, Some(CaptureMethod::Dxgi));
        let id = status.session_id.unwrap();
        let mut pixels = vec![0; 320 * 180 * 4];
        let mut sequence = 0;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(frame) = media.copy_preview_frame(sequence, &mut pixels).unwrap() {
                sequence = frame.sequence;
                break;
            }
            assert!(Instant::now() < deadline, "DXGI preview did not arrive");
            std::thread::sleep(Duration::from_millis(10));
        }
        let geometry = engine.display_geometry(&id, Instant::now()).unwrap();
        let started = Instant::now();
        engine.set_cursor_visible(&id, false).unwrap();
        println!("{backend:?} cursor exclusion: {:?}", started.elapsed());
        assert_eq!(
            engine.status(&id, Instant::now()).unwrap().backend,
            Some(if backend == CaptureMethod::Auto {
                CaptureMethod::Wgc
            } else {
                CaptureMethod::Dxgi
            })
        );
        assert_eq!(
            engine
                .display_geometry(&id, Instant::now())
                .unwrap()
                .revision,
            geometry.revision
        );
        assert!(Arc::ptr_eq(&engine.media(&id).unwrap(), &media));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let frames = engine.active[&id].frames.lock().unwrap();
            assert!(!frames.closed);
            drop(frames);
            if media
                .copy_preview_frame(sequence, &mut pixels)
                .unwrap()
                .is_some()
            {
                break;
            }
            assert!(media.error().is_none(), "{:?}", media.error());
            assert!(Instant::now() < deadline, "Preview did not resume");
            std::thread::sleep(Duration::from_millis(10));
        }
        for visible in [true, false, true] {
            engine.set_cursor_visible(&id, visible).unwrap();
        }
        engine.stop(&id, Instant::now()).unwrap();
    }
}

#[cfg(windows)]
#[test]
fn cursor_exclusion_transfers_the_existing_media_and_sink() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _runtime = runtime.enter();
    struct Sink;
    impl crate::surface::FrameSink for Sink {
        fn frame(&self, _: crate::surface::TextureFrame<'_>) -> Result<()> {
            Ok(())
        }
    }
    let (mut engine, captures, id) = setup();
    let sink: Arc<dyn crate::surface::FrameSink> = Arc::new(Sink);
    let media = crate::media::MediaSession::new(crate::media::MediaOptions {
        encoder: "software".into(),
        codec: Some("video/vp8".into()),
        ..Default::default()
    })
    .unwrap();
    {
        let mut old = engine.active[&id].frames.lock().unwrap();
        old.sink = Some(sink.clone());
        old.media = Some(media.clone());
    }
    engine.set_cursor_visible(&id, false).unwrap();
    assert!(Arc::ptr_eq(&engine.media(&id).unwrap(), &media));
    {
        let next = engine.active[&id].frames.lock().unwrap();
        assert!(Arc::ptr_eq(next.sink.as_ref().unwrap(), &sink));
    }
    let retired = captures.started.borrow()[0].clone();
    let old = retired.frames.lock().unwrap();
    assert!(old.sink.is_none());
    assert!(old.media.is_none());
    drop(old);
    engine.stop(&id, Instant::now()).unwrap();
}
