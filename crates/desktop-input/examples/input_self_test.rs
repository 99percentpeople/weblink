//! Interactive Windows acceptance probe. Injects only into its own foreground test window.
//! Run directly in a logged-in desktop, not a service/SSH session desktop.
#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("input_self_test requires an interactive Windows desktop");
    std::process::exit(1);
}
#[cfg(target_os = "windows")]
mod support;
#[cfg(target_os = "windows")]
fn main() {
    if let Err(error) = run() {
        eprintln!("input self-test failed: {error}");
        std::process::exit(1);
    }
}
#[cfg(target_os = "windows")]
fn run() -> Result<(), Box<dyn std::error::Error>> {
    use std::{
        thread,
        time::{Duration, Instant},
    };
    use weblink_desktop_input::{
        authorization::{Binding, Grant, RequestResult},
        engine::TrustedTarget,
        input::*,
        protocol::{Signal, Target},
        windows::{physical_displays, Worker},
    };
    use windows::Win32::UI::{Input::KeyboardAndMouse::GetAsyncKeyState, WindowsAndMessaging::*};
    let window = support::TestWindow::new()?;
    let (x, y) = window.point(180, 130)?;
    let geometry = physical_displays()?
        .into_iter()
        .find(|g| {
            x >= g.display.left
                && y >= g.display.top
                && i64::from(x) < i64::from(g.display.left) + i64::from(g.display.width)
                && i64::from(y) < i64::from(g.display.top) + i64::from(g.display.height)
        })
        .ok_or("no test monitor")?;
    let point = |x: i32, y: i32| Position {
        x: f64::from(x - geometry.display.left) / f64::from(geometry.display.width - 1),
        y: f64::from(y - geometry.display.top) / f64::from(geometry.display.height - 1),
    };
    let a = point(x, y);
    let b = point(x + 100, y + 60);
    let target = TrustedTarget {
        geometry,
        binding: Binding {
            room_generation: "self-test-room".into(),
            peer_generation: "self-test-peer".into(),
            client_id: "self-test-viewer".into(),
            capture_session_id: "self-test-capture".into(),
            target: Target {
                source_id: "self-test-screen".into(),
                media_id: "self-test-media".into(),
                geometry_revision: "self-test-layout".into(),
            },
        },
    };
    window.with_reserved_hotkey(|| Worker::start(Some(window.handle())).is_err())?;
    let mut worker = Worker::start(Some(window.handle()))?;
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        assert!(
            Worker::start(Some(window.handle())).is_err(),
            "multiple actors accepted"
        );
        assert!(worker.register(target.clone())?);
        window.check_hotkey(false)?;
        let approve =
            |worker: &Worker, request: &str| -> Result<Grant, Box<dyn std::error::Error>> {
                let Some(RequestResult::Pending { consent_id }) = worker.request(
                    target.binding.target.media_id.clone(),
                    Signal::Request {
                        request_id: request.into(),
                        target: target.binding.target.clone(),
                    },
                )?
                else {
                    return Err("consent not pending".into());
                };
                if worker.approve(consent_id)?.is_none() {
                    return Err("local approval refused".into());
                }
                Ok(worker.flush()?.grant.ok_or("grant missing")?)
            };
        let key = ScanCode::new(0x1e, false).unwrap();
        let forged = Grant {
            id: "not-approved".into(),
            binding: target.binding.clone(),
        };
        worker.input(forged, Event::Key { key, down: true })?;
        assert_eq!(worker.flush()?.submitted, 0);
        let grant = approve(&worker, "movement")?;
        worker.input(grant.clone(), Event::Move(a))?;
        let status = worker.flush()?;
        if status.submitted != 1 || status.grant.is_none() {
            return Err(format!("initial move not submitted: {status:?}").into());
        }
        window.assert_cursor(x, y)?;
        window.wait_for(WM_MOUSEMOVE, 1)?;
        worker.input(
            grant.clone(),
            Event::Button {
                position: a,
                button: Button::Left,
                down: true,
            },
        )?;
        worker.input(
            grant.clone(),
            Event::Button {
                position: a,
                button: Button::Left,
                down: false,
            },
        )?;
        worker.flush()?;
        window.wait_for(WM_LBUTTONUP, 1)?;
        worker.input(
            grant.clone(),
            Event::Button {
                position: a,
                button: Button::Left,
                down: true,
            },
        )?;
        worker.flush()?;
        window.wait_for(WM_LBUTTONDOWN, 2)?;
        worker.input(grant.clone(), Event::Move(b))?;
        worker.flush()?;
        window.wait_drag()?;
        worker.input(
            grant.clone(),
            Event::Button {
                position: b,
                button: Button::Left,
                down: false,
            },
        )?;
        worker.input(
            grant.clone(),
            Event::Wheel {
                position: b,
                horizontal: 120,
                vertical: -120,
            },
        )?;
        worker.input(grant.clone(), Event::Key { key, down: true })?;
        worker.input(grant.clone(), Event::Key { key, down: false })?;
        worker.input(grant.clone(), Event::Text("中😀".into()))?;
        worker.flush()?;
        window.wait_for(WM_MOUSEWHEEL, 1)?;
        window.wait_for(WM_MOUSEHWHEEL, 1)?;
        window.wait_key_up(1)?;
        window.assert_text()?;
        println!("PASS: physical pointer position, click, drag, vertical/horizontal wheel, scan code and UTF-16 text into owned window; {:?}",geometry);

        worker.input(grant.clone(), Event::Key { key, down: true })?;
        worker.input(
            grant.clone(),
            Event::Button {
                position: b,
                button: Button::Left,
                down: true,
            },
        )?;
        worker.flush()?;
        let started = Instant::now();
        worker.revoke()?;
        window.wait_key_up(2)?;
        window.wait_for(WM_LBUTTONUP, 3)?;
        assert!(worker.flush()?.grant.is_none());
        window.assert_released()?;
        println!(
            "PASS: explicit native revoke releases held key/button in {:?}",
            started.elapsed()
        );

        let grant = approve(&worker, "lease")?;
        worker.input(grant.clone(), Event::Key { key, down: true })?;
        worker.flush()?;
        let started = Instant::now();
        while !worker.status().input_suspended && started.elapsed() < Duration::from_secs(3) {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(worker.status().grant.as_ref(), Some(&grant));
        assert!(worker.status().input_suspended);
        assert!(worker.renew(grant.clone())?);
        worker.input(grant, Event::ReleaseAll)?;
        assert!(!worker.flush()?.input_suspended);
        window.wait_key_up(3)?;
        window.assert_released()?;
        println!(
            "PASS: heartbeat gap releases input, preserves consent and resumes without reapproval in {:?}",
            started.elapsed()
        );

        worker.revoke()?;
        let grant = approve(&worker, "other-input")?;
        worker.input(grant.clone(), Event::Key { key, down: true })?;
        worker.flush()?;
        // Exercise unrelated input without monitoring physical devices or taking ownership.
        window.external_click()?;
        thread::sleep(Duration::from_millis(100));
        let status = worker.flush()?;
        assert_eq!(status.grant.as_ref(), Some(&grant));
        assert!(!status.input_suspended);
        assert!(unsafe { GetAsyncKeyState(0x41) } < 0);
        worker.input(grant.clone(), Event::Key { key, down: false })?;
        worker.input(grant, Event::Move(a))?;
        worker.flush()?;
        window.assert_released()?;
        window.assert_cursor(x, y)?;
        println!("PASS: unrelated input does not interrupt control or release owned presses");
        worker.revoke()?;

        thread::sleep(Duration::from_millis(30));
        let grant = approve(&worker, "hotkey")?;
        worker.input(grant, Event::Key { key, down: true })?;
        worker.flush()?;
        window.notify_lifecycle(WM_HOTKEY)?;
        let started = Instant::now();
        while worker.status().grant.is_some() && started.elapsed() < Duration::from_secs(1) {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(worker.status().grant.is_none());
        window.assert_released()?;
        println!("PASS: registered emergency hotkey notification releases input");

        thread::sleep(Duration::from_millis(30));
        let grant = approve(&worker, "shutdown")?;
        worker.input(grant, Event::Key { key, down: true })?;
        worker.flush()?;
        worker.shutdown();
        window.check_hotkey(true)?;
        window.assert_released()?;
        assert!(worker.status().closed);
        println!("PASS: shutdown releases held state and joins worker");
        // Successfully starting again proves hooks, hotkey, window and process exclusivity were released.
        for notification in [WM_DISPLAYCHANGE, WM_WTSSESSION_CHANGE] {
            let restarted = Worker::start(Some(window.handle()))?;
            assert!(restarted.register(target.clone())?);
            let grant = approve(&restarted, "desktop-change")?;
            restarted.input(grant, Event::Key { key, down: true })?;
            restarted.flush()?;
            window.notify_lifecycle(notification)?;
            let started = Instant::now();
            while !restarted.status().closed && started.elapsed() < Duration::from_secs(1) {
                thread::sleep(Duration::from_millis(5));
            }
            assert!(restarted.status().closed);
            window.assert_released()?;
            println!("PASS: lifecycle notification {notification:#x} closes actor; restart requires new consent");
            drop(restarted);
        }
        println!("PASS: all input probes completed; lockscreen and process kill require separate acceptance");
        Ok(())
    })();
    if result.is_err() {
        eprintln!("input actor status at failure: {:?}", worker.status());
    }
    result
}
