//! Opt-in startup timing observations against a real hardware encoder and RTP receiver.
use super::*;
use libwebrtc::peer_connection::PeerConnectionState;
use serde_json::{json, Value};

struct WebRtcLog;
static WEBRTC_LOG: WebRtcLog = WebRtcLog;
static LOG_START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
impl log::Log for WebRtcLog {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.target() == "libwebrtc"
    }
    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let message = record.args().to_string();
        if [
            "video_stream_encoder",
            "video_encoder_factory",
            "passthrough",
            "rtp_sender",
            "frame_cadence",
        ]
        .iter()
        .any(|name| message.contains(name))
        {
            eprintln!(
                "WEBRTC_STARTUP {}ms {}",
                LOG_START.get().unwrap().elapsed().as_millis(),
                message.trim()
            );
        }
    }
    fn flush(&self) {}
}

#[derive(Clone)]
struct Trace {
    start: Instant,
    events: Arc<Mutex<Vec<Value>>>,
}
impl Trace {
    fn record(&self, kind: &str, data: Value) {
        self.events.lock().unwrap().push(json!({
            "ms": self.start.elapsed().as_millis(), "kind": kind, "data": data,
        }));
    }
}

async fn rtp(pc: &PeerConnection, sender: bool) -> Value {
    let stats = pc.get_stats().await.unwrap();
    let streams: Vec<_> = stats
        .into_iter()
        .filter_map(|stat| match stat {
            RtcStats::OutboundRtp(s) if sender && s.stream.kind == "video" => Some(json!({
                "packets": s.sent.packets_sent, "bytes": s.sent.bytes_sent,
                "frames": s.outbound.frames_sent, "encoded": s.outbound.frames_encoded,
                "keys": s.outbound.key_frames_encoded, "pli": s.outbound.pli_count,
                "nack": s.outbound.nack_count,
                "implementation": s.outbound.encoder_implementation,
            })),
            RtcStats::InboundRtp(s) if !sender && s.stream.kind == "video" => Some(json!({
                "packets": s.received.packets_received, "lost": s.received.packets_lost,
                "frames": s.inbound.frames_received, "decoded": s.inbound.frames_decoded,
                "keys": s.inbound.key_frames_decoded, "pli": s.inbound.pli_count,
                "nack": s.inbound.nack_count, "dropped": s.inbound.frames_dropped,
                "jitterEmitted": s.inbound.jitter_buffer_emitted_count,
                "jitterDelay": s.inbound.jitter_buffer_delay,
            })),
            _ => None,
        })
        .collect();
    json!({
        "state": format!("{:?}", pc.connection_state()),
        "ice": format!("{:?}", pc.ice_connection_state()),
        "streams": streams,
    })
}

#[test]
#[ignore = "Requires Windows H.264 hardware and WEBLINK_STARTUP_PROBE_DIR"]
fn static_join_timeline() {
    LOG_START.get_or_init(Instant::now);
    if std::env::var_os("WEBLINK_STARTUP_LOG").is_some() {
        let _ = log::set_logger(&WEBRTC_LOG);
        log::set_max_level(log::LevelFilter::Debug);
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let dir = std::path::PathBuf::from(std::env::var_os("WEBLINK_STARTUP_PROBE_DIR").unwrap());
        std::fs::create_dir_all(&dir).unwrap();
        let encoder = hardware::detect()
            .unwrap()
            .into_iter()
            .find(|info| info.codecs.contains(&"video/h264".into()))
            .unwrap();
        let media = MediaSession::new(MediaOptions {
            encoder: encoder.id,
            codec: Some("video/h264".into()),
            max_width: 640,
            max_height: 360,
            frame_rate: 20,
            max_bitrate: 300_000,
            ..Default::default()
        })
        .unwrap();
        let first = connect(&media, "first", false).await.unwrap();
        let frames = vfr::Frames::new();
        for i in 0..48 {
            frames.send(&media, i / 5);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let encoder = media.hardware.encoder("first").unwrap();
        for intervention in ["baseline", "connected-keyframe", "second-keyframe"] {
            let before = decoded(&first).await;
            let capture_before = media.readback.lock().unwrap().generation;
            let tap = encoder.recording.subscribe().unwrap();
            let trace = Trace {
                start: Instant::now(),
                events: Default::default(),
            };
            let receiving = async {
                let receiver = connect(&media, "late", false).await.unwrap();
                trace.record("answer-applied", json!(null));
                let mut last = Value::Null;
                let mut requested = false;
                while trace.start.elapsed() < Duration::from_secs(6) {
                    let value = rtp(&receiver.pc, false).await;
                    if value != last {
                        trace.record("receiver", value.clone());
                        last = value;
                    }
                    if !requested
                        && receiver.pc.connection_state() == PeerConnectionState::Connected
                        && (intervention == "connected-keyframe"
                            || (intervention == "second-keyframe"
                                && trace.start.elapsed() >= Duration::from_millis(800)))
                    {
                        encoder.request_recording_keyframe();
                        requested = true;
                        trace.record("extra-keyframe-request", json!(null));
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                receiver
            };
            let sending = async {
                let mut last = Value::Null;
                while trace.start.elapsed() < Duration::from_secs(6) {
                    while let Ok(packet) = tap.receive(Duration::ZERO) {
                        trace.record(
                            "encoder",
                            json!({
                                "key": packet.keyframe, "bytes": packet.bytes.len(),
                                "timestampUs": packet.timestamp_us,
                            }),
                        );
                    }
                    let pc = media
                        .peers
                        .lock()
                        .unwrap()
                        .get("late")
                        .map(|peer| peer.connection.clone());
                    if let Some(pc) = pc {
                        let value = rtp(&pc, true).await;
                        if value != last {
                            trace.record("sender", value.clone());
                            last = value;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            };
            let (late, _) = tokio::join!(receiving, sending);
            encoder.recording.unsubscribe(&tap);
            assert!(decoded(&late).await > 0);
            assert!(decoded(&first).await > before);
            assert_eq!(capture_before, media.readback.lock().unwrap().generation);
            assert!(Arc::ptr_eq(
                &encoder,
                &media.hardware.encoder("late").unwrap()
            ));
            let report = json!({
                "intervention": intervention, "events": *trace.events.lock().unwrap(),
            });
            std::fs::write(
                dir.join(format!("{intervention}.json")),
                serde_json::to_vec_pretty(&report).unwrap(),
            )
            .unwrap();
            println!("STARTUP_PROBE {report}");
            let events = trace.events.lock().unwrap();
            assert!(
                events
                    .iter()
                    .filter(|event| event["kind"] == "sender")
                    .all(|event| {
                        event["data"]["streams"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .all(|stream| {
                                let implementation = stream["implementation"].as_str().unwrap();
                                implementation.is_empty()
                                    || implementation.contains("pre-encoded passthrough")
                            })
                    }),
                "Pre-encoded senders must never start on a software encoder"
            );
            let first_rtp = events
                .iter()
                .find(|event| {
                    event["kind"] == "sender"
                        && event["data"]["streams"].as_array().is_some_and(|streams| {
                            streams
                                .iter()
                                .any(|stream| stream["frames"].as_u64().unwrap_or(0) > 0)
                        })
                })
                .expect("Sender must transmit the retained frame");
            assert!(
                first_rtp["data"]["streams"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|s| s["keys"].as_u64().unwrap_or(0) > 0),
                "The first RTP frame must contain a keyframe"
            );
            let first_decode = events
                .iter()
                .find(|event| {
                    event["kind"] == "receiver"
                        && event["data"]["streams"].as_array().is_some_and(|streams| {
                            streams
                                .iter()
                                .any(|stream| stream["decoded"].as_u64().unwrap_or(0) > 0)
                        })
                })
                .expect("Receiver must decode the first frame");
            assert!(first_decode["ms"].as_u64().unwrap() < 750, "{first_decode}");
            drop(events);
            media.close_peer("late");
            drop(late);
        }
        media.close();
    });
}
