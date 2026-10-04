use super::*;
use ::windows::Win32::UI::WindowsAndMessaging::{WM_LBUTTONUP, WM_MOUSEWHEEL};
use std::time::Instant;
use weblink_desktop_capture::{
    media::{MediaOptions, MediaSession},
    SourceKind,
};

struct TestLogger;
impl log::Log for TestLogger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.target() == "libwebrtc"
    }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata()) {
            eprintln!("{}", r.args());
        }
    }
    fn flush(&self) {}
}
static LOGGER: TestLogger = TestLogger;

/// Real DataChannels + production native coordinator. Injection is restricted to our own
/// foreground test window. The local test owner approves only its own browser request;
/// no physical click is required by the authorization API.
#[test]
#[ignore = "interactive Windows + browser; WEBLINK_CONTROL_TEST_DIR required"]
fn browser_pointer_attended() {
    let touch = std::env::var_os("WEBLINK_CONTROL_TEST_TOUCH").is_some();
    let persistent = std::env::var_os("WEBLINK_CONTROL_TEST_PERSISTENT").is_some();
    if std::env::var_os("WEBLINK_CONTROL_TEST_LOG").is_some() {
        let _ = log::set_logger(&LOGGER);
        log::set_max_level(log::LevelFilter::Debug);
    }
    let dir = std::path::PathBuf::from(
        std::env::var("WEBLINK_CONTROL_TEST_DIR").expect("Missing isolated exchange directory"),
    );
    std::fs::create_dir_all(&dir).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _runtime_context = runtime.enter();
    let service = Service::default();
    let capture = Arc::new(CaptureService::new().unwrap());
    let source = capture
        .sources()
        .unwrap()
        .into_iter()
        .find(|s| s.kind == SourceKind::Monitor)
        .unwrap();
    let media = MediaSession::new(MediaOptions {
        max_width: 640,
        max_height: 480,
        frame_rate: 15,
        max_bitrate: 2_000_000,
        encoder: "software".into(),
        ..Default::default()
    })
    .unwrap();
    let window = test_window::TestWindow::with_focus_timeout(Duration::from_secs(120)).unwrap();
    let session = capture
        .start_media(source.id.clone(), media.clone())
        .unwrap()
        .session_id
        .unwrap();
    let layout = capture.display_geometry(session.clone()).unwrap();
    let rect = &layout
        .displays
        .iter()
        .find(|d| d.source_id == source.id)
        .unwrap()
        .bounds;
    let owner = service
        .start(|| {
            weblink_desktop_input::windows::Worker::start(Some(window.handle()))
                .map(|worker| Box::new(worker) as Box<dyn weblink_desktop_input::session::Session>)
        })
        .unwrap();
    let point = |x, y| {
        let (x, y) = window.point(x, y).unwrap();
        serde_json::json!({"x":(x-rect.left) as f64/(rect.width-1) as f64,"y":(y-rect.top) as f64/(rect.height-1) as f64})
    };
    std::fs::write(
        dir.join("points.json"),
        serde_json::json!({"start":point(160,150),"end":point(350,220)}).to_string(),
    )
    .unwrap();
    let port = service
        .attach(
            capture.clone(),
            Context {
                owner_id: owner.clone(),
                peer_generation: "probe-peer".into(),
                client_id: "browser-test".into(),
                source_id: "probe-source".into(),
            },
            session.clone(),
            "probe-media".into(),
        )
        .unwrap_or_else(|error| {
            panic!(
                "{error}; input status {:?}",
                service
                    .owner(&owner)
                    .unwrap()
                    .host
                    .lock()
                    .unwrap()
                    .worker
                    .status()
            )
        });
    let candidates = Arc::new(Mutex::new(Vec::new()));
    let gathered = candidates.clone();
    let offer = runtime
        .block_on(media.offer_control(
            "probe-media".into(),
            vec![],
            false,
            Some(Box::new(move |candidate| {
                gathered.lock().unwrap().push(candidate)
            })),
            port,
        ))
        .unwrap();
    std::fs::write(dir.join("offer.sdp"), offer).unwrap();
    let deadline = Instant::now() + Duration::from_secs(150);
    let keep_alive = || {
        assert!(Instant::now() < deadline, "browser test deadline");
        capture.renew(session.clone()).unwrap();
        if !persistent {
            service.status(&owner).unwrap();
        }
    };
    while !dir.join("answer.sdp").exists() {
        keep_alive();
        std::fs::write(
            dir.join("native-candidates.json"),
            serde_json::to_vec(&*candidates.lock().unwrap()).unwrap(),
        )
        .unwrap();
        thread::sleep(Duration::from_millis(100));
    }
    runtime
        .block_on(media.answer(
            "probe-media",
            &std::fs::read_to_string(dir.join("answer.sdp")).unwrap(),
        ))
        .unwrap();
    println!("Browser connected: waiting for request and local test-owner approval");
    let mut applied = 0;
    let mut approved = false;
    let mut revoked = false;
    let mut before_revoke = 0;
    let mut interrupted = false;
    while !dir.join("done").exists() {
        keep_alive();
        std::fs::write(
            dir.join("native-candidates.json"),
            serde_json::to_vec(&*candidates.lock().unwrap()).unwrap(),
        )
        .unwrap();
        if let Ok(data) = std::fs::read(dir.join("browser-candidates.json")) {
            let list: Vec<weblink_desktop_capture::media::IceCandidate> =
                serde_json::from_slice(&data).unwrap();
            for c in list.iter().skip(applied) {
                runtime
                    .block_on(media.add_ice_candidate("probe-media", c.clone()))
                    .unwrap();
            }
            applied = list.len();
        }
        let state = if persistent {
            // Deliberately omit frontend status polling throughout the run.
            service
                .owner(&owner)
                .unwrap()
                .host
                .lock()
                .unwrap()
                .snapshot()
        } else {
            service.status(&owner).unwrap()
        };
        assert!(!state.closed, "UI polling stopped the native owner");
        if let Some(p) = state.pending.filter(|_| !approved) {
            unsafe {
                ::windows::Win32::UI::WindowsAndMessaging::SetWindowTextW(
                    ::windows::Win32::Foundation::HWND(window.handle() as *mut _),
                    ::windows::core::w!(
                        "Weblink input self-test - running guarded browser control"
                    ),
                )
            }
            .unwrap();
            std::fs::write(
                dir.join("pending"),
                "Local test owner received the browser request",
            )
            .unwrap();
            assert_eq!(
                service
                    .owner(&owner)
                    .unwrap()
                    .host
                    .lock()
                    .unwrap()
                    .worker
                    .status()
                    .submitted,
                0,
                "input before approval"
            );
            if service.approve(&owner, &p.consent_id, true).is_ok() {
                approved = true;
                println!("PASS local policy approval without physical click evidence");
                std::fs::write(dir.join("approved"), "ok").unwrap();
            }
        }
        if persistent && dir.join("interrupt").exists() && !interrupted {
            let o = service.owner(&owner).unwrap();
            let before = o.host.lock().unwrap().worker.flush().unwrap().grant;
            window.external_click().unwrap();
            thread::sleep(Duration::from_millis(50));
            let status = o.host.lock().unwrap().worker.flush().unwrap();
            assert_eq!(status.grant, before);
            assert!(!status.input_suspended);
            interrupted = true;
            std::fs::write(dir.join("interrupted"), "ok").unwrap();
            println!("PASS unrelated input keeps browser control active with no owner polling");
        }
        if dir.join("revoke").exists() && !revoked {
            assert!(approved);
            if touch {
                window.assert_touch().unwrap();
            } else {
                window.wait_for(WM_LBUTTONUP, 1).unwrap();
                window.wait_for(WM_MOUSEWHEEL, 1).unwrap();
                window.wait_drag().unwrap();
            }
            window.assert_released().unwrap();
            service.revoke(&owner).unwrap();
            before_revoke = service
                .owner(&owner)
                .unwrap()
                .host
                .lock()
                .unwrap()
                .worker
                .flush()
                .unwrap()
                .submitted;
            revoked = true;
            std::fs::write(dir.join("revoked"), "ok").unwrap();
            println!("PASS remote input / release / local revoke; native touch: {touch}");
        }
        thread::sleep(Duration::from_millis(25));
    }
    assert!(approved && revoked);
    assert!(!persistent || interrupted);
    assert_eq!(
        service
            .owner(&owner)
            .unwrap()
            .host
            .lock()
            .unwrap()
            .worker
            .flush()
            .unwrap()
            .submitted,
        before_revoke,
        "input after revoke"
    );
    window.assert_released().unwrap();
    // An outstanding request cannot survive media teardown or a replaced owner.
    media.close_peer("probe-media");
    thread::sleep(Duration::from_millis(50));
    assert!(service.status(&owner).unwrap().pending.is_none());
    service.end(&owner);
    assert!(service.status(&owner).unwrap().closed);
    capture.stop(session).unwrap();
    capture.shutdown();
    println!("PASS no input before approval or after revoke; media and owner teardown; guarded browser input complete");
}
