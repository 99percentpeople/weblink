//! Captures only a temporary window created by this process; never an existing desktop/window.
//! Run in an unlocked interactive Windows session: cargo run -p weblink-desktop-capture --example self_test
#[cfg(windows)]
mod support;
#[cfg(not(windows))]
fn main() {
    eprintln!("This capture smoke test requires an interactive Windows desktop.");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::time::{Duration, Instant};
    use support::TestWindow;
    use weblink_desktop_capture::{CaptureService, CaptureState, CaptureStatus};

    fn wait_for(
        service: &CaptureService,
        id: &str,
        condition: impl Fn(&CaptureStatus) -> bool,
    ) -> Result<CaptureStatus, String> {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let status = service.status(id.to_owned())?;
            if condition(&status) {
                return Ok(status);
            }
            if status.state != CaptureState::Running || Instant::now() >= deadline {
                return Err(format!("Capture did not reach expected state: {status:?}"));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    let title = format!("Weblink capture self-test {}", std::process::id());
    let mut window = TestWindow::new(title.clone())?;
    println!("test window created");
    let service = CaptureService::new()?;
    if !service.supported() {
        return Err("Windows Graphics Capture is unavailable in this session".into());
    }
    println!("native capture supported; enumerating test window");
    let source = service
        .sources()?
        .into_iter()
        .find(|s| s.name == title)
        .ok_or("The test window was not enumerated")?;
    println!("starting capture of the test window");
    let id = service
        .start(source.id.clone())?
        .session_id
        .ok_or("Missing session identity")?;
    let first = wait_for(&service, &id, |s| {
        s.frames > 0 && s.width > 0 && s.height > 0
    })?;
    println!(
        "first frame: {}x{}, frames={}",
        first.width, first.height, first.frames
    );
    window.repaint(1)?;
    window.resize()?;
    let resized = wait_for(&service, &id, |s| {
        s.width != first.width && s.height != first.height
    })?;
    println!(
        "resized frame: {}x{}, frames={}",
        resized.width, resized.height, resized.frames
    );
    let stopped = service.stop(id.clone())?;
    if stopped.state != CaptureState::Stopped {
        return Err(format!("Stop failed: {stopped:?}").into());
    }
    let second_id = service
        .start(source.id)?
        .session_id
        .ok_or("Missing restart identity")?;
    if service.stop(id).is_ok() {
        return Err("A stale stop was incorrectly accepted".into());
    }
    wait_for(&service, &second_id, |s| s.frames > 0)?;
    window.close();
    wait_for(&service, &second_id, |s| s.state == CaptureState::Closed)?;
    service.shutdown();
    println!(
        "PASS: first frame, resize, stop, restart, stale stop rejection and source-close cleanup"
    );
    Ok(())
}
