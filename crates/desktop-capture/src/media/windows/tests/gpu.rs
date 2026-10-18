//! Real texture arrivals, GPU MFT input and WebRTC decoding; never seed CPU latest frames.
use super::vfr::{motion, static_frames, wait_for_video, Frames};
use super::*;

#[test]
#[ignore = "Requires an unlocked Windows desktop, WGC/DXGI and GPU H.264/H.265 encoders"]
fn gpu_real_desktop_backends_deliver_both_codecs_without_readback() {
    use crate::{CaptureMethod, CaptureOptions, CaptureService, SourceKind};
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let service = CaptureService::new().unwrap();
        let screen = service.sources().unwrap().into_iter().find(|s| s.kind == SourceKind::Monitor).expect("Interactive display required");
        let encoders = mf::detect().unwrap();
        assert!(!encoders.is_empty());
        for backend in [CaptureMethod::Dxgi, CaptureMethod::Wgc] {
            for info in &encoders {
                let codec = info.codecs[0].clone();
                let media = MediaSession::new(MediaOptions { encoder: info.id.clone(), codec: Some(codec.clone()), max_width: 1280, max_height: 720, frame_rate: 30, ..Default::default() }).unwrap();
                let remote = if codec == "video/h264" { Some(connect(&media, "desktop", false).await.unwrap()) } else {
                    media.offer("desktop".into(), vec![], false, false).await.unwrap(); None
                };
                let encoder = media.hardware.lock().unwrap()["desktop"].clone();
                let tap = encoder.recording.subscribe().unwrap();
                encoder.request_recording_keyframe();
                let status = service.start_media_with_options(screen.id.clone(), media.clone(), CaptureOptions { backend }).unwrap();
                assert_eq!(status.backend, Some(backend));
                let mut bytes = Vec::new();
                let mut packets = 0;
                tokio::time::timeout(Duration::from_secs(12), async {
                    while packets < 5 {
                        assert!(media.error().is_none(), "{:?}", media.error());
                        while let Ok(packet) = tap.receive(Duration::ZERO) { bytes.extend(packet.bytes); packets += 1; }
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                }).await.expect("Captured GPU frames did not reach encoder");
                if let Some(remote) = remote { assert!(decoded(&remote).await > 0); }
                let metrics = encoder.statistics();
                assert_eq!(metrics.cpu_inputs, 0, "{:?}", metrics.gpu_fallback);
                assert!(metrics.gpu_inputs >= 5);
                assert_eq!(media.pipeline_stats().frames, 0);
                if let Some(dir) = std::env::var_os("WEBLINK_GPU_PROBE_DIR") {
                    let dir = std::path::PathBuf::from(dir);
                    std::fs::create_dir_all(&dir).unwrap();
                    std::fs::write(dir.join(format!("{backend:?}-{}.{}", packets, if codec == "video/h264" {"h264"} else {"hevc"})), &bytes).unwrap();
                }
                eprintln!("Actual desktop {backend:?} {codec}: GPU={}, CPU={}, readbacks={}, packets={packets}, bytes={}", metrics.gpu_inputs, metrics.cpu_inputs, media.pipeline_stats().frames, bytes.len());
                service.stop(status.session_id.unwrap()).unwrap();
                assert!(media.hardware.lock().unwrap().is_empty());
            }
        }
        service.shutdown();
    });
}

#[test]
#[ignore = "Requires a Windows GPU with D3D11 H.264 encoding"]
fn gpu_capture_keeps_vfr_preview_software_demand_and_fallback_isolated() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let _hardware = mf::detect().unwrap().into_iter().find(|e| e.codecs.contains(&"video/h264".into())).expect("H.264 hardware encoder required");
        let media = MediaSession::new(MediaOptions { encoder: "auto".into(), codec: Some("video/h264".into()), frame_rate: 20, max_width: 640, max_height: 360, color_matrix: crate::media::color::ColorMatrix::Bt601, ..Default::default() }).unwrap();
        let frames = Frames::new();
        frames.send(&media, 0);
        let remote = connect(&media, "gpu", false).await.unwrap();
        wait_for_video(&remote).await;
        let encoder = media.hardware.lock().unwrap()["gpu"].clone();
        let idle = static_frames(&media, "gpu").await;
        let (moving, latency) = motion(&frames, &media, &remote).await;
        assert!(moving > 15, "Motion stalled: {moving}");
        let stats = encoder.statistics();
        assert!(stats.gpu_inputs > 10, "GPU fallback: {:?}", stats.gpu_fallback);
        assert_eq!(stats.cpu_inputs, 0);
        assert_eq!(media.pipeline_stats().frames, 0, "Hardware-only streaming performed a readback");

        // Even a stalled preview conversion must not block GPU encoding.
        let conversion = media.conversion.lock().unwrap();
        let preview = media.subscribe_preview(true, |_| true).unwrap();
        let (during_blocked_preview, _) = motion(&frames, &media, &remote).await;
        assert!(during_blocked_preview > 15);
        drop(conversion);
        tokio::time::timeout(Duration::from_secs(3), async {
            while media.latest_sequence.load(Ordering::Acquire) == 0 { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await.unwrap();
        preview.set_visible(false);
        tokio::time::sleep(Duration::from_millis(100)).await;
        let readbacks = media.pipeline_stats().frames;
        motion(&frames, &media, &remote).await;
        assert_eq!(media.pipeline_stats().frames, readbacks, "Hidden preview continued reading pixels");
        assert_eq!(encoder.statistics().cpu_inputs, 0, "Preview sent duplicate CPU inputs to hardware");

        // A negotiated software peer requests CPU pixels without changing the GPU peer.
        let software = connect_with_codecs(&media, "software", false, Some(crate::media::SendCodecs { video: "video/vp8".into(), audio: "audio/opus".into() })).await.unwrap();
        wait_for_video(&software).await;
        assert!(media.pipeline_stats().frames > readbacks);
        media.close_peer("software");
        media.update_video_settings(crate::media::VideoSettings { max_width: 320, max_height: 180, frame_rate: 5, max_bitrate: 1_000_000, degradation_preference: "maintain-resolution".into() }).unwrap();
        let (limited, _) = motion(&frames, &media, &remote).await;
        assert!(limited > 3 && limited <= 15, "Live FPS change failed: {limited}");

        // An unsupported GPU cursor input uses the old CPU compositor and keeps the peer.
        let invalid_cursor = crate::surface::Cursor { visible: true, width: 2, height: 2, pitch: 8, bytes: Arc::new(vec![]), ..Default::default() };
        frames.send_with_cursor(&media, 0, Some(&invalid_cursor));
        tokio::time::timeout(Duration::from_secs(5), async {
            while !encoder.needs_readback() { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await.unwrap();
        wait_for_video(&remote).await;
        assert!(encoder.statistics().cpu_inputs > 0);
        assert!(encoder.statistics().gpu_fallback.is_some());
        assert!(Arc::ptr_eq(&encoder, &media.hardware.lock().unwrap()["gpu"]));
        assert!(media.error().is_none());
        eprintln!("GPU H264: idle={idle}/2s, moving={moving}/2s, first motion={latency:?}, blocked preview={during_blocked_preview}/2s, 5FPS={limited}/2s, fallback={:?}", encoder.statistics().gpu_fallback);
        media.close();
    });
}

#[test]
#[ignore = "Requires Windows GPU H.264/H.265 encoders"]
fn gpu_recording_reuses_both_codecs_and_keeps_pause_resume_and_slow_sinks_off_transport() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let hardware = mf::detect().unwrap();
        assert!(!hardware.is_empty());
        for info in hardware {
            let codec = info.codecs[0].clone();
            let media = MediaSession::new(MediaOptions { encoder: info.id, codec: Some(codec.clone()), frame_rate: 20, max_width: 640, max_height: 360, ..Default::default() }).unwrap();
            // An offer starts the same encoder used by a normal transport; HEVC decoding
            // is not provided by every libwebrtc build, so inspect its original packets.
            let remote = if codec == "video/h264" { Some(connect(&media, "sender", false).await.unwrap()) } else {
                media.offer("sender".into(), vec![], false, false).await.unwrap(); None
            };
            let frames = Frames::new();
            frames.send(&media, 0);
            let encoder = media.hardware.lock().unwrap()["sender"].clone();
            tokio::time::timeout(Duration::from_secs(5), async {
                while encoder.statistics().frames == 0 { tokio::time::sleep(Duration::from_millis(10)).await; }
            }).await.unwrap();
            if codec == "video/h265" {
                let tap = encoder.recording.subscribe().unwrap();
                for segment in [1, 2] {
                    encoder.recording.set_active(&tap, true, segment);
                    encoder.request_recording_keyframe();
                    let mut count = 0;
                    for index in 0..20 {
                        frames.send(&media, index);
                        tokio::time::sleep(Duration::from_millis(55)).await;
                        while let Ok(packet) = tap.receive(Duration::ZERO) {
                            assert_eq!(packet.kind, crate::media::recording::PacketKind::Video { codec: 2, width: 640, height: 360 });
                            assert_eq!(packet.segment, segment);
                            if count == 0 { assert!(packet.keyframe); }
                            count += 1;
                        }
                    }
                    assert!(count > 5);
                    encoder.recording.set_active(&tap, false, segment);
                    while tap.receive(Duration::ZERO).is_ok() {}
                    frames.send(&media, 0);
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    assert!(tap.receive(Duration::ZERO).is_err());
                }
                encoder.recording.unsubscribe(&tap);
                assert_eq!(encoder.statistics().cpu_inputs, 0);
                assert!(encoder.statistics().gpu_inputs > 10);
                eprintln!("GPU HEVC recording packets: pause/resume/keyframes verified (without a HEVC WebRTC decoder)");
                media.close();
                continue;
            }
            assert!(media.open_recording("gpu".into(), true).unwrap().is_some());
            for segment in [1, 2] {
                media.control_recording("gpu", true, segment).unwrap();
                let before = encoder.statistics().frames;
                let mut data = Vec::new();
                let start = Instant::now();
                while start.elapsed() < Duration::from_secs(1) {
                    frames.send(&media, data.len());
                    let source = media.clone();
                    data.extend(tokio::task::spawn_blocking(move || source.read_recording("gpu").unwrap()).await.unwrap());
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
                assert!(data.len() > 36);
                assert_eq!(data[32], 0);
                assert_eq!(data[33], if codec == "video/h264" { 1 } else { 2 });
                assert_eq!(data[34], 1, "A resumed segment must start on a keyframe");
                assert_eq!(u32::from_le_bytes(data[4..8].try_into().unwrap()), segment);
                assert!(encoder.statistics().frames > before);
                media.control_recording("gpu", false, segment).unwrap();
                frames.send(&media, segment as usize);
                tokio::time::sleep(Duration::from_millis(150)).await;
                assert!(media.read_recording("gpu").unwrap().is_empty());
            }
            media.close_recording("gpu");
            let slow = encoder.recording.subscribe().unwrap();
            encoder.request_recording_keyframe();
            let before = encoder.statistics().frames;
            for n in 0..45 { frames.send(&media, n); tokio::time::sleep(Duration::from_millis(50)).await; }
            assert!(encoder.statistics().frames > before + 10);
            assert!(slow.error().is_some(), "Stalled recording should detach");
            encoder.recording.unsubscribe(&slow);
            if let Some(remote) = remote { assert!(decoded(&remote).await > 10); }
            assert_eq!(media.hardware.lock().unwrap().len(), 1);
            assert_eq!(encoder.statistics().cpu_inputs, 0, "{:?}", encoder.statistics().gpu_fallback);
            assert_eq!(media.pipeline_stats().frames, 0);
            eprintln!("GPU {codec} recording: {} inputs, pause/resume/keyframes and slow-sink isolation passed", encoder.statistics().gpu_inputs);
            media.close();
        }
    });
}
