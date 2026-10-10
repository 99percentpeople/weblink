use super::*;
use crate::surface::Rotation;
use libwebrtc::video_frame::{I420Buffer, VideoRotation};
use libwebrtc::{
    peer_connection::AnswerOptions, stats::RtcStats, video_stream::native::NativeVideoStream,
};
mod latency_probe;

#[test]
fn capture_owner_observes_media_errors_before_or_after_subscription_and_detaches() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        for late in [false, true] {
            let media = MediaSession::new(MediaOptions {
                encoder: "software".into(),
                ..Default::default()
            })
            .unwrap();
            let (send, receive) = std::sync::mpsc::channel();
            let changed = crate::lifecycle::Changed::new(move || {
                let _ = send.send(());
            });
            if late {
                media.fail("test conversion failure".into());
            }
            media.set_changed(changed.clone());
            if !late {
                media.fail("test conversion failure".into());
            }
            receive.recv_timeout(Duration::from_secs(1)).unwrap();
            assert_eq!(media.error().as_deref(), Some("test conversion failure"));
            changed.acknowledge();
            media.set_changed(Default::default());
            media.fail("late failure after detach".into());
            assert!(receive.try_recv().is_err());
            media.close();
        }
    });
}

// Synchronously drain a synthetic frame in tests that inspect converted pixels.
// Production awaits GPU completion events without waiting in a graphics call.
impl MediaSession {
    pub(super) fn flush(self: &Arc<Self>) -> Result<()> {
        let _preview = self.subscribe_preview(true, |_| true)?;
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut work = self.capture_step(true)?;
        while work.pending.is_some() || work.dirty {
            if Instant::now() >= deadline {
                return Err("Synthetic readback did not complete".into());
            }
            std::thread::sleep(Duration::from_millis(1));
            work = self.capture_step(true)?;
        }
        Ok(())
    }
}

#[test]
#[ignore = "Requires Windows process-loopback support; initializes clients without recording"]
fn discovers_process_loopback_formats_without_starting_capture() {
    let formats = MediaSession::audio_formats().expect("Windows audio format discovery failed");
    assert!(!formats.is_empty());
    assert!(formats
        .iter()
        .any(|format| format.sample_rate == 48000 && format.channel_count == 2));
    for format in &formats {
        assert!(crate::media::AUDIO_SAMPLE_RATES.contains(&format.sample_rate));
        assert!(crate::media::AUDIO_CHANNEL_COUNTS.contains(&format.channel_count));
    }
    println!("Available process-loopback formats: {formats:?}");
}

#[test]
fn closing_a_native_peer_or_session_cancels_pending_ice_waiters() {
    use std::{
        future::{poll_fn, Future},
        task::Poll,
    };
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        for close_session in [false, true] {
            let media = MediaSession::new(MediaOptions {
                encoder: "software".into(),
                ..Default::default()
            })
            .unwrap();
            let pc = media
                .factory
                .create_peer_connection(Default::default())
                .unwrap();
            let gathering = Arc::new(ice::Gathering::new());
            media.peers.lock().unwrap().insert(
                "pending".into(),
                MediaPeer {
                    connection: pc,
                    gathering: gathering.clone(),
                    preview: false,
                    control: None,
                },
            );
            let mut waiting = Box::pin(gathering.wait());
            poll_fn(|cx| {
                assert!(waiting.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            if close_session {
                media.close();
            } else {
                media.close_peer("pending");
            }
            gathering.complete();
            let result = tokio::time::timeout(Duration::from_secs(1), waiting)
                .await
                .unwrap();
            assert_eq!(result.unwrap_err(), "Native media connection closed");
            assert!(media.peers.lock().unwrap().is_empty());
        }
    });
}

#[test]
fn sender_timing_rejects_invalid_rtp_ranges_and_pacing_before_native_startup() {
    use libwebrtc::peer_connection_factory::VideoSendOptions;
    for (min, max) in [
        (1, Some(50)),
        (60, Some(50)),
        (10, None),
        (u32::MAX, Some(50)),
    ] {
        assert!(
            PeerConnectionFactory::with_video_send_options(VideoSendOptions {
                min_playout_delay_ms: min,
                max_playout_delay_ms: max,
                ..Default::default()
            })
            .is_err()
        );
    }
    for delay in [1, 40960, u32::MAX] {
        assert!(PeerConnectionFactory::with_video_send_timing(Some(delay), None).is_err());
        assert!(
            PeerConnectionFactory::with_video_send_options(VideoSendOptions {
                max_playout_delay_ms: Some(delay),
                software_h264_external_frame_dropper: true,
                ..Default::default()
            })
            .is_err()
        );
    }
    for factor in [f32::NAN, f32::INFINITY, 0.0, 0.9, 2.6] {
        assert!(PeerConnectionFactory::with_video_send_timing(None, Some(factor)).is_err());
        assert!(
            PeerConnectionFactory::with_video_send_options(VideoSendOptions {
                pacing_factor: Some(factor),
                software_h264_external_frame_dropper: true,
                ..Default::default()
            })
            .is_err()
        );
    }
}

struct Receiver {
    pc: PeerConnection,
    _sinks: Arc<Mutex<Vec<NativeVideoStream>>>,
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.pc.close();
    }
}

async fn connect(media: &MediaSession, id: &str, preview: bool) -> Result<Receiver> {
    let factory = PeerConnectionFactory::default();
    let mut config = RtcConfiguration::default();
    config.continual_gathering_policy = ContinualGatheringPolicy::GatherOnce;
    let pc = factory
        .create_peer_connection(config)
        .map_err(|e| e.to_string())?;
    let sinks = Arc::new(Mutex::new(Vec::new()));
    let receiving = sinks.clone();
    pc.on_track(Some(Box::new(move |event| {
        if let MediaStreamTrack::Video(track) = event.track {
            receiving
                .lock()
                .unwrap()
                .push(NativeVideoStream::new(track));
        }
    })));
    let receiver = Receiver { pc, _sinks: sinks };
    let candidates = Arc::new(Mutex::new(Vec::new()));
    let gathered = candidates.clone();
    receiver
        .pc
        .on_ice_candidate(Some(Box::new(move |candidate| {
            gathered.lock().unwrap().push(candidate.to_string());
        })));
    let offer = media.offer(id.into(), vec![], false, preview).await?;
    receiver
        .pc
        .set_remote_description(
            SessionDescription::parse(&offer, SdpType::Offer).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
    let answer = receiver
        .pc
        .create_answer(AnswerOptions::default())
        .await
        .map_err(|e| e.to_string())?;
    let mut sdp = answer.to_string();
    receiver
        .pc
        .set_local_description(answer)
        .await
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(10), async {
        while receiver.pc.ice_gathering_state() != IceGatheringState::Complete {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    for candidate in candidates.lock().unwrap().iter() {
        sdp.push_str(&format!("a={}\r\n", candidate.trim()));
    }
    sdp.push_str("a=end-of-candidates\r\n");
    media.answer(id, &sdp).await?;
    Ok(receiver)
}

async fn decoded(receiver: &Receiver) -> u32 {
    receiver
        .pc
        .get_stats()
        .await
        .unwrap()
        .into_iter()
        .filter_map(|stat| {
            if let RtcStats::InboundRtp(stat) = stat {
                Some(stat.inbound.frames_decoded)
            } else {
                None
            }
        })
        .sum()
}

#[test]
fn standard_vp9_still_encodes_i420_without_the_custom_full_chroma_encoder() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let media = MediaSession::new(MediaOptions {
            codec: Some("video/vp9".into()),
            encoder: "software".into(),
            max_width: 320,
            max_height: 180,
            ..Default::default()
        })
        .unwrap();
        let weak = Arc::downgrade(&media);
        let offer = media
            .offer("probe".into(), vec![], false, false)
            .await
            .unwrap();
        assert!(offer.contains("profile-id=0"));
        assert!(!offer.contains("profile-id=1"));
        media.close_peer("probe");
        let receiver = connect(&media, "vp9", false).await.unwrap();
        let frame = VideoFrame::new(
            VideoRotation::VideoRotation0,
            I420Buffer::new_black(320, 180),
        );
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                media.publish_frame(&frame);
                if decoded(&receiver).await >= 3 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(33)).await;
            }
        })
        .await
        .expect("Standard VP9 frames failed to decode");
        let stats = media.stats("vp9").await.unwrap();
        assert!(stats
            .iter()
            .any(|s| s.codec.eq_ignore_ascii_case("video/vp9") && s.chroma_subsampling == "4:2:0"));
        media.close();
        assert!(media.peers.lock().unwrap().is_empty());
        drop(receiver);
        drop(media);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(weak.upgrade().is_none());
    });
}

#[test]
fn updates_live_senders_and_keeps_preview_quality_and_session_identity() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let media = MediaSession::new(MediaOptions {
            encoder: "software".into(),
            codec: Some("video/vp8".into()),
            ..Default::default()
        })
        .unwrap();
        let _preview = connect(&media, "preview", true).await.unwrap();
        let _remote = connect(&media, "remote", false).await.unwrap();
        for (fps, bitrate, preference) in [
            (15, 500_000, "maintain-framerate"),
            (60, 4_000_000, "balanced"),
        ] {
            media
                .update_video_settings(VideoSettings {
                    max_width: 1280,
                    max_height: 720,
                    frame_rate: fps,
                    max_bitrate: bitrate,
                    degradation_preference: preference.into(),
                })
                .unwrap();
            assert_eq!(
                media.options.lock().unwrap().codec.as_deref(),
                Some("video/vp8")
            );
            let peers = media.peers.lock().unwrap();
            assert_eq!(peers.len(), 2);
            for id in ["preview", "remote"] {
                let peer = peers.get(id).unwrap();
                let params = peer.connection.senders().remove(0).parameters();
                assert_eq!(params.encodings[0].max_framerate, Some(fps as f64));
                assert_eq!(params.encodings[0].max_bitrate, Some(bitrate));
                let expected = if id == "preview" {
                    DegradationPreference::MaintainResolution
                } else if preference == "maintain-framerate" {
                    DegradationPreference::MaintainFramerate
                } else {
                    DegradationPreference::Balanced
                };
                assert_eq!(params.degradation_preference(), Some(expected));
            }
        }
        media.close();
        assert!(media
            .update_video_settings(VideoSettings {
                max_width: 1280,
                max_height: 720,
                frame_rate: 30,
                max_bitrate: 1_000_000,
                degradation_preference: "balanced".into()
            })
            .is_err());
    });
}

#[test]
fn preview_keeps_1440p_with_software_and_available_hardware_encoding() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        for encoder in ["software", "auto"] {
            let media = MediaSession::new(MediaOptions {
                audio: false,
                max_width: 2560,
                max_height: 1440,
                frame_rate: 15,
                max_bitrate: 25_000_000,
                codec: Some(
                    if encoder == "software" {
                        "video/vp8"
                    } else {
                        "video/h264"
                    }
                    .into(),
                ),
                encoder: encoder.into(),
                degradation_preference: "maintain-framerate".into(),
                ..Default::default()
            })
            .unwrap();
            let preview = connect(&media, "full-preview", true).await.unwrap();
            let frame = VideoFrame::new(
                VideoRotation::VideoRotation0,
                I420Buffer::new_black(2560, 1440),
            );
            tokio::time::timeout(Duration::from_secs(8), async {
                loop {
                    media.publish_frame(&frame);
                    assert!(media.error().is_none(), "{:?}", media.error());
                    for stat in preview.pc.get_stats().await.unwrap() {
                        if let RtcStats::InboundRtp(stat) = stat {
                            if stat.inbound.frames_decoded >= 5 {
                                assert_eq!(
                                    (stat.inbound.frame_width, stat.inbound.frame_height),
                                    (2560, 1440),
                                    "Preview silently reduced resolution with {encoder}"
                                );
                                return;
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(66)).await;
                }
            })
            .await
            .expect("Full-resolution preview did not decode");
            if media.encoder_id.is_some() {
                assert!(media.hardware.lock().unwrap().contains_key("full-preview"));
            }
            media.close();
        }
    });
}

// Uses synthetic pixels and local WebRTC only; no desktop/session access or Tauri.
// A constrained preview used to throttle BOTH receivers through their shared source.
#[test]
fn preview_adaptation_does_not_throttle_remote_video() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let media = MediaSession::new(MediaOptions {
            frame_rate: 60,
            codec: Some("video/vp8".into()),
            degradation_preference: "maintain-framerate".into(),
            ..Default::default()
        })
        .unwrap();
        let remote = connect(&media, "remote", false).await.unwrap();
        let preview = connect(&media, "preview", true).await.unwrap();
        let pc = media
            .peers
            .lock()
            .unwrap()
            .get("preview")
            .unwrap()
            .connection
            .clone();
        let sender = pc.senders().remove(0);
        let mut parameters = sender.parameters();
        parameters.encodings[0].max_framerate = Some(5.0);
        sender.set_parameters(parameters).unwrap();

        let mut cadence = tokio::time::interval(Duration::from_millis(33));
        cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        for index in 0..120 {
            cadence.tick().await;
            let mut buffer = I420Buffer::new_black(320, 180);
            buffer.data_mut().0.fill(40 + (index % 160) as u8);
            media.publish_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buffer));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        let remote_frames = decoded(&remote).await;
        let preview_frames = decoded(&preview).await;
        media.close();
        assert!(
            preview_frames >= 5,
            "Preview did not receive video: {preview_frames}"
        );
        assert!(
            remote_frames > preview_frames * 2,
            "Preview limited the remote source: remote={remote_frames}, preview={preview_frames}"
        );
    });
}

#[test]
fn unreachable_stun_does_not_block_trickle_video() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let media = MediaSession::new(MediaOptions {
            codec: Some("video/vp8".into()),
            ..Default::default()
        }).unwrap();
        let factory = PeerConnectionFactory::default();
        let mut config = RtcConfiguration::default();
        config.ice_servers = vec![libwebrtc::peer_connection_factory::IceServer {
            urls: vec!["stun:127.0.0.1:9".into()], username: String::new(), password: String::new(),
        }];
        let pc = factory.create_peer_connection(config).unwrap();
        let sinks = Arc::new(Mutex::new(Vec::new()));
        let receiving = sinks.clone();
        pc.on_track(Some(Box::new(move |event| {
            if let MediaStreamTrack::Video(track) = event.track {
                receiving.lock().unwrap().push(NativeVideoStream::new(track));
            }
        })));
        let receiver = Receiver { pc, _sinks: sinks };
        let (native_tx, mut native_rx) = tokio::sync::mpsc::unbounded_channel();
        let (browser_tx, mut browser_rx) = tokio::sync::mpsc::unbounded_channel();
        receiver.pc.on_ice_candidate(Some(Box::new(move |candidate| {
            let _ = browser_tx.send(IceCandidate {
                candidate: candidate.to_string(), sdp_mid: Some(candidate.sdp_mid()),
                sdp_m_line_index: u16::try_from(candidate.sdp_mline_index()).ok(),
            });
        })));
        let started = Instant::now();
        let offer = media.offer_trickle("trickle".into(), vec![IceServer {
            urls: vec!["stun:127.0.0.1:9".into()], username: String::new(), credential: String::new(),
        }], false, false, Box::new(move |candidate| { let _ = native_tx.send(candidate); })).await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(3), "Offer blocked on unreachable STUN");
        receiver.pc.set_remote_description(SessionDescription::parse(&offer, SdpType::Offer).unwrap()).await.unwrap();
        let answer = receiver.pc.create_answer(AnswerOptions::default()).await.unwrap();
        let answer_sdp = answer.to_string();
        receiver.pc.set_local_description(answer).await.unwrap();
        media.answer("trickle", &answer_sdp).await.unwrap();
        let mut cadence = tokio::time::interval(Duration::from_millis(33));
        let mut frames = 0_u8;
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                tokio::select! {
                    Some(candidate) = native_rx.recv() => {
                        receiver.pc.add_ice_candidate(libwebrtc::ice_candidate::IceCandidate::parse(
                            candidate.sdp_mid.as_deref().unwrap(), i32::from(candidate.sdp_m_line_index.unwrap()), &candidate.candidate,
                        ).unwrap()).await.unwrap();
                    }
                    Some(candidate) = browser_rx.recv() => { media.add_ice_candidate("trickle", candidate).await.unwrap(); }
                    _ = cadence.tick() => {
                        let mut buffer = I420Buffer::new_black(320, 180);
                        frames = frames.wrapping_add(1);
                        buffer.data_mut().0.fill(frames);
                        media.publish_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buffer));
                        if decoded(&receiver).await >= 5 { break; }
                    }
                }
            }
        }).await.expect("Trickle connection did not decode video with unavailable STUN");
        media.close_peer("trickle");
        assert!(media.peers.lock().unwrap().is_empty());
        media.close();
    });
}

// Runs only registered, successfully activated hardware transforms; no screen pixels.
#[test]
fn hardware_h264_reaches_receiver_and_releases_peer_encoder() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let Some(encoder) = mf::detect().unwrap().into_iter().next() else {
            eprintln!("No usable Windows hardware H.264 transform; hardware integration skipped");
            return;
        };
        eprintln!("Hardware integration: {} ({})", encoder.name, encoder.id);
        let media = MediaSession::new(MediaOptions {
            encoder: encoder.id,
            codec: Some("video/h264".into()),
            frame_rate: 30,
            ..Default::default()
        })
        .unwrap();
        let remote = connect(&media, "hardware", false).await.unwrap();
        let mut cadence = tokio::time::interval(Duration::from_millis(33));
        cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        for index in 0..150 {
            cadence.tick().await;
            let mut buffer = I420Buffer::new_black(640, 360);
            buffer.data_mut().0.fill(40 + (index % 160) as u8);
            media.publish_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buffer));
            assert!(media.error().is_none(), "{:?}", media.error());
        }
        let frames = decoded(&remote).await;
        eprintln!("Hardware decoded {frames} frames");
        let stats = media.stats("hardware").await.unwrap();
        assert_eq!(stats.len(), 1);
        assert!(stats[0].codec.eq_ignore_ascii_case("video/h264"));
        assert_eq!((stats[0].width, stats[0].height), (640, 360));
        assert!(stats[0].bytes > 0 && stats[0].frames > 0);
        assert!(
            stats[0].encode_frames > 0 && stats[0].encode_seconds > 0.0,
            "Must measure MF input-to-output time, not passthrough time: {:?}",
            stats
        );
        media.close_peer("hardware");
        assert!(media.stats("hardware").await.is_err());
        assert!(media.hardware.lock().unwrap().is_empty());
        media.close();
        assert!(frames >= 20, "Hardware stream did not decode: {frames}");
    });
}

#[test]
fn hardware_motion_recovers_after_idle_and_bitrate_changes() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let Some(encoder) = mf::detect().unwrap().into_iter().next() else {
            eprintln!("No usable Windows hardware H.264 transform; recovery integration skipped");
            return;
        };
        let media = MediaSession::new(MediaOptions {
            encoder: encoder.id,
            codec: Some("video/h264".into()),
            frame_rate: 60,
            max_bitrate: 4_000_000,
            degradation_preference: "maintain-framerate".into(),
            ..Default::default()
        })
        .unwrap();
        let remote = connect(&media, "recovery", false).await.unwrap();
        async fn phase(media: &MediaSession, remote: &Receiver, name: &str, fps: u64) -> f64 {
            let first = decoded(remote).await;
            let started = Instant::now();
            let mut cadence = tokio::time::interval(Duration::from_secs_f64(1.0 / fps as f64));
            cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut index = 0;
            while started.elapsed() < Duration::from_secs(4) {
                cadence.tick().await;
                let mut buffer = I420Buffer::new_black(640, 360);
                let (stride, _, _) = buffer.strides();
                let y = buffer.data_mut().0;
                for row in 0..360_usize {
                    for col in 0..640_usize {
                        y[row * stride as usize + col] =
                            32 + (((col + index * 8) / 32 + row / 32) % 8) as u8 * 24;
                    }
                }
                media.publish_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buffer));
                assert!(media.error().is_none(), "{:?}", media.error());
                index += 1;
            }
            let fps = f64::from(decoded(remote).await - first) / started.elapsed().as_secs_f64();
            eprintln!("RECOVERY {name}: decoded_fps={fps:.1}");
            fps
        }
        phase(&media, &remote, "motion", 60).await;
        phase(&media, &remote, "idle", 2).await;
        let pc = media
            .peers
            .lock()
            .unwrap()
            .get("recovery")
            .unwrap()
            .connection
            .clone();
        let sender = pc.senders().remove(0);
        let mut params = sender.parameters();
        params.encodings[0].max_bitrate = Some(500_000);
        sender.set_parameters(params).unwrap();
        phase(&media, &remote, "low-bitrate-motion", 60).await;
        let mut params = sender.parameters();
        params.encodings[0].max_bitrate = Some(4_000_000);
        sender.set_parameters(params).unwrap();
        let recovered = phase(&media, &remote, "recovered-motion", 60).await;
        media.close();
        assert!(
            recovered >= 30.0,
            "Hardware encoder remained throttled after idle/bandwidth recovery: {recovered:.1} FPS"
        );
    });
}

// Deliberately opt-in: reads the desktop into memory and sends to receivers in
// this process only. No screenshots, files, external peers or signaling server.
// Counting DXGI arrivals alone misses races between AcquireNextFrame and Map.
#[test]
#[ignore = "Requires an unlocked interactive Windows desktop"]
fn dxgi_readback_reaches_preview_and_remote_after_restart() {
    use crate::{CaptureMethod, CaptureOptions, CaptureService, CaptureState, SourceKind};
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let service = CaptureService::new().unwrap();
        let screen = service
            .sources()
            .unwrap()
            .into_iter()
            .find(|source| source.kind == SourceKind::Monitor)
            .expect("Interactive DXGI check requires a display");
        for encoder in ["software", "auto"] {
            for round in 0..2 {
                let media = MediaSession::new(MediaOptions {
                    max_width: 640,
                    max_height: 360,
                    frame_rate: 60,
                    encoder: encoder.into(),
                    codec: Some(
                        if encoder == "software" {
                            "video/vp8"
                        } else {
                            "video/h264"
                        }
                        .into(),
                    ),
                    ..Default::default()
                })
                .unwrap();
                let remote = connect(&media, "dxgi-remote", false).await.unwrap();
                let preview = connect(&media, "dxgi-preview", true).await.unwrap();
                let status = service
                    .start_media_with_options(
                        screen.id.clone(),
                        media.clone(),
                        CaptureOptions {
                            backend: CaptureMethod::Dxgi,
                        },
                    )
                    .unwrap();
                assert_eq!(status.backend, Some(CaptureMethod::Dxgi));
                let id = status.session_id.unwrap();
                tokio::time::timeout(Duration::from_secs(10), async {
                    loop {
                        let status = service.status(id.clone()).unwrap();
                        assert_eq!(status.state, CaptureState::Running, "{status:?}");
                        assert!(media.error().is_none(), "{:?}", media.error());
                        if decoded(&remote).await >= 6 && decoded(&preview).await >= 6 {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                })
                .await
                .expect("DXGI readback did not reach both WebRTC receivers");
                eprintln!(
                    "DXGI {encoder}, hardware={:?}, round {round}: remote={}, preview={}",
                    media.encoder_id,
                    decoded(&remote).await,
                    decoded(&preview).await
                );
                let stopped = service.stop(id).unwrap();
                assert_eq!(stopped.state, CaptureState::Stopped, "{stopped:?}");
                assert!(media.peers.lock().unwrap().is_empty());
                assert!(media.hardware.lock().unwrap().is_empty());
            }
        }
        service.shutdown();
    });
}

#[test]
fn cursor_visibility_recomposes_a_static_frame_without_losing_its_shape() {
    use crate::surface::{Cursor, CursorShape};
    use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let media = MediaSession::new(MediaOptions {
            encoder: "software".into(),
            ..Default::default()
        })
        .unwrap();
        let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
        let pixels = [0u8; 8 * 8 * 4];
        let desc = D3D11_TEXTURE2D_DESC {
            Width: 8,
            Height: 8,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            ..Default::default()
        };
        let data = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: 32,
            SysMemSlicePitch: 0,
        };
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }.unwrap();
        let cursor = Cursor {
            visible: true,
            width: 2,
            height: 2,
            pitch: 8,
            shape: CursorShape::Color,
            bytes: Arc::new(vec![255; 16]),
            ..Default::default()
        };
        media
            .frame(TextureFrame {
                device: &device,
                context: &context,
                texture: &texture.unwrap(),
                rotation: Rotation::Identity,
                cursor: Some(&cursor),
            })
            .unwrap();
        let pixel = || {
            media
                .latest
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .buffer
                .data()
                .0[0]
        };
        media.flush().unwrap();
        let visible = pixel();
        media.set_cursor_visible(false);
        media.flush().unwrap();
        assert!(
            pixel() < visible,
            "cursor was still composed into the video"
        );
        media.set_cursor_visible(true);
        media.flush().unwrap();
        assert_eq!(
            pixel(),
            visible,
            "cursor was not restored on the retained desktop frame"
        );
        media.close();
    });
}

// Exercise the cached-frame path, not direct publish_frame calls: its cadence
// determines the software encoder's initial per-frame budget after a static scene.
#[test]
fn software_cached_frames_keep_cadence_and_follow_live_fps() {
    use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};

    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let media = MediaSession::new(MediaOptions {
            encoder: "software".into(),
            codec: Some("video/h264".into()),
            frame_rate: 20,
            max_width: 640,
            max_height: 480,
            max_bitrate: 1_000_000,
            ..Default::default()
        })
        .unwrap();
        let receiver = connect(&media, "cached", true).await.unwrap();
        // Seed one real capture arrival. Writing `latest` directly skips the
        // publication sequence and wakeup that arm cached-frame scheduling.
        let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
        let pixels = [0u8, 0, 0, 255].repeat(640 * 480);
        let desc = D3D11_TEXTURE2D_DESC {
            Width: 640,
            Height: 480,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            ..Default::default()
        };
        let data = D3D11_SUBRESOURCE_DATA {
            pSysMem: pixels.as_ptr().cast(),
            SysMemPitch: 640 * 4,
            SysMemSlicePitch: 0,
        };
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }.unwrap();
        media
            .frame(TextureFrame {
                device: &device,
                context: &context,
                texture: &texture.unwrap(),
                rotation: Rotation::Identity,
                cursor: None,
            })
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while decoded(&receiver).await < 5 {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(media.latest_sequence.load(Ordering::Acquire), 1);
        let before = decoded(&receiver).await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        let fast = decoded(&receiver).await - before;
        let stats = media.stats("cached").await.unwrap();
        assert_eq!(stats.len(), 1);
        assert!(stats[0].codec.eq_ignore_ascii_case("video/h264"));
        assert!(stats[0].encode_frames > 0 && stats[0].encode_seconds > 0.0);
        assert!(
            fast >= 20,
            "Static encoder input fell below its selected cadence: {fast}"
        );
        media
            .update_video_settings(VideoSettings {
                max_width: 640,
                max_height: 480,
                frame_rate: 5,
                max_bitrate: 500_000,
                degradation_preference: "maintain-resolution".into(),
            })
            .unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        let before = decoded(&receiver).await;
        tokio::time::sleep(Duration::from_secs(2)).await;
        let slow = decoded(&receiver).await - before;
        assert!(
            (6..=13).contains(&slow),
            "Cached frames ignored the live FPS limit: {slow}"
        );
        // Both cadence measurements reused the same captured frame, including
        // after the settings update; no new arrival kept the worker awake.
        assert_eq!(media.latest_sequence.load(Ordering::Acquire), 1);
        assert_eq!(media.peers.lock().unwrap().len(), 1);
        media.close();
        assert!(media.latest.lock().unwrap().is_none());
    });
}

#[test]
fn hardware_selection_matches_codec_and_preserves_h264_default() {
    let encoders = || {
        vec![
            EncoderInfo {
                id: "mf:hevc".into(),
                name: "HEVC".into(),
                hardware: true,
                codecs: vec!["video/h265".into()],
            },
            EncoderInfo {
                id: "mf:h264".into(),
                name: "H264".into(),
                hardware: true,
                codecs: vec!["video/h264".into()],
            },
        ]
    };
    let mut options = MediaOptions::default();
    assert_eq!(
        select_hardware_encoder(&options, encoders())
            .unwrap()
            .unwrap()
            .id,
        "mf:h264"
    );
    options.codec = Some("video/h265".into());
    assert_eq!(
        select_hardware_encoder(&options, encoders())
            .unwrap()
            .unwrap()
            .id,
        "mf:hevc"
    );
    options.encoder = "mf:h264".into();
    assert!(select_hardware_encoder(&options, encoders()).is_err());
    options.encoder = "mf:hevc".into();
    options.codec = None;
    assert_eq!(
        select_hardware_encoder(&options, encoders())
            .unwrap()
            .unwrap()
            .codecs,
        ["video/h265"]
    );
    options.encoder = "auto".into();
    options.codec = Some("video/vp9".into());
    assert!(select_hardware_encoder(&options, encoders())
        .unwrap()
        .is_none());
}

#[test]
fn external_hevc_factory_is_scoped_and_cancelled_offers_release_media() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let codecs = |factory: &PeerConnectionFactory| {
            factory
                .get_rtp_sender_capabilities(MediaType::Video)
                .codecs
                .into_iter()
                .map(|c| c.mime_type.to_lowercase())
                .collect::<Vec<_>>()
        };
        let before = codecs(&PeerConnectionFactory::default());
        for _ in 0..3 {
            let factory =
                PeerConnectionFactory::with_external_hevc_video_send_options(Default::default())
                    .unwrap();
            assert!(codecs(&factory).contains(&"video/h265".into()));
            drop(factory);
            assert_eq!(codecs(&PeerConnectionFactory::default()), before);
        }
        assert!(
            PeerConnectionFactory::with_external_hevc_video_send_options(
                libwebrtc::peer_connection_factory::VideoSendOptions {
                    min_playout_delay_ms: 1,
                    ..Default::default()
                }
            )
            .is_err()
        );
        for info in mf::detect()
            .unwrap()
            .into_iter()
            .filter(|e| e.codecs.contains(&"video/h265".into()))
        {
            for _ in 0..3 {
                let media = MediaSession::new(MediaOptions {
                    encoder: info.id.clone(),
                    codec: Some("video/h265".into()),
                    ..Default::default()
                })
                .unwrap();
                let weak = Arc::downgrade(&media);
                let offer = media
                    .offer("cancelled-hevc".into(), vec![], false, false)
                    .await
                    .unwrap();
                assert!(offer.contains("H265/90000"), "{offer}");
                assert!(!offer.contains("H264/90000"));
                // Exercise the actual sender implementation list, not only SDP
                // advertisement: missing HEVC implementations otherwise accept
                // the answer but never configure a send codec or emit RTP.
                let answer = offer
                    .replace("a=sendonly", "a=recvonly")
                    .replace("a=setup:actpass", "a=setup:active");
                media.answer("cancelled-hevc", &answer).await.unwrap();
                let connection = media
                    .peers
                    .lock()
                    .unwrap()
                    .get("cancelled-hevc")
                    .unwrap()
                    .connection
                    .clone();
                assert!(connection.senders().iter().any(|sender| sender
                    .parameters()
                    .codecs
                    .iter()
                    .any(|c| c.mime_type.eq_ignore_ascii_case("video/h265"))));
                media.close();
                drop(media);
                tokio::time::sleep(Duration::from_millis(50)).await;
                assert!(weak.upgrade().is_none());
            }
        }
    });
}
