use super::*;
use libwebrtc::peer_connection::IceGatheringState;
use std::time::Duration;

struct Endpoint {
    peer: Arc<RoomPeer>,
    events: Arc<Mutex<Vec<Value>>>,
    messages: Arc<Mutex<Vec<(u32, Vec<u8>, bool)>>>,
}
impl Endpoint {
    fn new() -> Self {
        let events = Arc::new(Mutex::new(Vec::new()));
        let output = events.clone();
        let messages = Arc::new(Mutex::new(Vec::new()));
        let inbox = messages.clone();
        let peer = RoomPeer::open(
            vec![],
            false,
            Arc::new(move |event| {
                output.lock().unwrap().push(event);
                true
            }),
            Arc::new(move |key, bytes, binary| {
                inbox.lock().unwrap().push((key, bytes.to_vec(), binary));
                true
            }),
        )
        .unwrap();
        peer.receive_allowed(true);
        Self {
            peer,
            events,
            messages,
        }
    }
    async fn candidates(&self, other: &Self) {
        until(|| self.peer.pc.ice_gathering_state() == IceGatheringState::Complete).await;
        let candidates: Vec<_> = self
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["type"] == "candidate")
            .map(|v| v["candidate"].clone())
            .collect();
        for candidate in candidates {
            other
                .peer
                .candidate(serde_json::from_value(candidate).unwrap())
                .await
                .unwrap();
        }
    }
    async fn negotiate(&self, other: &Self) {
        let offer = self.peer.local_description().await.unwrap();
        other
            .peer
            .remote_description("offer", offer["sdp"].as_str().unwrap())
            .await
            .unwrap();
        let answer = other.peer.local_description().await.unwrap();
        self.peer
            .remote_description("answer", answer["sdp"].as_str().unwrap())
            .await
            .unwrap();
    }
    fn received_key(&self, mid: &str) -> u32 {
        self.events
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|e| e["type"] == "track" && e["mid"] == mid)
            .unwrap()["key"]
            .as_u64()
            .unwrap() as u32
    }
}
async fn until(f: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(15), async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("room peer timed out");
}
#[test]
fn one_connection_carries_multiple_video_tracks_and_binary_data_across_renegotiation() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let a = Endpoint::new();
        let b = Endpoint::new();
        let camera = CaptureSource::video();
        let screen = CaptureSource::video();
        a.peer
            .add_capture("camera", &camera, vec!["meeting".into()])
            .unwrap();
        a.peer
            .add_capture(
                "display",
                &screen,
                vec!["meeting".into(), "display-group".into()],
            )
            .unwrap();
        a.peer
            .create_channel(
                1,
                ChannelOptions {
                    label: "files".into(),
                    protocol: "files".into(),
                    ordered: true,
                    max_retransmits: None,
                    max_packet_life_time: None,
                },
            )
            .unwrap();
        a.negotiate(&b).await;
        tokio::join!(a.candidates(&b), b.candidates(&a));
        until(|| {
            a.events
                .lock()
                .unwrap()
                .iter()
                .any(|v| v["type"] == "channel-state" && v["state"] == "open")
        })
        .await;
        let mids = a.peer.mids();
        let camera_key = b.received_key(&mids["camera"]);
        let screen_key = b.received_key(&mids["display"]);
        assert_ne!(camera_key, screen_key);
        {
            let events = b.events.lock().unwrap();
            let streams = |key: u32| {
                events
                    .iter()
                    .find(|e| e["type"] == "track" && e["key"] == key)
                    .unwrap()["streams"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| id.as_str().unwrap())
                    .collect::<HashSet<_>>()
            };
            assert_eq!(streams(camera_key), HashSet::from(["meeting"]));
            assert_eq!(
                streams(screen_key),
                HashSet::from(["meeting", "display-group"])
            );
        }
        let frame = vec![128; 160 * 96 * 3 / 2];
        tokio::time::timeout(Duration::from_secs(15), async {
            while [camera_key, screen_key]
                .iter()
                .any(|&key| b.peer.output(key).unwrap().decoded_frames() == 0)
            {
                camera.yuv_frame(160, 96, &frame, true).unwrap();
                screen.yuv_frame(160, 96, &frame, false).unwrap();
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .expect("both tracks must decode");
        a.peer.remove_capture("display").unwrap();
        a.negotiate(&b).await;
        assert!(b.peer.output(screen_key).is_none());
        assert!(b.peer.output(camera_key).is_some());
        a.peer.write(1, &[0, 128, 255], true).unwrap();
        until(|| !b.messages.lock().unwrap().is_empty()).await;
        let key = b.messages.lock().unwrap()[0].0;
        assert_eq!(b.messages.lock().unwrap()[0].1, [0, 128, 255]);
        b.peer.write(key, b"reply", false).unwrap();
        until(|| !a.messages.lock().unwrap().is_empty()).await;
        assert_eq!(a.messages.lock().unwrap()[0], (1, b"reply".to_vec(), false));
        b.peer.receive_allowed(false);
        assert!(b.peer.output(camera_key).is_none());
        b.peer.receive_allowed(true);
        let restored_key = b.received_key(&mids["camera"]);
        assert_ne!(restored_key, camera_key);
        assert!(b.peer.output(restored_key).is_some());
        let weak = Arc::downgrade(&a.peer);
        a.peer.close();
        drop(a);
        assert!(weak.upgrade().is_none());
        b.peer.close();
    });
}

#[test]
#[ignore = "Requires a Windows HEVC encoder and hardware decoder. Uses synthetic capture only."]
fn screen_encoder_and_camera_share_one_room_transport_and_gpu_decoder() {
    check_screen_and_camera("video/h265");
}

#[test]
fn sender_limits_refresh_an_invalidated_rtp_transaction() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let a = Endpoint::new();
        let camera = CaptureSource::video();
        a.peer
            .add_capture("camera", &camera, vec!["meeting".into()])
            .unwrap();
        let sender = a.peer.pc.senders().remove(0);
        let mut attempts = 0;
        update_sender_parameters(&sender, |params| {
            attempts += 1;
            if attempts == 1 {
                // Commit a different setting between the outer get and set.
                let mut newer = sender.parameters();
                newer.encodings[0].max_bitrate = Some(500_000);
                sender.set_parameters(newer).unwrap();
            }
            params.encodings[0].max_framerate = Some(12.0);
        })
        .unwrap();
        let encoding = sender.parameters().encodings.remove(0);
        assert_eq!(attempts, 2);
        assert_eq!(encoding.max_bitrate, Some(500_000));
        assert_eq!(encoding.max_framerate, Some(12.0));
        let mut attempts = 0;
        let invalid = update_sender_parameters(&sender, |params| {
            attempts += 1;
            params.encodings.clear();
        });
        assert!(invalid.is_err());
        assert_eq!(attempts, 1);
        a.peer.close();
    });
}

#[test]
fn software_screens_keep_independent_presets_and_live_vfr_on_one_connection() {
    use crate::media::{
        preset::EncodingPreset, MediaOptions, MediaSession, SendCodecs, VideoSettings,
    };
    use libwebrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let a = Endpoint::new();
        let b = Endpoint::new();
        let camera = CaptureSource::video();
        a.peer
            .add_capture("camera", &camera, vec!["meeting".into()])
            .unwrap();
        a.peer.set_codecs("camera", &["video/vp8".into()]).unwrap();
        a.peer
            .set_limits("camera", Some(2_000_000), None, None, None)
            .unwrap();
        assert_eq!(a.peer.bandwidth.applied_maximum(), None);
        let screens = [
            ("text", EncodingPreset::Quality, 30, "[quality]"),
            ("motion", EncodingPreset::Latency, 60, "[latency]"),
        ]
        .map(|(id, preset, frame_rate, name)| {
            let share = MediaSession::new(MediaOptions {
                encoder: "software".into(),
                codec: Some("video/vp8".into()),
                encoding_preset: preset,
                frame_rate,
                max_width: 320,
                max_height: 180,
                ..Default::default()
            })
            .unwrap();
            a.peer
                .attach_screen(
                    &share,
                    id,
                    &SendCodecs {
                        video: "video/vp8".into(),
                        audio: "audio/opus".into(),
                    },
                    None,
                )
                .unwrap();
            (id, share, name)
        });
        a.negotiate(&b).await;
        tokio::join!(a.candidates(&b), b.candidates(&a));
        let camera_mid = a.peer.mids()["camera"].clone();
        let screen_mids = a.peer.bandwidth.screen_limits();
        assert_eq!(screen_mids.len(), 2);
        let answer = a.peer.pc.current_remote_description().unwrap().to_string();
        for section in answer.split("m=").filter(|s| s.starts_with("video ")) {
            let mid = section
                .lines()
                .find_map(|line| line.strip_prefix("a=mid:"))
                .unwrap();
            assert_eq!(
                section.contains("x-google-start-bitrate=1000"),
                screen_mids.contains_key(mid)
            );
        }
        let screen_cap = MediaOptions::default().max_bitrate;
        assert_eq!(
            a.peer.bandwidth.applied_maximum(),
            Some(2 * screen_cap + 2_000_000)
        );
        let mic = CaptureSource::audio(1).unwrap();
        a.peer.add_capture("mic", &mic, vec![]).unwrap();
        assert_eq!(
            a.peer.bandwidth.applied_maximum(),
            Some(2 * screen_cap + 2_128_000)
        );
        a.peer
            .set_limits("mic", Some(64_000), None, None, None)
            .unwrap();
        assert_eq!(
            a.peer.bandwidth.applied_maximum(),
            Some(2 * screen_cap + 2_064_000)
        );
        a.peer.remove_capture("mic").unwrap();
        let camera_key = b.received_key(&camera_mid);
        let camera_frame = vec![128; 160 * 96 * 3 / 2];
        let output_keys = screens.each_ref().map(|(id, _, _)| {
            let group = format!("weblink-screen-{id}");
            b.events
                .lock()
                .unwrap()
                .iter()
                .find(|event| event["type"] == "track" && event["streams"][0] == group)
                .unwrap()["key"]
                .as_u64()
                .unwrap() as u32
        });
        for rates in [[30, 60], [12, 60], [12, 24]] {
            for ((id, share, _), fps) in screens.iter().zip(rates) {
                share
                    .update_peer_video_settings(
                        id,
                        VideoSettings {
                            max_width: 320,
                            max_height: 180,
                            frame_rate: fps,
                            max_bitrate: 1_000_000,
                            degradation_preference: "balanced".into(),
                        },
                    )
                    .unwrap();
            }
            assert_eq!(a.peer.bandwidth.applied_maximum(), Some(4_000_000));
            let mut observed = Vec::new();
            let start = std::time::Instant::now();
            let baseline = output_keys.map(|key| b.peer.output(key).unwrap().decoded_frames());
            for frame in 0.. {
                observed.clear();
                camera.yuv_frame(160, 96, &camera_frame, false).unwrap();
                for (i, (id, share, name)) in screens.iter().enumerate() {
                    let mut pixels = I420Buffer::new_black(320, 180);
                    pixels
                        .data_mut()
                        .0
                        .fill(32 + ((frame * 13 + i) % 180) as u8);
                    share.publish_frame(&VideoFrame::new(VideoRotation::VideoRotation0, pixels));
                    let samples = share.stats(id).await.unwrap();
                    let implementation = samples
                        .first()
                        .map(|s| s.implementation.as_str())
                        .unwrap_or("");
                    let applied = share.applied_room_vfr(id);
                    let decoded = b.peer.output(output_keys[i]).unwrap().decoded_frames();
                    observed.push((
                        implementation.to_owned(),
                        applied,
                        decoded,
                        implementation.contains(name)
                            && applied == Some(rates[i])
                            && decoded >= baseline[i] + 3,
                    ));
                }
                if observed.iter().all(|item| item.3) {
                    break;
                }
                assert!(
                    start.elapsed() < Duration::from_secs(12),
                    "rates {rates:?}, actual {observed:?}"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
        assert!(b.peer.output(camera_key).unwrap().decoded_frames() > 0);
        let stats = a.peer.stats().await.unwrap();
        let camera_impl = stats
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["type"] == "outbound-rtp" && s["mid"] == camera_mid)
            .unwrap()["encoderImplementation"]
            .as_str()
            .unwrap();
        assert!(
            !camera_impl.contains("[quality]") && !camera_impl.contains("[latency]"),
            "{camera_impl}"
        );
        a.peer.detach_screen("text");
        assert_eq!(a.peer.bandwidth.applied_maximum(), Some(3_000_000));
        a.negotiate(&b).await;
        assert!(!a
            .peer
            .pc
            .current_local_description()
            .unwrap()
            .to_string()
            .contains("x-livekit-software-sender"));
        assert!(b.peer.output(output_keys[0]).is_none());
        assert!(b.peer.output(output_keys[1]).is_some());
        assert_eq!(screens[1].1.applied_room_vfr("motion"), Some(24));
        for (_, share, _) in screens {
            share.close();
        }
        assert_eq!(a.peer.bandwidth.applied_maximum(), None);
        a.peer.close();
        b.peer.close();
    });
}

#[test]
#[ignore = "Requires a Windows H.264 encoder and hardware decoder. Uses synthetic capture only."]
fn hardware_h264_screen_uses_the_same_transport_as_raw_camera_video() {
    check_screen_and_camera("video/h264");
}

fn check_screen_and_camera(codec: &str) {
    use crate::media::control::{Port, Sender, MOVEMENT_LABEL, RELIABLE_LABEL};
    #[derive(Default)]
    struct Input {
        packets: Mutex<Vec<(bool, Vec<u8>)>>,
        closed: AtomicBool,
    }
    impl Port for Input {
        fn opened(&self, _: Arc<dyn Sender>) {}
        fn writable(&self) {}
        fn message(&self, movement: bool, bytes: &[u8]) {
            self.packets
                .lock()
                .unwrap()
                .push((movement, bytes.to_vec()));
        }
        fn closed(&self) {
            self.closed.store(true, Ordering::Release);
        }
    }
    use crate::media::{MediaOptions, MediaSession, SendCodecs};
    use libwebrtc::video_frame::{I420Buffer, VideoFrame, VideoRotation};
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let a = Endpoint::new();
        let b = Endpoint::new();
        let camera = CaptureSource::video();
        a.peer
            .add_capture("camera", &camera, vec!["meeting".into()])
            .unwrap();
        a.peer
            .create_channel(
                1,
                ChannelOptions {
                    label: "chat".into(),
                    protocol: "chat".into(),
                    ordered: true,
                    max_retransmits: None,
                    max_packet_life_time: None,
                },
            )
            .unwrap();
        a.negotiate(&b).await;
        tokio::join!(a.candidates(&b), b.candidates(&a));
        until(|| {
            a.peer.pc.connection_state()
                == libwebrtc::peer_connection::PeerConnectionState::Connected
        })
        .await;
        let encoder = MediaSession::encoders()
            .unwrap()
            .into_iter()
            .find(|e| e.hardware && e.codecs.iter().any(|c| c == codec))
            .unwrap();
        let share = MediaSession::new(MediaOptions {
            encoder: encoder.id,
            codec: Some(codec.into()),
            max_width: 640,
            max_height: 360,
            frame_rate: 30,
            ..Default::default()
        })
        .unwrap();
        let id = "test-display";
        let input = Arc::new(Input::default());
        a.peer
            .attach_screen(
                &share,
                id,
                &SendCodecs {
                    video: codec.into(),
                    audio: "audio/opus".into(),
                },
                Some(input.clone()),
            )
            .unwrap();
        a.negotiate(&b).await;
        a.peer.screen_ready(id);
        let sender = a
            .peer
            .pc
            .senders()
            .into_iter()
            .find(|s| {
                s.track()
                    .is_some_and(|track| track.id() == format!("screen-{id}"))
            })
            .expect("screen RTP sender");
        assert!(matches!(
            sender.parameters().degradation_preference(),
            Some(libwebrtc::rtp_parameters::DegradationPreference::MaintainFramerateAndResolution)
        ));
        let key = b
            .events
            .lock()
            .unwrap()
            .iter()
            .find(|e| e["type"] == "track" && e["streams"][0] == "weblink-screen-test-display")
            .expect("screen stream ID")["key"]
            .as_u64()
            .unwrap() as u32;
        let screen = b.peer.output(key).unwrap();
        let camera_key = b.received_key(&a.peer.mids()["camera"]);
        let pixels = vec![128; 160 * 96 * 3 / 2];
        tokio::time::timeout(Duration::from_secs(18), async {
            let mut i = 0;
            while screen.decoded_frames() < 4
                || b.peer.output(camera_key).unwrap().decoded_frames() < 4
            {
                let mut image = I420Buffer::new_black(640, 360);
                image.data_mut().0.fill(40 + (i % 160) as u8);
                share.publish_frame(&VideoFrame::new(VideoRotation::VideoRotation0, image));
                camera.yuv_frame(160, 96, &pixels, false).unwrap();
                tokio::time::sleep(Duration::from_millis(33)).await;
                i += 1;
            }
        })
        .await
        .expect("camera and hardware-encoded screen should decode concurrently");
        assert_eq!(screen.gpu.as_ref().unwrap().stats().uploaded_frames, 0);
        let diagnostics = share.stats(id).await.unwrap();
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].codec.eq_ignore_ascii_case(codec));
        for (protocol, movement) in [(RELIABLE_LABEL, false), (MOVEMENT_LABEL, true)] {
            let label = format!("{protocol}/{id}");
            let channel = || {
                let events = b.events.lock().unwrap();
                let ch = events
                    .iter()
                    .find(|event| event["type"] == "channel" && event["label"] == label)?;
                assert_eq!(ch["protocol"], protocol);
                assert_eq!(ch["ordered"], !movement);
                let key = ch["key"].as_u64()? as u32;
                events
                    .iter()
                    .any(|event| {
                        event["type"] == "channel-state"
                            && event["key"] == key
                            && event["state"] == "open"
                    })
                    .then_some(key)
            };
            until(|| channel().is_some()).await;
            b.peer
                .write(channel().unwrap(), b"test-input", false)
                .unwrap();
            until(|| {
                input
                    .packets
                    .lock()
                    .unwrap()
                    .contains(&(movement, b"test-input".to_vec()))
            })
            .await;
        }
        a.peer.detach_screen(id);
        assert!(input.closed.load(Ordering::Acquire));
        share.close();
        a.negotiate(&b).await;
        assert!(b.peer.output(key).is_none());
        assert!(b.peer.output(camera_key).is_some());
        a.peer.write(1, b"screen ended", false).unwrap();
        until(|| !b.messages.lock().unwrap().is_empty()).await;
        a.peer.close();
        b.peer.close();
    });
}
