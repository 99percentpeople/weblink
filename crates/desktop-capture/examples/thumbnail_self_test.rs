//! Interactive Windows thumbnail acceptance: window/WGC and screen/GDI snapshots and ownership.
#[cfg(windows)]
mod support;
#[cfg(not(windows))]
fn main() {
    eprintln!("This thumbnail test requires an interactive Windows desktop");
}
#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use weblink_desktop_capture::{
        CaptureMethod, CaptureOptions, CaptureService, CaptureState, SourceKind,
    };
    let title = format!("Weblink thumbnail self-test {}", std::process::id());
    let mut window = support::TestWindow::new(title.clone())?;
    let service = CaptureService::new()?;
    let sources = service.sources()?;
    let own = sources
        .iter()
        .find(|source| source.name == title)
        .ok_or("Test window missing")?;
    let screen = sources
        .iter()
        .find(|source| source.kind == SourceKind::Monitor)
        .ok_or("Test display missing")?;
    let options = CaptureOptions {
        backend: CaptureMethod::Wgc,
    };
    let active = service.start_with_options(own.id.clone(), options)?;
    let session = active.session_id.unwrap();
    for round in 0..2 {
        if round == 1 {
            window.resize()?;
        }
        window.repaint(round)?;
        for (source, backend) in [
            (own, CaptureMethod::Wgc),
            (screen, CaptureMethod::Wgc),
            (screen, CaptureMethod::Dxgi),
        ] {
            // Desktop pixels are decoded in memory only, never saved or sent to a peer.
            let started = std::time::Instant::now();
            let bytes = service.thumbnail(source.id.clone(), CaptureOptions { backend })?;
            let elapsed = started.elapsed().as_millis();
            let mut reader = png::Decoder::new(std::io::Cursor::new(bytes)).read_info()?;
            let mut pixels = vec![0; reader.output_buffer_size().ok_or("PNG size missing")?];
            let info = reader.next_frame(&mut pixels)?;
            assert!(info.width > 0 && info.width <= 640);
            assert!(info.height > 0 && info.height <= 360);
            let current = service.status(session.clone())?;
            assert_eq!(current.state, CaptureState::Running);
            assert_eq!(current.source.as_ref(), Some(own));
            println!(
                "PASS {:?} {:?} thumbnail {}x{}, round {round}, {elapsed} ms; active capture retained",
                source.kind, backend, info.width, info.height
            );
        }
    }
    assert!(service.thumbnail("missing-source".into(), options).is_err());
    assert_eq!(
        service.status(session.clone())?.state,
        CaptureState::Running
    );
    service.stop(session)?;
    window.close();
    assert!(service.thumbnail(own.id.clone(), options).is_err());
    service.shutdown();
    println!(
        "PASS: snapshots released, missing/closed sources rejected, existing capture preserved"
    );
    Ok(())
}
