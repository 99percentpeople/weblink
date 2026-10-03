//! Own-window WGC -> native encoder -> browser WebRTC acceptance harness.
//! Run interactively with a directory argument. Exchange offer.sdp / answer.sdp
//! with a browser receiver, then create resize and done files after checking RTP.
#[cfg(windows)]
mod support;
#[cfg(not(windows))]
fn main() {
    eprintln!("This media test requires Windows");
}
#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    tokio::runtime::Runtime::new()?.block_on(async {
        use std::{path::PathBuf, sync::Arc, time::{Duration, Instant}};
        use weblink_desktop_capture::{media::{MediaSession, MediaOptions, VideoSettings}, CaptureService, CaptureState};
        let dir = PathBuf::from(std::env::args().nth(1).ok_or("Missing exchange directory")?);
        std::fs::create_dir_all(&dir)?;
        for name in ["offer.sdp", "answer.sdp", "resize", "motion", "done", "mute-audio", "video-settings", "video-settings.applied"] { let _ = std::fs::remove_file(dir.join(name)); }
        let title = format!("Weblink native media self-test {}", std::process::id());
        let mut window = support::TestWindow::new(title.clone())?;
        let service = Arc::new(CaptureService::new()?);
        let source = service.sources()?.into_iter().find(|s| s.name == title).ok_or("Test source missing")?;
        let codec = std::env::args().nth(2).filter(|s| s != "auto");
        let burst = std::env::args().any(|arg| arg == "--scene-burst");
        let options = MediaOptions {
            audio: std::env::args().any(|arg| arg == "--audio"),
            codec,
            max_width: if burst { 1280 } else { 640 },
            max_height: if burst { 720 } else { 480 },
            frame_rate: if burst { 30 } else { 15 },
            max_bitrate: if burst { 8_000_000 } else { 1_000_000 },
            degradation_preference: "maintain-resolution".into(),
            encoder: std::env::args().nth(3).unwrap_or_else(|| "software".into()),
            ..Default::default()
        };
        println!("native codecs: {:?}; settings: {:?}", MediaSession::codecs(), options);
        assert!(MediaSession::new(MediaOptions { codec: Some("video/unsupported".into()), ..options.clone() }).is_err());
        let media = MediaSession::new(options)?;
        let id = service.start_media(source.id, media.clone())?.session_id.unwrap();
        let heartbeat_service = service.clone();
        let heartbeat_id = id.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if heartbeat_service.status(heartbeat_id.clone()).is_err() { break; }
            }
        });
        std::fs::write(dir.join("offer.sdp"), media.offer("browser-test".into(), vec![], false, std::env::args().any(|arg| arg == "--preview")).await?)?;
        println!("native offer ready");
        let deadline = Instant::now() + Duration::from_secs(100);
        while !dir.join("answer.sdp").exists() {
            if Instant::now() > deadline { return Err("Browser answer timed out".into()); }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        media.answer("browser-test", &std::fs::read_to_string(dir.join("answer.sdp"))?).await?;
        let mut resized = false;
        let mut reported = false;
        let mut repaint = 0;
        let mut audio_muted = false;
        let mut applied_settings = String::new();
        while !dir.join("done").exists() {
            if let Ok(text) = std::fs::read_to_string(dir.join("video-settings")) {
                if text != applied_settings {
                    let values: Vec<_> = text.split_whitespace().collect();
                    if values.len() != 5 { return Err("Invalid test video settings".into()); }
                    service.media(id.clone())?.update_video_settings(VideoSettings {
                        max_width: values[0].parse()?, max_height: values[1].parse()?,
                        frame_rate: values[2].parse()?, max_bitrate: values[3].parse()?,
                        degradation_preference: values[4].into(),
                    })?;
                    std::fs::write(dir.join("video-settings.applied"), &text)?;
                    println!("live settings applied in session {}: {}", id, text.trim());
                    applied_settings = text;
                }
            }
            let muted = dir.join("mute-audio").exists();
            if audio_muted != muted { media.set_audio_enabled(!muted); audio_muted = muted; }
            if Instant::now() > deadline { return Err("Browser media validation timed out".into()); }
            if dir.join("motion").exists() { repaint += 1; if burst { window.scene(repaint)?; } else { window.repaint(repaint)?; } }
            else if burst && repaint > 0 { window.repaint(0)?; repaint = 0; }
            if !resized && dir.join("resize").exists() { window.resize()?; resized = true; println!("test window resized"); }
            let status = service.status(id.clone())?;
            if resized && !reported && status.width > 640 { println!("resized capture: {:?}", status); reported = true; }
            if status.state != CaptureState::Running { return Err("Capture ended early".into()); }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let status = service.status(id.clone())?;
        println!("native capture: {} frames, {}x{}", status.frames, status.width, status.height);
        window.close();
        let closing_deadline = Instant::now() + Duration::from_secs(8);
        while service.status(id.clone())?.state != CaptureState::Closed {
            if Instant::now() >= closing_deadline { return Err("Source closure did not stop native media".into()); }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(service.media(id).is_err());
        heartbeat.abort();
        service.shutdown();
        println!("PASS: native offer/answer, own-window capture, resize and source-close transport cleanup");
        Ok(())
    })
}
