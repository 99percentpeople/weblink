//! Two own-window native shares, with independent raw preview and browser RTP.
//! Exchange offer-{1,2}.sdp / answer-{1,2}.sdp in the supplied fresh directory.
//! Then write stop-first, verify receiver 2 continues, and write done.
#[cfg(windows)]
mod support;

#[cfg(not(windows))]
fn main() {
    eprintln!("This media test requires Windows");
}

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{
        path::PathBuf,
        sync::Arc,
        time::{Duration, Instant},
    };
    use weblink_desktop_capture::{
        media::{preview::BUFFER_SIZE, MediaOptions, MediaSession, VideoSettings},
        CaptureService, CaptureState,
    };
    tokio::runtime::Runtime::new()?.block_on(async {
        let dir = PathBuf::from(std::env::args().nth(1).ok_or("Missing fresh exchange directory")?);
        std::fs::create_dir_all(&dir)?;
        let service = Arc::new(CaptureService::new()?);
        let options = MediaOptions {
            codec: Some("video/h264".into()), encoder: "software".into(),
            max_width: 640, max_height: 480, frame_rate: 30,
            max_bitrate: 2_000_000, audio: false,
            ..MediaOptions::default()
        };
        let mut windows = Vec::new();
        let mut shares = Vec::new();
        for index in 1..=2 {
            let title = format!("Weblink multi media {}-{index}", std::process::id());
            windows.push(support::TestWindow::new(title.clone())?);
            let source = service.sources()?.into_iter().find(|s| s.name == title).ok_or("Missing test window")?;
            let media = MediaSession::new(options.clone())?;
            let id = service.start_media(source.id, media.clone())?.session_id.unwrap();
            assert!(Arc::ptr_eq(&service.media(id.clone())?, &media));
            shares.push((id, media));
        }
        assert_ne!(shares[0].0, shares[1].0);
        // An invalid third selection must leave both existing captures alive.
        assert!(service.start("not-a-source".into()).is_err());
        let heartbeat_service = service.clone();
        let ids: Vec<_> = shares.iter().map(|(id, _)| id.clone()).collect();
        let heartbeat = tokio::spawn(async move {
            loop {
                for id in &ids { let _ = heartbeat_service.status(id.clone()); }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
        for (index, (_, media)) in shares.iter().enumerate() {
            let index = index + 1;
            let offer = media.offer(format!("browser-{index}"), vec![], false, false).await?;
            std::fs::write(dir.join(format!("offer-{index}.sdp")), offer)?;
        }
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut answered = [false; 2];
        let mut first_stopped = false;
        let mut sequence = [0; 2];
        let mut preview = vec![0; BUFFER_SIZE];
        let mut frame = 0;
        while !dir.join("done").exists() {
            if Instant::now() > deadline { return Err("Browser validation timed out".into()); }
            frame += 1;
            for (index, (id, media)) in shares.iter().enumerate() {
                if first_stopped && index == 0 { continue; }
                windows[index].repaint(frame)?;
                let answer = dir.join(format!("answer-{}.sdp", index + 1));
                if !answered[index] && answer.exists() {
                    media.answer(&format!("browser-{}", index + 1), &std::fs::read_to_string(answer)?).await?;
                    answered[index] = true;
                }
                assert_eq!(service.status(id.clone())?.state, CaptureState::Running);
                if let Some(next) = media.copy_preview_frame(sequence[index], &mut preview)? {
                    sequence[index] = next.sequence;
                }
            }
            if !first_stopped && dir.join("stop-first").exists() {
                assert!(answered.iter().all(|v| *v));
                assert!(sequence.iter().all(|v| *v > 0), "Both raw previews must receive frames");
                assert_eq!(service.stop(shares[0].0.clone())?.state, CaptureState::Stopped);
                assert!(service.media(shares[0].0.clone()).is_err());
                assert!(shares[0].1.copy_preview_frame(0, &mut preview).is_err());
                windows[0].close();
                // Live settings and source resize on the survivor use its own media handle.
                service.media(shares[1].0.clone())?.update_video_settings(VideoSettings {
                    max_width: 320, max_height: 240, frame_rate: 15,
                    max_bitrate: 1_000_000, degradation_preference: "maintain-resolution".into(),
                })?;
                windows[1].resize()?;
                std::fs::write(dir.join("first-stopped"), sequence[1].to_string())?;
                first_stopped = true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(first_stopped);
        let before: u64 = std::fs::read_to_string(dir.join("first-stopped"))?.parse()?;
        assert!(sequence[1] > before, "Surviving raw preview must continue");
        windows[1].close();
        let deadline = Instant::now() + Duration::from_secs(8);
        while service.status(shares[1].0.clone())?.state != CaptureState::Closed {
            if Instant::now() > deadline { return Err("Source closure did not release its session".into()); }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(service.media(shares[1].0.clone()).is_err());
        heartbeat.abort();
        service.shutdown();
        println!("PASS: two captures, distinct media handles, raw previews, RTP, independent stop/settings/source closure");
        Ok(())
    })
}
