use super::*;

async fn frames(media: &MediaSession, count: u32) {
    let mut cadence = tokio::time::interval(Duration::from_millis(33));
    cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    for index in 0..count {
        cadence.tick().await;
        let mut buffer = I420Buffer::new_black(640, 360);
        buffer.data_mut().0.fill(40 + (index % 160) as u8);
        media.publish_frame(&VideoFrame::new(VideoRotation::VideoRotation0, buffer));
        assert!(media.error().is_none(), "{:?}", media.error());
    }
}

#[test]
fn native_recording_declines_missing_and_unsupported_senders_without_creating_peers() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let media = MediaSession::new(MediaOptions {
            encoder: "software".into(),
            ..Default::default()
        })
        .unwrap();
        for codec in ["video/h264", "video/vp8"] {
            let result = media
                .offer_recording(
                    "recording".into(),
                    crate::media::RecordingCodecs {
                        video: vec![codec.into()],
                        audio: "audio/opus".into(),
                    },
                    Box::new(|_| {}),
                    Box::new(|_| panic!("Fallback must not end recording")),
                )
                .await
                .unwrap();
            assert!(result.is_none());
            assert!(media.peers.lock().unwrap().is_empty());
            assert!(media.hardware.lock().unwrap().is_empty());
        }
        media.close();
    });
}

#[test]
fn native_recording_reuses_hardware_sender_and_isolates_slow_consumers_and_cleanup() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let Some(hardware) = mf::detect()
            .unwrap()
            .into_iter()
            .find(|encoder| encoder.codecs.iter().any(|codec| codec == "video/h264"))
        else {
            eprintln!(
                "No usable Windows H.264 hardware encoder; native recording integration skipped"
            );
            return;
        };
        eprintln!("Native recording encoder: {}", hardware.name);
        let media = MediaSession::new(MediaOptions {
            encoder: hardware.id,
            codec: Some("video/h264".into()),
            frame_rate: 30,
            max_width: 640,
            max_height: 360,
            max_bitrate: 2_000_000,
            ..Default::default()
        })
        .unwrap();
        let remote = connect(&media, "remote", false).await.unwrap();
        frames(&media, 90).await;
        let before = decoded(&remote).await;
        assert!(before > 5, "Original sender must be decoding before reuse");
        let (ended, receive) = std::sync::mpsc::channel();
        let recording = connect_with_recording(
            &media,
            "recording",
            true,
            None,
            Some(Box::new(move |error| {
                let _ = ended.send(error);
            })),
        )
        .await
        .unwrap();
        frames(&media, 90).await;
        assert_eq!(
            media.hardware.lock().unwrap().len(),
            1,
            "Recording must not create another encoder"
        );
        assert!(media.peers.lock().unwrap()["recording"].recording.is_some());
        let recorded = decoded(&recording).await;
        let during = decoded(&remote).await;
        eprintln!("Reused recording decoded {recorded}; original {before} -> {during}");
        assert!(recorded > 10);
        assert!(during > before + 10);
        media.close_peer("recording");
        frames(&media, 30).await;
        assert!(decoded(&remote).await > during);
        assert!(
            receive.try_recv().is_err(),
            "User cleanup must not emit source-ended"
        );
        assert_eq!(media.hardware.lock().unwrap().len(), 1);

        // Stop consuming the side channel while the actual WebRTC sender keeps running.
        let encoder = media.hardware.lock().unwrap()["remote"].clone();
        let slow = encoder.recording.subscribe().unwrap();
        encoder.request_recording_keyframe();
        let before_slow = decoded(&remote).await;
        frames(&media, 90).await;
        assert!(slow.error().unwrap().contains("cannot keep up"));
        assert!(decoded(&remote).await > before_slow + 10);
        encoder.recording.unsubscribe(&slow);

        let (ended, receive) = std::sync::mpsc::channel();
        let repeated = connect_with_recording(
            &media,
            "repeated",
            true,
            None,
            Some(Box::new(move |error| {
                let _ = ended.send(error);
            })),
        )
        .await
        .unwrap();
        frames(&media, 60).await;
        assert!(decoded(&repeated).await > 5);
        media.close_peer("remote");
        assert_eq!(receive.recv_timeout(Duration::from_secs(2)).unwrap(), None);
        media.close_peer("repeated");
        assert!(media.hardware.lock().unwrap().is_empty());
        media.close();
    });
}

#[test]
fn native_recording_direct_packets_keep_the_original_sender_and_pause_queue_isolated() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let Some(hardware) = mf::detect()
            .unwrap()
            .into_iter()
            .find(|encoder| encoder.codecs.contains(&"video/h264".into()))
        else {
            return;
        };
        let media = MediaSession::new(MediaOptions {
            encoder: hardware.id,
            codec: Some("video/h264".into()),
            frame_rate: 30,
            max_width: 640,
            max_height: 360,
            max_bitrate: 2_000_000,
            ..Default::default()
        })
        .unwrap();
        let remote = connect(&media, "remote", false).await.unwrap();
        frames(&media, 45).await;
        let before = decoded(&remote).await;
        assert!(media.open_recording("direct".into()).unwrap().is_some());
        media.control_recording("direct", true, 1).unwrap();
        async fn drain(media: Arc<MediaSession>, duration: Duration) -> Vec<u8> {
            let start = Instant::now();
            let mut bytes = Vec::new();
            while start.elapsed() < duration {
                let source = media.clone();
                bytes.extend(
                    tokio::task::spawn_blocking(move || source.read_recording("direct").unwrap())
                        .await
                        .unwrap(),
                );
            }
            bytes
        }
        let (_, first) = tokio::join!(
            frames(&media, 60),
            drain(media.clone(), Duration::from_secs(2))
        );
        assert!(first.len() > 36);
        assert_eq!(first[32], 0);
        assert_eq!(first[33], 1);
        assert_eq!(first[34], 1);
        assert_eq!(u32::from_le_bytes(first[4..8].try_into().unwrap()), 1);
        assert_eq!(
            media.peers.lock().unwrap().len(),
            1,
            "No local WebRTC recording peer"
        );
        assert_eq!(
            media.hardware.lock().unwrap().len(),
            1,
            "No second video encoder"
        );
        assert!(decoded(&remote).await > before + 10);
        media.control_recording("direct", false, 1).unwrap();
        frames(&media, 45).await;
        assert!(
            media.read_recording("direct").unwrap().is_empty(),
            "Pause must not fill recording queues"
        );
        media.control_recording("direct", true, 2).unwrap();
        let (_, resumed) = tokio::join!(
            frames(&media, 30),
            drain(media.clone(), Duration::from_secs(1))
        );
        assert_eq!(resumed[34], 1);
        assert_eq!(u32::from_le_bytes(resumed[4..8].try_into().unwrap()), 2);
        let before_slow = decoded(&remote).await;
        frames(&media, 60).await;
        assert!(decoded(&remote).await > before_slow + 10);
        let mut ended = false;
        for _ in 0..40 {
            let batch = media.read_recording("direct").unwrap();
            let mut at = 0;
            while at < batch.len() {
                let size = u32::from_le_bytes(batch[at..at + 4].try_into().unwrap()) as usize;
                if batch[at + 32] == 2 {
                    assert!(String::from_utf8_lossy(&batch[at + 36..at + 36 + size])
                        .contains("cannot keep up"));
                    ended = true;
                }
                at += 36 + size;
            }
            if ended {
                break;
            }
        }
        assert!(ended, "Slow consumer must end only its recording");
        media.close_recording("direct");
        assert_eq!(media.hardware.lock().unwrap().len(), 1);
        let before_close = decoded(&remote).await;
        frames(&media, 20).await;
        assert!(decoded(&remote).await > before_close);
        eprintln!(
            "Direct native recording: {} + {} bytes; original decoded {} frames",
            first.len(),
            resumed.len(),
            decoded(&remote).await
        );
        media.close();
    });
}

#[test]
fn native_recording_hardware_h265_access_units_use_the_same_bounded_tap() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let Some(hardware) = mf::detect()
            .unwrap()
            .into_iter()
            .find(|encoder| encoder.codecs.contains(&"video/h265".into()))
        else {
            return;
        };
        let encoder = mf::Encoder::new(
            hardware.id,
            MediaOptions {
                codec: Some("video/h265".into()),
                frame_rate: 30,
                max_width: 640,
                max_height: 360,
                max_bitrate: 2_000_000,
                ..Default::default()
            },
            true,
        )
        .unwrap();
        let subscriber = encoder.recording.subscribe().unwrap();
        encoder.request_recording_keyframe();
        let mut count = 0;
        for index in 0..60 {
            let mut buffer = I420Buffer::new_black(640, 360);
            buffer.data_mut().0.fill(40 + index as u8);
            encoder.submit(Arc::new(mf::Frame::from_i420(&buffer, None)));
            tokio::time::sleep(Duration::from_millis(33)).await;
            while let Ok(packet) = subscriber.receive(Duration::ZERO) {
                assert_eq!(
                    packet.kind,
                    crate::media::recording::PacketKind::Video {
                        codec: 2,
                        width: 640,
                        height: 360
                    }
                );
                assert!(packet.timestamp_us >= 0);
                if count == 0 {
                    assert!(packet.keyframe);
                }
                assert!(
                    packet.bytes.starts_with(&[0, 0, 0, 1]) || packet.bytes.starts_with(&[0, 0, 1])
                );
                count += 1;
            }
        }
        assert!(
            count > 15,
            "HEVC hardware emitted only {count} packets: {:?}",
            encoder.error()
        );
        eprintln!("Direct HEVC recording tap: {count} encoded access units");
        encoder.recording.unsubscribe(&subscriber);
        encoder.close();
    });
}
