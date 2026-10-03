use super::*;
use crate::media::color::{ColorFormat, ColorRange};

async fn full_chroma_session(format: ColorFormat) {
    let media = MediaSession::new(MediaOptions {
        color_format: format,
        color_range: ColorRange::Full,
        codec: Some("video/vp9".into()),
        encoder: "software".into(),
        max_width: 640,
        max_height: 360,
        frame_rate: 30,
        max_bitrate: 8_000_000,
        ..Default::default()
    })
    .unwrap();
    let weak = Arc::downgrade(&media);
    // Cancellation and rejected negotiation must release partial peer state.
    let offer = media
        .offer("cancel".into(), vec![], false, false)
        .await
        .unwrap();
    assert!(offer.contains("profile-id=1"));
    assert!(!offer.contains("profile-id=0"));
    media.close_peer("cancel");
    media
        .offer("unsupported".into(), vec![], false, false)
        .await
        .unwrap();
    assert!(media
        .answer(
            "unsupported",
            &offer.replace("profile-id=1", "profile-id=0")
        )
        .await
        .is_err());
    assert!(media.peers.lock().unwrap().is_empty());
    let receiver = connect(&media, "color", true).await.unwrap();
    for (width, height) in [(640, 360), (320, 180)] {
        let before = decoded(&receiver).await;
        let bytes = [0, 0, 255, 255, 255, 0, 0, 255].repeat(width * height / 2);
        let options = media.options.lock().unwrap().clone();
        let frame = Arc::new(VideoFrame::new(
            VideoRotation::VideoRotation0,
            Pixels::from_bgra(
                &bytes,
                width as u32 * 4,
                width as u32,
                height as u32,
                &options,
            ),
        ));
        *media.latest.lock().unwrap() = Some(frame.clone());
        media.latest_sequence.fetch_add(1, Ordering::Relaxed);
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                media.publish_frame_at(&frame, None);
                if decoded(&receiver).await >= before + 8 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(33)).await;
            }
        })
        .await
        .expect("Full-chroma frames failed to decode after init/resize");
        // Regression: acquiring the same options mutex twice inside a struct
        // initializer deadlocked this stats request and the capture worker.
        let stats = tokio::time::timeout(Duration::from_secs(2), media.stats("color"))
            .await
            .unwrap()
            .unwrap();
        assert!(stats.iter().any(|s| s.width == width as u32
            && s.height == height as u32
            && s.color_format == format
            && s.chroma_subsampling == "4:4:4"
            && s.implementation.contains("4:4:4")));
        let mut preview = vec![0; width * height * 4];
        let info = media.copy_preview_frame(0, &mut preview).unwrap().unwrap();
        assert_eq!(
            info.format,
            if format == ColorFormat::Rgb {
                "BGRA"
            } else {
                "I444"
            }
        );
        if format == ColorFormat::Rgb {
            assert_eq!(preview, bytes);
        }
    }
    media.close();
    assert!(media.peers.lock().unwrap().is_empty());
    assert!(media.hardware.lock().unwrap().is_empty());
    drop(receiver);
    drop(media);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(weak.upgrade().is_none());
}

#[test]
fn full_chroma_encodes_resizes_and_cleans_up_after_rejected_answers() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        for format in [ColorFormat::Rgb, ColorFormat::Yuv444] {
            full_chroma_session(format).await;
        }
    });
}

#[test]
#[ignore = "Process handle baseline requires an isolated test process; run with --ignored --test-threads=1"]
fn full_chroma_repeated_lifecycle_releases_native_handles() {
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};
    let handles = || {
        let mut count = 0;
        // SAFETY: current-process pseudo-handle is borrowed; count lives through the call.
        unsafe {
            GetProcessHandleCount(GetCurrentProcess(), &mut count).unwrap();
        }
        count
    };
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        full_chroma_session(ColorFormat::Rgb).await; // warm process-wide WebRTC resources
        let baseline = handles();
        for _ in 0..4 {
            full_chroma_session(ColorFormat::Rgb).await;
            full_chroma_session(ColorFormat::Yuv444).await;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        let after = handles();
        assert!(
            after <= baseline + 4,
            "Native handles grew from {baseline} to {after}"
        );
    });
}

#[test]
fn normal_offers_do_not_advertise_full_chroma_for_subsampled_input() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let media = MediaSession::new(MediaOptions {
            encoder: "software".into(),
            ..Default::default()
        })
        .unwrap();
        let offer = media
            .offer("normal".into(), vec![], false, false)
            .await
            .unwrap();
        assert!(!offer.contains("profile-id=1"));
        assert!(offer.contains("profile-id=0"));
        media.close();
    });
}
