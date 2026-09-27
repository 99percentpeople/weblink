//! Captures only a temporary window created by this process; never an existing desktop/window.
//! Run in an unlocked interactive Windows session: cargo run -p weblink-desktop-capture --example self_test
#[cfg(not(windows))]
fn main() {
    eprintln!("This capture smoke test requires an interactive Windows desktop.");
    std::process::exit(1);
}

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{
        sync::mpsc,
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };
    use weblink_desktop_capture::{CaptureService, CaptureState, CaptureStatus};
    use windows::{
        core::{w, HSTRING},
        Win32::UI::WindowsAndMessaging::*,
    };

    enum WindowCommand {
        Resize(mpsc::Sender<Result<(), String>>),
        Close,
    }
    struct TestWindow {
        commands: mpsc::Sender<WindowCommand>,
        worker: Option<JoinHandle<()>>,
    }
    impl TestWindow {
        fn new(title: String) -> Result<Self, String> {
            let (commands, receiver) = mpsc::channel();
            let (ready, initialized) = mpsc::channel();
            // Keep pumping this window while the test thread blocks on native capture.
            // WinRT item creation and window enumeration can send synchronous window messages.
            let worker = thread::spawn(move || {
                let window = unsafe {
                    CreateWindowExW(
                        WINDOW_EX_STYLE::default(),
                        w!("STATIC"),
                        &HSTRING::from(title),
                        WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                        100,
                        100,
                        400,
                        260,
                        None,
                        None,
                        None,
                        None,
                    )
                };
                let hwnd = match window {
                    Ok(hwnd) => hwnd,
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                        return;
                    }
                };
                let _ = ready.send(Ok(()));
                while unsafe { IsWindow(Some(hwnd)).as_bool() } {
                    match receiver.try_recv() {
                        Ok(WindowCommand::Resize(reply)) => {
                            let result = unsafe {
                                SetWindowPos(hwnd, None, 0, 0, 560, 360, SWP_NOMOVE | SWP_NOZORDER)
                            };
                            let _ = reply.send(result.map_err(|e| e.to_string()));
                        }
                        Ok(WindowCommand::Close) | Err(mpsc::TryRecvError::Disconnected) => break,
                        Err(mpsc::TryRecvError::Empty) => {}
                    }
                    let mut message = MSG::default();
                    unsafe {
                        while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                            let _ = TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                unsafe {
                    let _ = DestroyWindow(hwnd);
                }
            });
            let result = Self {
                commands,
                worker: Some(worker),
            };
            initialized.recv().map_err(|e| e.to_string())??;
            Ok(result)
        }
        fn resize(&self) -> Result<(), String> {
            let (reply, receiver) = mpsc::channel();
            self.commands
                .send(WindowCommand::Resize(reply))
                .map_err(|e| e.to_string())?;
            receiver.recv().map_err(|e| e.to_string())?
        }
        fn close(&mut self) {
            let _ = self.commands.send(WindowCommand::Close);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }
    impl Drop for TestWindow {
        fn drop(&mut self) {
            self.close();
        }
    }

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
