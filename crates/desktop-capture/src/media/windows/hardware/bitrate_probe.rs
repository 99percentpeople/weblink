//! Opt-in real-driver measurement with fixed synthetic GPU input, no desktop capture.
use super::*;
use crate::media::{latency::Distribution, preset::EncodingPreset};
use serde_json::json;
use std::{sync::mpsc, time::Duration};

#[test]
#[ignore = "Requires NVIDIA NVENC/MF; set WEBLINK_BITRATE_PROBE_FILE to a new JSON path"]
fn nvidia_dynamic_bitrate_cost() {
    let _runtime = transform::Runtime::new().unwrap();
    let path = std::env::var_os("WEBLINK_BITRATE_PROBE_FILE").expect("Set output JSON path");
    assert!(
        !std::path::Path::new(&path).exists(),
        "Do not overwrite a previous run"
    );
    let image = Image::with_size(1920, 1080);
    assert!(nvenc::is_nvidia(&image.device));
    let options = MediaOptions {
        max_width: 1920,
        max_height: 1080,
        frame_rate: 60,
        ..Default::default()
    };
    let mut converter = gpu::Converter::new(&image.device, (1920, 1080), Arc::new(|| {})).unwrap();
    let mut surfaces = Vec::new();
    for phase in 0..4u32 {
        let mut pixels = vec![0u8; 1920 * 1080 * 4];
        for (i, pixel) in pixels.chunks_exact_mut(4).enumerate() {
            let x = i as u32 % 1920 + phase * 16;
            let y = i as u32 / 1920;
            let v = 32 + ((x / 32 + y / 32) % 6) as u8 * 32;
            pixel.copy_from_slice(&[v, v, v, 255]);
        }
        unsafe {
            image.context.UpdateSubresource(
                &image.texture,
                0,
                None,
                pixels.as_ptr().cast(),
                1920 * 4,
                0,
            );
        }
        surfaces.push(
            converter
                .convert(&image.captured(), &options)
                .unwrap()
                .unwrap(),
        );
    }
    let available = detect().unwrap();
    let mut runs = Vec::new();
    for round in 0..2 {
        let ordered: Vec<_> = if round == 0 {
            available.iter().collect()
        } else {
            available.iter().rev().collect()
        };
        for info in ordered {
            for preset in [EncodingPreset::Latency, EncodingPreset::Balanced] {
                let (tx, rx) = mpsc::channel();
                let notify: Wake = Arc::new(move || {
                    let _ = tx.send(());
                });
                let mut selection = Selection::new(info.id.clone(), false);
                selection.set_preset(preset);
                let mut encoder = selection
                    .open(
                        1920,
                        1080,
                        60,
                        8_000_000,
                        25_000_000,
                        options.color_space(),
                        notify,
                        Some(&image.device),
                    )
                    .unwrap();
                let mut timestamp = 0;
                for phase in ["fixed", "small", "large"] {
                    let mut writes = Distribution::default();
                    let mut input = Distribution::default();
                    let mut wait = Distribution::default();
                    let mut dispatch = Distribution::default();
                    let mut output = Distribution::default();
                    let mut successful = 0;
                    let mut keys = 0;
                    let started = Instant::now();
                    for index in 0..120 {
                        let due = started + Duration::from_secs_f64(index as f64 / 60.0);
                        if let Some(delay) = due.checked_duration_since(Instant::now()) {
                            thread::sleep(delay);
                        }
                        let input_at = Instant::now();
                        assert!(encoder
                            .input_gpu(surfaces[index % 4].clone(), timestamp, None)
                            .unwrap());
                        let accepted = Instant::now();
                        input.record(accepted.duration_since(input_at));
                        if phase != "fixed" && index % 6 == 0 {
                            let target = if phase == "small" {
                                if index % 12 == 0 {
                                    7_984_000
                                } else {
                                    8_016_000
                                }
                            } else if index % 12 == 0 {
                                4_000_000
                            } else {
                                16_000_000
                            };
                            let at = Instant::now();
                            successful += u32::from(encoder.try_set_bitrate(target));
                            writes.record(at.elapsed());
                        }
                        let packet = loop {
                            if let Some(packet) = encoder.poll().unwrap().into_iter().next() {
                                break packet;
                            }
                            assert!(
                                input_at.elapsed() < Duration::from_secs(10),
                                "Encoder stalled"
                            );
                            let _ = rx.recv_timeout(Duration::from_millis(100));
                        };
                        assert_eq!(packet.timestamp_us, timestamp);
                        let timing = packet.timing.expect("Backend omitted output stage timings");
                        let ready = timing.ready.max(accepted);
                        wait.record(ready.duration_since(accepted));
                        dispatch.record(timing.started.saturating_duration_since(ready));
                        output.record(timing.finished.duration_since(timing.started));
                        keys += u32::from(packet.keyframe);
                        timestamp += 16_667;
                    }
                    let result = json!({"round":round,"id":info.id,"name":info.name,"preset":preset,"phase":phase,
                        "seconds":started.elapsed().as_secs_f64(),"frames":120,"successfulWrites":successful,"keyframes":keys,
                        "bitrateUpdate":writes.measurement(),"input":input.measurement(),"outputWait":wait.measurement(),
                        "eventDispatch":dispatch.measurement(),"output":output.measurement(),"confirmedBitrate":encoder.bitrate});
                    println!("BITRATE_PROBE {result}");
                    runs.push(result);
                }
            }
        }
    }
    std::fs::write(path, serde_json::to_vec_pretty(&json!({"debugAssertions":cfg!(debug_assertions),"width":1920,"height":1080,"fps":60,
        "scope":"Preconverted synthetic GPU frames, one frame in flight; direct driver writes bypass scheduling to measure cost. Other GPU applications remain running.","runs":runs})).unwrap()).unwrap();
}
