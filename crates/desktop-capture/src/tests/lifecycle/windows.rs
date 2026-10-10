//! Real backend exit tests; only the fixture window is created/destroyed.
use super::*;
use ::windows::{
    core::w,
    Win32::{
        Foundation::{LPARAM, WPARAM},
        System::Threading::{GetCurrentProcessId, GetCurrentThreadId},
        UI::WindowsAndMessaging::*,
    },
};

struct Window {
    source: String,
    thread_id: u32,
    thread: Option<thread::JoinHandle<()>>,
}
impl Window {
    fn new() -> Self {
        let (ready, receive) = mpsc::channel();
        let thread = thread::spawn(move || unsafe {
            let window = CreateWindowExW(
                WS_EX_NOACTIVATE,
                w!("STATIC"),
                w!("Weblink capture lifecycle test"),
                WS_POPUP | WS_VISIBLE,
                80,
                80,
                160,
                100,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let source = format!("window:{:x}:{}", window.0 as usize, GetCurrentProcessId());
            if ready.send((source, GetCurrentThreadId())).is_ok() {
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            let _ = DestroyWindow(window);
        });
        let (source, thread_id) = receive.recv_timeout(Duration::from_secs(5)).unwrap();
        Self {
            source,
            thread_id,
            thread: Some(thread),
        }
    }
}
impl Drop for Window {
    fn drop(&mut self) {
        let _ = unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn terminal(service: &CaptureService, id: String) -> CaptureStatus {
    let (send, receive) = mpsc::channel();
    service
        .watch(
            id,
            "test".into(),
            Box::new(move |status| send.send(status).is_ok()),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = receive
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        if status.state != CaptureState::Running {
            return status;
        }
    }
}

struct FailingSink;
impl surface::FrameSink for FailingSink {
    fn frame(&self, _: surface::TextureFrame<'_>) -> Result<()> {
        Err("controlled lifecycle sink failure".into())
    }
}

#[test]
#[ignore = "Requires an unlocked Windows desktop; briefly creates a non-activating test window"]
fn native_lifecycle_reports_window_close_and_capture_errors() {
    let service = CaptureService::new().unwrap();
    let window = Window::new();
    let status = service
        .start_with_options(
            window.source.clone(),
            CaptureOptions {
                backend: CaptureMethod::Wgc,
            },
        )
        .unwrap();
    let id = status.session_id.unwrap();
    // Subscribe before closing, then wait on events with no status/renew requests.
    let (send, receive) = mpsc::channel();
    service
        .watch(
            id.clone(),
            "closed-window".into(),
            Box::new(move |s| send.send(s).is_ok()),
        )
        .unwrap();
    assert_eq!(receive.recv().unwrap().state, CaptureState::Running);
    drop(window);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = receive
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        if status.state == CaptureState::Running {
            continue;
        }
        assert_eq!(status.state, CaptureState::Closed);
        assert_eq!(status.stop_reason, Some(StopReason::SourceClosed));
        break;
    }
    assert!(service.renew(id).is_err());
    println!("WGC source closure delivered without polling");

    for backend in [CaptureMethod::Wgc, CaptureMethod::Dxgi] {
        let window = Window::new();
        let source = if backend == CaptureMethod::Wgc {
            window.source.clone()
        } else {
            service
                .sources()
                .unwrap()
                .into_iter()
                .find(|s| s.kind == SourceKind::Monitor)
                .expect("Desktop has no display source")
                .id
        };
        let status = service
            .start_with_sink(source, CaptureOptions { backend }, Arc::new(FailingSink))
            .unwrap();
        let stopped = terminal(&service, status.session_id.unwrap());
        assert_eq!(stopped.state, CaptureState::Failed, "{stopped:?}");
        assert!(stopped
            .error
            .as_deref()
            .unwrap()
            .contains("controlled lifecycle sink failure"));
        println!("{backend:?} backend failure delivered and resources joined without polling");
    }
    service.shutdown();
}
