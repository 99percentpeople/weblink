use super::*;
use crate::receive::Receiver;
use serde_json::json;

fn assert_processing_delay(inbound: &serde_json::Value) {
    // Native overload recovery needs the standard receive-to-decode accumulator,
    // including time queued before a frame reaches the decoder.
    assert!(
        inbound["totalProcessingDelay"]
            .as_f64()
            .is_some_and(|seconds| seconds.is_finite() && seconds > 0.0),
        "Native receive processing statistics unavailable: {inbound}"
    );
}

async fn close_receiver(receiver: Arc<Receiver>) {
    let weak = Arc::downgrade(&receiver);
    receiver.close();
    drop(receiver);
    tokio::time::timeout(Duration::from_secs(2), async {
        while weak.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Native receiver retained after close");
}

#[test]
#[ignore = "Requires Windows HEVC decoder and hardware encoder; uses synthetic pixels only"]
fn native_receiver_decodes_hevc_and_keeps_only_latest_presentation() {
    native_hevc(false);
}
#[test]
#[ignore = "Requires Windows HEVC decoder and hardware encoder; uses synthetic pixels only"]
fn native_receiver_leases_hevc_textures_for_gpu_presentation() {
    native_hevc(true);
}
fn native_hevc(gpu: bool) {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        assert!(crate::receive::codecs().iter().any(|c| c == "video/h265"), "HEVC decoder is unavailable on this test host");
        let encoder = MediaSession::encoders().unwrap().into_iter()
            .find(|e| e.codecs.iter().any(|c| c == "video/h265"))
            .expect("HEVC encoder required for native loopback test");
        let media = MediaSession::new(MediaOptions {
            encoder: encoder.id, codec: Some("video/h265".into()),
            max_width: 1280, max_height: 720, frame_rate: 30,
            ..Default::default()
        }).unwrap();
        let candidates = Arc::new(Mutex::new(Vec::new()));
        let gathered = candidates.clone();
        let receiver = Receiver::new_with_presentation(vec![], false, Arc::new(move |event| {
            if event["type"] == "candidate" { gathered.lock().unwrap().push(event["candidate"].clone()); }
            if event["type"] == "error" { eprintln!("Receive error: {event}"); }
            true
        }), gpu).unwrap();
        let offer = media.offer_configured("native-hevc".into(), vec![], false, false, None, None, None).await.unwrap();
        let answer = receiver.answer(&offer).await.unwrap();
        assert!(answer.contains("H265/90000"), "{answer}");
        media.answer("native-hevc", &answer).await.unwrap();
        let recording = gpu.then(|| receiver.gpu.as_ref().unwrap().recording());
        let mut recorded_sequence = 0;
        let mut recorded_frames = 0;
        let mut cadence = tokio::time::interval(Duration::from_millis(33));
        for index in 0..120 {
            cadence.tick().await;
            let pending = std::mem::take(&mut *candidates.lock().unwrap());
            for candidate in pending {
                media.add_ice_candidate("native-hevc", serde_json::from_value(candidate).unwrap()).await.unwrap();
            }
            let (width,height) = if index < 60 {(640,360)} else {(1280,720)};
            let mut frame = I420Buffer::new_black(width,height);
            frame.data_mut().0.fill(40 + (index % 160) as u8);
            media.publish_frame(&VideoFrame::new(VideoRotation::VideoRotation0,frame));
            assert!(media.error().is_none(), "{:?}", media.error());
            if let Some(recording) = &recording {
                let data = recording.read_frame(recorded_sequence).await.unwrap();
                if !data.is_empty() {
                    let w = u32::from_le_bytes(data[..4].try_into().unwrap());
                    let h = u32::from_le_bytes(data[4..8].try_into().unwrap());
                    recorded_sequence = u64::from_le_bytes(data[8..16].try_into().unwrap());
                    assert!(matches!((w,h), (640,360) | (1280,720)));
                    assert_eq!(data.len(), 24 + (w * h * 3 / 2) as usize);
                    assert!(data[24..24+(w*h) as usize].iter().any(|&y| y > 32));
                    recorded_frames += 1;
                }
            }
        }
        if let Some(recording) = recording {
            assert!(recorded_frames > 20, "Too few recorded HEVC frames: {recorded_frames}");
            recording.close();
            eprintln!("Native GPU recording frames: {recorded_frames}");
        }
        let stats = receiver.stats().await.unwrap();

        let inbound = stats.as_array().unwrap().iter().find(|s| s["type"] == "inbound-rtp" && s["kind"] == "video").unwrap();
        assert!(inbound["framesDecoded"].as_u64().unwrap_or(0) > 20, "{inbound}");
        assert_processing_delay(inbound);
        let retained = if gpu {
            let source = receiver.gpu.as_ref().unwrap();
            let held = source.latest().expect("GPU decoded frame");
            assert_eq!(held.texture.size, (1280,720));
            assert_eq!(source.stats().uploaded_frames, 0, "Hardware decode unexpectedly uploaded CPU frames");
            assert!(inbound["decoderImplementation"].as_str().unwrap_or("").contains("texture"), "{inbound}");
            let retained = Arc::new(crate::presentation::Source::default());
            retained.publish(held.texture.clone());
            let recording = retained.recording();
            let before = recording.read_frame(0).await.unwrap();
            assert_eq!(before.len(), 24+1280*720*3/2);
            assert!(before[24..24+1280*720].iter().any(|&y| y > 32));
            Some((recording,before))
        } else {
            let mut pixels = vec![0; crate::receive::FRAME_CAPACITY];
            let frame = receiver.copy_frame(0, &mut pixels).unwrap().expect("Decoded presentation frame");
            assert_eq!((frame.width,frame.height,frame.format),(1280,720,"NV12"));
            assert!(receiver.copy_frame(frame.sequence,&mut pixels).unwrap().is_none());
            None
        };
        eprintln!("Native HEVC result {}", json!({"frames":inbound["framesDecoded"],"decoder":inbound["decoderImplementation"],"hardware":inbound["powerEfficientDecoder"]}));
        close_receiver(receiver).await; media.close();
        if let Some((recording,before)) = retained { assert_eq!(recording.read_frame(0).await.unwrap(), before, "GPU lease changed after decoder shutdown"); }
    });
}

#[test]
#[ignore = "Requires Windows codec transforms; uses synthetic pixels only"]
fn native_receiver_decodes_remaining_formats() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        for codec in ["video/h264", "video/vp8", "video/vp9", "video/av1"] {
            let media = MediaSession::new(MediaOptions {encoder: "software".into(), codec: Some(codec.into()), max_width:320,max_height:180,frame_rate:20,..Default::default()}).unwrap();
            let candidates = Arc::new(Mutex::new(Vec::new()));
            let gathered = candidates.clone();
            let receiver = Receiver::new(vec![],false,Arc::new(move |event| {
                if event["type"] == "candidate" {gathered.lock().unwrap().push(event["candidate"].clone());}
                if event["type"] == "error" {eprintln!("Receive error: {event}");}
                true
            })).unwrap();
            let offer = media.offer_configured("formats".into(),vec![],false,false,None,None,None).await.unwrap();
            let answer = receiver.answer(&offer).await.unwrap();
            media.answer("formats",&answer).await.unwrap();
            let mut cadence = tokio::time::interval(Duration::from_millis(50));
            for index in 0..60 {
                cadence.tick().await;
                let pending = std::mem::take(&mut *candidates.lock().unwrap());
                for candidate in pending {media.add_ice_candidate("formats",serde_json::from_value(candidate).unwrap()).await.unwrap();}
                let mut frame = I420Buffer::new_black(320,180);
                frame.data_mut().0.fill(40 + (index % 160) as u8);
                media.publish_frame(&VideoFrame::new(VideoRotation::VideoRotation0,frame));
            }
            let stats = receiver.stats().await.unwrap();
            let inbound = stats.as_array().unwrap().iter().find(|s|s["type"]=="inbound-rtp" && s["kind"]=="video").unwrap();
            assert!(inbound["framesDecoded"].as_u64().unwrap_or(0)>10,"{codec}: {inbound}");
            assert_processing_delay(inbound);
            let mut pixels=vec![0;crate::receive::FRAME_CAPACITY];
            let frame=receiver.copy_frame(0,&mut pixels).unwrap().expect(codec);
            assert_eq!((frame.width,frame.height),(320,180));
            eprintln!("Native format {codec}: {}",json!({"frames":inbound["framesDecoded"],"decoder":inbound["decoderImplementation"],"hardware":inbound["powerEfficientDecoder"],"format":frame.format,"color":frame.color_space}));
            close_receiver(receiver).await;media.close();
        }
    });
}

#[test]
#[ignore = "Native RTP/SCTP loopback; synthetic audio and pixels, no input injection"]
fn native_receiver_preserves_audio_and_both_control_channels() {
    use crate::media::control::{Port, SendResult, Sender, MOVEMENT_LABEL, RELIABLE_LABEL};
    #[derive(Default)]
    struct Control {
        sender: Mutex<Option<Arc<dyn Sender>>>,
        messages: Mutex<Vec<(bool, Vec<u8>)>>,
    }
    impl Port for Control {
        fn opened(&self, sender: Arc<dyn Sender>) {
            *self.sender.lock().unwrap() = Some(sender);
        }
        fn writable(&self) {}
        fn closed(&self) {}
        fn message(&self, movement: bool, data: &[u8]) {
            self.messages
                .lock()
                .unwrap()
                .push((movement, data.to_vec()));
        }
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let media = MediaSession::with_audio_factory(
            MediaOptions {
                encoder: "software".into(),
                codec: Some("video/vp8".into()),
                audio: true,
                audio_codec: Some("audio/opus".into()),
                max_width: 320,
                max_height: 180,
                ..Default::default()
            },
            |rate, channels, _, _| audio::Loopback::synthetic(rate, channels),
        )
        .unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        let receiver = Receiver::new(
            vec![],
            false,
            Arc::new(move |event| {
                received.lock().unwrap().push(event);
                true
            }),
        )
        .unwrap();
        let control = Arc::new(Control::default());
        let offer = media
            .offer_configured(
                "av".into(),
                vec![],
                false,
                false,
                None,
                Some(control.clone()),
                None,
            )
            .await
            .unwrap();
        let answer = receiver.answer(&offer).await.unwrap();
        media.answer("av", &answer).await.unwrap();
        let mut cadence = tokio::time::interval(Duration::from_millis(10));
        let mut channels = std::collections::HashSet::new();
        let mut replied = false;
        for index in 0..240 {
            cadence.tick().await;
            for event in std::mem::take(&mut *events.lock().unwrap()) {
                if event["type"] == "candidate" {
                    media
                        .add_ice_candidate(
                            "av",
                            serde_json::from_value(event["candidate"].clone()).unwrap(),
                        )
                        .await
                        .unwrap();
                }
                if event["type"] == "channel" && event["state"] == "open" {
                    channels.insert(event["label"].as_str().unwrap().to_string());
                }
                if event["type"] == "message" && event["data"] == "host reply" {
                    replied = true;
                }
            }
            let capture = media.audio.as_ref().unwrap();
            let rate = capture.format.sample_rate;
            let count = capture.format.channel_count;
            let samples: Vec<_> = (0..rate / 100)
                .flat_map(|sample| {
                    std::iter::repeat_n(
                        ((f64::from(index * rate / 100 + sample) * 440.0 * std::f64::consts::TAU
                            / rate as f64)
                            .sin()
                            * 10000.0) as i16,
                        count as usize,
                    )
                })
                .collect();
            audio::deliver(
                &capture.source,
                &capture.recording,
                &libwebrtc::audio_frame::AudioFrame {
                    data: std::borrow::Cow::Borrowed(&samples),
                    sample_rate: rate,
                    num_channels: count,
                    samples_per_channel: rate / 100,
                },
                crate::media::webrtc::clock_us(),
            )
            .unwrap();
            if index % 3 == 0 {
                media.publish_frame(&VideoFrame::new(
                    VideoRotation::VideoRotation0,
                    I420Buffer::new_black(320, 180),
                ));
            }
            if index == 180 {
                assert!(
                    channels.contains(RELIABLE_LABEL) && channels.contains(MOVEMENT_LABEL),
                    "{channels:?}"
                );
                receiver.send(RELIABLE_LABEL, "keyboard").unwrap();
                receiver.send(MOVEMENT_LABEL, "pointer").unwrap();
                assert_eq!(
                    control
                        .sender
                        .lock()
                        .unwrap()
                        .as_ref()
                        .unwrap()
                        .send(b"host reply"),
                    SendResult::Sent
                );
            }
        }
        let pcm = receiver.audio();
        assert!(!pcm.is_empty() && pcm.len() <= 7680);
        assert!(pcm
            .chunks_exact(2)
            .any(|s| i16::from_le_bytes([s[0], s[1]]).abs() > 100));
        let messages = control.messages.lock().unwrap();
        assert!(messages.contains(&(false, b"keyboard".to_vec())));
        assert!(messages.contains(&(true, b"pointer".to_vec())));
        assert!(replied);
        drop(messages);
        receiver.close();
        media.close();
        assert!(receiver.audio().is_empty());
        close_receiver(receiver).await;
    });
}
