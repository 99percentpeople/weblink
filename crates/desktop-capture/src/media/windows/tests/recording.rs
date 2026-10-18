use super::*;

#[test]
#[ignore = "Requires a Windows H.264 hardware encoder; run on a desktop GPU"]
fn native_recording_reuses_sender_audio_and_pcm_fallback_without_interrupting_streams() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let hardware = mf::detect().unwrap().into_iter()
            .find(|encoder| encoder.codecs.contains(&"video/h264".into()))
            .expect("This integration test requires a Windows H.264 hardware encoder");
        for audio_codec in ["audio/opus", "audio/g722", "audio/pcmu", "audio/pcma"] {
        let media = MediaSession::with_audio_factory(MediaOptions {
            encoder: hardware.id.clone(), codec: Some("video/h264".into()),
            audio: true, audio_codec: Some(audio_codec.into()),
            frame_rate: 30, max_width: 640, max_height: 360, max_bitrate: 2_000_000,
            ..Default::default()
        }, |rate, channels, _| audio::Loopback::synthetic(rate, channels)).unwrap();
        let remote = connect(&media, "remote", false).await.unwrap();
        async fn pump(media: &MediaSession, count: u32) {
            use libwebrtc::audio_frame::AudioFrame;
            use std::borrow::Cow;
            let capture = media.audio.as_ref().unwrap();
            let rate = capture.format.sample_rate;
            let channels = capture.format.channel_count;
            for n in 0..count {
                let samples: Vec<_> = (0..rate / 100).flat_map(|i| {
                    let value = ((f64::from(n * rate / 100 + i) * 440.0 * std::f64::consts::TAU / rate as f64).sin() * 10000.0) as i16;
                    std::iter::repeat_n(value, channels as usize)
                }).collect();
                audio::deliver(&capture.source, &capture.recording, &AudioFrame {
                    data: Cow::Borrowed(&samples), sample_rate: rate, num_channels: channels, samples_per_channel: rate / 100,
                }, crate::media::webrtc::clock_us()).unwrap();
                if n % 3 == 0 {
                    let mut frame = I420Buffer::new_black(640, 360);
                    frame.data_mut().0.fill(40 + (n % 160) as u8);
                    media.publish_frame(&VideoFrame::new(VideoRotation::VideoRotation0, frame));
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        async fn drain(media: Arc<MediaSession>) -> Vec<u8> {
            let start = Instant::now();
            let mut result = Vec::new();
            while start.elapsed() < Duration::from_millis(1250) {
                let media = media.clone();
                result.extend(tokio::task::spawn_blocking(move || media.read_recording("audio").unwrap()).await.unwrap());
            }
            result
        }
        fn packets(data: &[u8], kind: u8, segment: u32, codec: crate::media::recording::EncodedAudioCodec) -> usize {
            let mut at = 0;
            let mut count = 0;
            while at < data.len() {
                let size = u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
                assert_ne!(data[at + 32], 2, "Unexpected source termination: {}", String::from_utf8_lossy(&data[at + 36..at + 36 + size]));
                assert_eq!(u32::from_le_bytes(data[at + 4..at + 8].try_into().unwrap()), segment);
                if data[at + 32] == kind {
                    if kind == 3 {
                        assert_eq!(data[at + 33], codec as u8);
                        assert_eq!(u32::from_le_bytes(data[at + 24..at + 28].try_into().unwrap()), codec.sample_rate());
                    }
                    count += 1;
                }
                at += 36 + size;
            }
            count
        }
        async fn sound_received(remote: &Receiver) -> u64 {
            remote.pc.get_stats().await.unwrap().into_iter().filter_map(|stat| match stat {
                RtcStats::InboundRtp(s) => Some(s.inbound.total_samples_received), _ => None,
            }).sum()
        }
        let format = crate::media::recording::EncodedAudioCodec::from_rtp(audio_codec, if audio_codec == "audio/opus" {48000} else {8000}, 1).unwrap();
        pump(&media, 80).await;
        for encoded in [true, false, true] {
            let info = media.open_recording("audio".into(), encoded).unwrap().unwrap();
            assert_eq!(info.encoded_audio, encoded, "Sender audio should be usable: {audio_codec}");
            assert_eq!(info.audio.is_some(), !encoded);
            let before = decoded(&remote).await;
            let sound_before = sound_received(&remote).await;
            media.control_recording("audio", true, 1).unwrap();
            let (_, first) = tokio::join!(pump(&media, 110), drain(media.clone()));
            let kind = if encoded { 3 } else { 1 };
            let count = packets(&first, kind, 1, format);
            assert!(count > 10, "Missing audio packets: {count}");
            assert!(decoded(&remote).await > before + 10);
            assert!(sound_received(&remote).await > sound_before + 1000);
            media.control_recording("audio", false, 1).unwrap();
            pump(&media, 80).await;
            assert!(media.read_recording("audio").unwrap().is_empty());
            media.control_recording("audio", true, 2).unwrap();
            let (_, resumed) = tokio::join!(pump(&media, 110), drain(media.clone()));
            assert!(packets(&resumed, kind, 2, format) > 10);
            assert_eq!(media.peers.lock().unwrap().len(), 1);
            assert_eq!(media.hardware.lock().unwrap().len(), 1);
            // A stalled recording must not stall either original media track.
            let sound_before = sound_received(&remote).await;
            let before = decoded(&remote).await;
            pump(&media, 100).await;
            assert!(sound_received(&remote).await > sound_before + 1000);
            assert!(decoded(&remote).await > before + 10);
            media.close_recording("audio");
            assert!(!media.audio.as_ref().unwrap().recording.has_subscriber());
            assert!(!media.peers.lock().unwrap()["remote"].recording_audio.as_ref().unwrap().tap.has_subscriber());
            pump(&media, 20).await;
            eprintln!("Native {audio_codec} reuse={encoded}: {count} first-segment packets; original video/audio kept receiving through pause and stalled recording");
        }
        media.close();
        }
    });
}

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
        assert!(media
            .open_recording("direct".into(), true)
            .unwrap()
            .is_some());
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
