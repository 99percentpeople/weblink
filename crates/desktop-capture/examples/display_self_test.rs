//! Opt-in interactive Windows display-backend smoke. Does not read, export or encode pixels.
#[cfg(not(windows))]
fn main() {
    eprintln!("This test requires an interactive Windows session");
}
#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };
    use weblink_desktop_capture::{
        surface::{FrameSink, TextureFrame},
        CaptureOptions, CaptureService, CaptureState, SourceKind,
    };
    struct Counter(AtomicU64);
    impl FrameSink for Counter {
        fn frame(&self, _frame: TextureFrame<'_>) -> Result<(), String> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
    }
    let service = CaptureService::new()?;
    let capabilities = service.capabilities()?;
    println!("Capture capabilities: {capabilities:?}");
    println!("Enumerating displays");
    let screen = service
        .sources()?
        .into_iter()
        .find(|source| source.kind == SourceKind::Monitor)
        .ok_or("No display")?;
    if capabilities.screen.is_empty() {
        return Err("No interactive display capture backend".into());
    }
    println!("Display selected");
    for backend in capabilities.screen {
        for _ in 0..2 {
            let sink = Arc::new(Counter(AtomicU64::new(0)));
            println!("Starting {:?}", backend.id);
            let status = service.start_with_sink(
                screen.id.clone(),
                CaptureOptions {
                    backend: backend.id,
                },
                sink.clone(),
            )?;
            println!("Started {:?}", status.backend);
            let id = status.session_id.unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while sink.0.load(Ordering::Relaxed) == 0 {
                let status = service.status(id.clone())?;
                if status.state != CaptureState::Running {
                    return Err(format!("Capture failed: {status:?}").into());
                }
                if Instant::now() >= deadline {
                    return Err("No native display frame".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            // Reopening the picker or settings queries the backend inventory again.
            // It must not try to duplicate an output this process already owns.
            for _ in 0..3 {
                let available = service.capabilities()?;
                println!(
                    "Capabilities while {:?} is running: {available:?}",
                    backend.id
                );
                assert!(
                    available.screen.iter().any(|item| item.id == backend.id),
                    "The running capture backend disappeared from the picker"
                );
                assert!(service.supported());
                assert!(service
                    .sources()?
                    .iter()
                    .any(|source| source.id == screen.id));
                let current = service.status(id.clone())?;
                assert_eq!(current.state, CaptureState::Running);
                assert_eq!(current.backend, Some(backend.id));
            }
            let stopped = service.stop(id)?;
            assert_eq!(stopped.state, CaptureState::Stopped, "{stopped:?}");
            let count = sink.0.load(Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(100));
            assert_eq!(
                count,
                sink.0.load(Ordering::Relaxed),
                "Frame arrived after stop"
            );
            println!(
                "PASS {:?}: native sink received {count} frames; stop/restart clean",
                backend.id
            );
        }
    }
    service.shutdown();
    Ok(())
}
