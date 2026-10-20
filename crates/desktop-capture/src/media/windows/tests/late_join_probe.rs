//! Opt-in observations of actual driver headers; no repair, cache or header injection.
use super::{vfr::Frames, *};
use crate::media::recording::{Packet, Subscription};
use serde_json::{json, Value};
use std::{path::Path, process::Command};

fn nal_types(bytes: &[u8], hevc: bool) -> Vec<u8> {
    bytes
        .windows(3)
        .enumerate()
        .filter(|(_, window)| *window == [0, 0, 1])
        .filter_map(|(at, _)| bytes.get(at + 3))
        .map(|header| {
            if hevc {
                (header >> 1) & 63
            } else {
                header & 31
            }
        })
        .collect()
}

fn observe(packets: &[Packet], hevc: bool) -> Value {
    let required: &[u8] = if hevc { &[32, 33, 34] } else { &[7, 8] };
    let keyframes: Vec<_> = packets
        .iter()
        .filter(|packet| packet.keyframe)
        .map(|packet| {
            let types = nal_types(&packet.bytes, hevc);
            json!({
                "timestampUs": packet.timestamp_us,
                "nalTypes": types,
                "completeHeaders": required.iter().all(|kind| types.contains(kind)),
                "randomAccessPicture": types.iter().any(|kind|
                    if hevc { (16..=23).contains(kind) } else { *kind == 5 }),
            })
        })
        .collect();
    json!({
        "packets": packets.len(),
        "firstPacketKeyframe": packets.first().is_some_and(|packet| packet.keyframe),
        "keyframes": keyframes,
        "allKeyframesComplete": !keyframes.is_empty() && keyframes.iter()
            .all(|key| key["completeHeaders"] == true && key["randomAccessPicture"] == true),
    })
}

async fn pump(
    media: &MediaSession,
    frames: &Frames,
    moving: bool,
    tap: &Subscription,
    duration: Duration,
) -> Vec<Packet> {
    let started = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(10));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut sequence = 0;
    let mut packets = Vec::new();
    while started.elapsed() < duration {
        tick.tick().await;
        if moving && sequence % 5 == 0 {
            // Sparse scene changes retain a usable stream at the shared 300 kbps cap.
            frames.send(media, sequence / 25);
        }
        sequence += 1;
        while let Ok(packet) = tap.receive(Duration::ZERO) {
            packets.push(packet);
        }
        assert!(tap.error().is_none(), "{:?}", tap.error());
        assert!(media.error().is_none(), "{:?}", media.error());
    }
    packets
}

fn fresh_decode(path: &Path, codec: &str, bytes: &[u8]) -> Result<Value> {
    std::fs::write(path, bytes).map_err(|error| error.to_string())?;
    // Each command starts a decoder with no SDP or previous parameter sets.
    let output = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-v",
            "error",
            "-xerror",
            "-threads",
            "1",
            "-f",
            codec,
            "-i",
        ])
        .arg(path)
        .args(["-frames:v", "3", "-f", "framemd5", "pipe:1"])
        .output()
        .map_err(|error| error.to_string())?;
    let decoded = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.starts_with('#') && line.contains(','))
        .count();
    Ok(json!({
        "success": output.status.success(),
        "decodedFrames": decoded,
        "stderr": String::from_utf8_lossy(&output.stderr),
    }))
}

async fn probe(
    info: &crate::media::EncoderInfo,
    cpu: bool,
    dir: &Path,
    index: usize,
) -> Result<Value> {
    let codec = &info.codecs[0];
    let hevc = codec == "video/h265";
    let format = if hevc { "hevc" } else { "h264" };
    let media = MediaSession::new(MediaOptions {
        encoder: info.id.clone(),
        codec: Some(codec.clone()),
        max_width: 640,
        max_height: 360,
        frame_rate: 20,
        max_bitrate: 300_000,
        ..Default::default()
    })?;
    let first = if hevc {
        media.offer("first".into(), vec![], false, false).await?;
        None // This SDK's local receiver has no HEVC decoder; use fresh FFmpeg below.
    } else {
        Some(connect(&media, "first", false).await?)
    };
    let encoder = media.hardware.encoder("first").ok_or("Missing encoder")?;
    let frames = Frames::new();
    let warm_tap = encoder.recording.subscribe()?;
    frames.send(&media, 0);
    let startup = pump(
        &media,
        &frames,
        true,
        &warm_tap,
        Duration::from_millis(2400),
    )
    .await;
    let fallback_warmup = if cpu {
        // A real GPU failure has a retained capture. Activating fallback before
        // any capture would instead test an artificial empty-readback race.
        encoder.use_readback("Explicit memory-input diagnostic after GPU startup".into());
        Some(
            pump(
                &media,
                &frames,
                true,
                &warm_tap,
                Duration::from_millis(2400),
            )
            .await,
        )
    } else {
        None
    };
    encoder.recording.unsubscribe(&warm_tap);
    if let Some(error) = encoder.error() {
        let stats = encoder.statistics();
        let report = json!({
            "encoderId": info.id, "codec": codec,
            "input": if cpu { "gpu-to-memory" } else { "gpu" },
            "ok": false, "stage": "startup", "error": error,
            "startup": observe(&startup, hevc),
            "selection": stats.selection, "gpuInputs": stats.gpu_inputs,
            "cpuInputs": stats.cpu_inputs,
        });
        media.close();
        return Ok(report);
    }
    let inputs_before_join = encoder.statistics();
    let mut phases = Vec::new();
    for (phase, moving, delay, preference) in [
        (
            "moving-delayed-answer",
            true,
            Duration::from_millis(700),
            "maintain-framerate",
        ),
        ("static", false, Duration::ZERO, "balanced"),
        ("rejoin", true, Duration::ZERO, "maintain-resolution"),
    ] {
        let original_before = if let Some(first) = &first {
            Some(decoded(first).await)
        } else {
            None
        };
        let capture_before = media.readback.lock().unwrap().generation;
        let conversion_before = media.latest_sequence.load(Ordering::Acquire);
        // Discard everything from startup. Only the newly subscribed late window is decoded.
        let tap = encoder.recording.subscribe()?;
        let joined_at = Instant::now();
        let joining = async {
            if hevc {
                media.offer("late".into(), vec![], false, false).await?;
                Ok::<Option<(Receiver, u128)>, String>(None)
            } else {
                let receiver =
                    connect_with_recording_and_delay(&media, "late", false, None, None, delay)
                        .await?;
                tokio::time::timeout(Duration::from_secs(8), async {
                    while decoded(&receiver).await == 0 {
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                })
                .await
                .map_err(|_| "Late receiver never decoded its first frame".to_string())?;
                Ok(Some((receiver, joined_at.elapsed().as_millis())))
            }
        };
        let (late, mut packets) = tokio::join!(
            joining,
            pump(&media, &frames, moving, &tap, Duration::from_millis(2000))
        );
        let late = late?;
        let static_conversion_preserved =
            moving || conversion_before == media.latest_sequence.load(Ordering::Acquire);
        media.update_video_settings(VideoSettings {
            max_width: 640,
            max_height: 360,
            frame_rate: 20,
            max_bitrate: 300_000,
            degradation_preference: preference.into(),
        })?;
        for peer in media.peers.lock().unwrap().values() {
            for sender in peer.connection.senders() {
                if matches!(sender.track(), Some(MediaStreamTrack::Video(_))) {
                    assert_eq!(
                        sender.parameters().degradation_preference(),
                        Some(DegradationPreference::MaintainFramerateAndResolution),
                        "Live settings must leave adaptation upstream of the shared bitstream"
                    );
                }
            }
        }
        packets.extend(
            pump(
                &media,
                &frames,
                moving,
                &tap,
                if moving {
                    Duration::from_millis(1800)
                } else {
                    Duration::from_secs(5)
                },
            )
            .await,
        );
        encoder.recording.unsubscribe(&tap);
        let late_frames = if let Some((late, _)) = &late {
            Some(decoded(late).await)
        } else {
            None
        };
        let original_after = if let Some(first) = &first {
            Some(decoded(first).await)
        } else {
            None
        };
        let same_group = media
            .hardware
            .encoder("late")
            .is_some_and(|late| Arc::ptr_eq(&encoder, &late));
        let packet_report = observe(&packets, hevc);
        let bytes: Vec<_> = packets
            .iter()
            .flat_map(|packet| packet.bytes.iter().copied())
            .collect();
        let decoded_clip = fresh_decode(
            &dir.join(format!("{index}-{phase}.{format}")),
            format,
            &bytes,
        )?;
        let static_preserved =
            moving || capture_before == media.readback.lock().unwrap().generation;
        let ok = packet_report["allKeyframesComplete"] == true
            && decoded_clip["success"] == true
            && decoded_clip["decodedFrames"] == 3
            && late_frames.is_none_or(|frames| frames > 2)
            && original_after
                .zip(original_before)
                .is_none_or(|(after, before)| after > before)
            && same_group
            && static_preserved
            && static_conversion_preserved
            // A static source must reuse its pixels immediately when joining;
            // neither a backend switch nor the 500 ms refresh should gate IDR.
            && (moving || late.as_ref().is_none_or(|(_, elapsed)| *elapsed < 750));
        phases.push(json!({
            "phase": phase, "ok": ok, "packets": packet_report,
            "freshDecoder": decoded_clip, "lateRtpDecodedFrames": late_frames,
            "firstDecodedMsSinceJoin": late.as_ref().map(|(_, elapsed)| elapsed),
            "answerDelayMs": if hevc { None } else { Some(delay.as_millis()) },
            "liveDegradationPreference": preference,
            "originalBefore": original_before, "originalAfter": original_after,
            "sameEncoderGroup": same_group, "staticCapturePreserved": static_preserved,
            "staticConversionPreserved": static_conversion_preserved,
        }));
        media.close_peer("late");
        drop(late);
    }
    let stats = encoder.statistics();
    let report = json!({
        "encoderId": info.id, "name": info.name, "codec": codec,
        "input": if cpu { "gpu-to-memory" } else { "gpu" },
        "selection": stats.selection, "gpuInputs": stats.gpu_inputs, "cpuInputs": stats.cpu_inputs,
        "startup": observe(&startup, hevc),
        "fallbackWarmup": fallback_warmup.as_ref().map(|packets| observe(packets, hevc)),
        "lateGpuInputs": stats.gpu_inputs - inputs_before_join.gpu_inputs,
        "lateCpuInputs": stats.cpu_inputs - inputs_before_join.cpu_inputs,
        "ok": phases.iter().all(|phase| phase["ok"] == true)
            && if cpu { stats.cpu_inputs > inputs_before_join.cpu_inputs
                && stats.gpu_inputs == inputs_before_join.gpu_inputs }
               else { stats.gpu_inputs > 0 && stats.cpu_inputs == 0 },
        "phases": phases,
    });
    media.close();
    Ok(report)
}

#[test]
#[ignore = "Requires Windows hardware encoders, FFmpeg and WEBLINK_LATE_JOIN_PROBE_DIR"]
fn late_join_headers_and_fresh_decoders() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let dir = std::path::PathBuf::from(
            std::env::var_os("WEBLINK_LATE_JOIN_PROBE_DIR")
                .expect("Set a diagnostic output directory for synthetic bitstreams"),
        );
        std::fs::create_dir_all(&dir).unwrap();
        let encoders = hardware::detect().unwrap();
        assert!(!encoders.is_empty(), "No hardware encoder");
        let mut reports = Vec::new();
        for info in encoders {
            for cpu in [false, true] {
                if cpu && info.id.starts_with("nvenc:") {
                    continue;
                }
                let result = tokio::time::timeout(
                    Duration::from_secs(75),
                    probe(&info, cpu, &dir, reports.len()),
                )
                .await;
                let report = match result {
                    Ok(Ok(report)) => report,
                    other => json!({"encoderId": info.id, "cpu": cpu, "ok": false,
                        "error": format!("{other:?}")}),
                };
                println!("LATE_JOIN_PROBE {report}");
                reports.push(report);
                std::fs::write(
                    dir.join("report.json"),
                    serde_json::to_vec_pretty(&reports).unwrap(),
                )
                .unwrap();
            }
        }
        assert!(
            reports.iter().all(|report| report["ok"] == true),
            "See LATE_JOIN_PROBE/report.json"
        );
    });
}
