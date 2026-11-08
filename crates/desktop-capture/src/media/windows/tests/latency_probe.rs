//! Opt-in stage measurement using synthetic GPU textures and an in-process RTP receiver.
//! No desktop capture, browser presentation or physical display latency is measured.
use super::*;
use serde_json::{json, Value};
use windows::{
    core::Interface,
    Win32::Graphics::{Direct3D11::*, Dxgi::Common::*},
};

async fn receive_counters(receiver: &Receiver) -> (u32, u64, f64, f64, f64) {
    receiver
        .pc
        .get_stats()
        .await
        .unwrap()
        .into_iter()
        .find_map(|stat| {
            let RtcStats::InboundRtp(stat) = stat else {
                return None;
            };
            (stat.stream.kind == "video").then_some((
                stat.inbound.frames_decoded,
                stat.inbound.jitter_buffer_emitted_count,
                stat.inbound.total_decode_time,
                stat.inbound.jitter_buffer_delay,
                stat.inbound.total_processing_delay,
            ))
        })
        .unwrap_or_default()
}

fn per_item_ms(seconds: f64, count: u64) -> Option<f64> {
    (count > 0).then(|| seconds * 1000.0 / count as f64)
}

#[test]
#[ignore = "Opt-in hardware/RTP latency measurement; synthetic images only"]
fn synthetic_native_stream_latency() {
    // Opt-in controlled timer granularity for A/B runs. This guard changes only
    // this benchmark process and always balances the native resolution request.
    struct TimerResolution(bool);
    impl Drop for TimerResolution {
        fn drop(&mut self) {
            if self.0 {
                unsafe {
                    windows::Win32::Media::timeEndPeriod(1);
                }
            }
        }
    }
    let resolution = std::env::var("WEBLINK_PERF_TIMER_MS").as_deref() == Ok("1");
    if resolution {
        assert_eq!(unsafe { windows::Win32::Media::timeBeginPeriod(1) }, 0);
    }
    let _timer = TimerResolution(resolution);
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(run_probe());
}

async fn run_probe() {
    let codec = std::env::var("WEBLINK_PERF_CODEC").unwrap_or_else(|_| "video/h264".into());
    assert!(matches!(codec.as_str(), "video/h264" | "video/h265"));
    let rates = std::env::var("WEBLINK_PERF_FPS").map_or_else(
        |_| vec![60, 120],
        |value| {
            let fps: u32 = value
                .parse()
                .expect("WEBLINK_PERF_FPS must be 30, 60 or 120");
            assert!(matches!(fps, 30 | 60 | 120));
            vec![fps]
        },
    );
    let preset = std::env::var("WEBLINK_PERF_PRESET")
        .map(|value| {
            serde_json::from_value::<crate::media::preset::EncodingPreset>(value.into()).unwrap()
        })
        .unwrap_or_default();
    let requested_encoder = std::env::var("WEBLINK_PERF_ENCODER").ok();
    let hardware = hardware::detect()
        .unwrap()
        .into_iter()
        .find(|encoder| {
            encoder.codecs.contains(&codec)
                && requested_encoder
                    .as_ref()
                    .map_or_else(|| encoder.id.starts_with("mf:"), |id| &encoder.id == id)
        })
        .expect("No hardware encoder available for the requested probe codec");
    let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
    let protection: ID3D11Multithread = context.cast().unwrap();
    unsafe {
        let _ = protection.SetMultithreadProtected(true);
    }
    let (width, height) = (1920_u32, 1080_u32);
    // Precompute texture content so CPU test-pattern drawing is outside measurements.
    let mut textures = Vec::new();
    for phase in 0..4_u32 {
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        for y in 0..height {
            for x in 0..width {
                let offset = ((y * width + x) * 4) as usize;
                let value = 32 + (((x + phase * 16) / 96 + y / 96) % 6) as u8 * 32;
                pixels[offset..offset + 4].copy_from_slice(&[value, value, value, 255]);
            }
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
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
            SysMemPitch: width * 4,
            SysMemSlicePitch: 0,
        };
        let mut texture = None;
        unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }.unwrap();
        textures.push(texture.unwrap());
    }
    for fps in rates {
        let options = MediaOptions {
            encoder: hardware.id.clone(),
            codec: Some(codec.clone()),
            encoding_preset: preset,
            max_width: width,
            max_height: height,
            frame_rate: fps,
            max_bitrate: 25_000_000,
            degradation_preference: "maintain-framerate".into(),
            ..Default::default()
        };
        if std::env::var("WEBLINK_PERF_ENCODER_ONLY").as_deref() == Ok("1") {
            encoder_only(&hardware, options, &device, &context, &textures).await;
            continue;
        }
        let media = MediaSession::new(options).unwrap();
        let receiver = connect(&media, "latency-probe", false).await.unwrap();
        let mut cadence = tokio::time::interval(Duration::from_secs_f64(1.0 / f64::from(fps)));
        cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut before_send = None;
        let mut before_receive = None;
        let mut measured_at = Instant::now();
        for index in 0..fps * 10 {
            cadence.tick().await;
            media
                .frame(TextureFrame {
                    dirty_regions: None,
                    device: &device,
                    context: &context,
                    texture: &textures[index as usize % textures.len()],
                    rotation: Rotation::Identity,
                    cursor: None,
                })
                .unwrap();
            assert!(media.error().is_none(), "{:?}", media.error());
            if index == fps * 3 {
                before_send = media
                    .stats("latency-probe")
                    .await
                    .unwrap()
                    .into_iter()
                    .next();
                before_receive = Some(receive_counters(&receiver).await);
                measured_at = Instant::now();
            }
        }
        let measured_seconds = measured_at.elapsed().as_secs_f64();
        let after_send = media.stats("latency-probe").await.unwrap().remove(0);
        let before_send = before_send.expect("No outbound video stats after warmup");
        let after_receive = receive_counters(&receiver).await;
        let before_receive = before_receive.unwrap();
        let decoded = after_receive.0.saturating_sub(before_receive.0);
        let emitted = after_receive.1.saturating_sub(before_receive.1);
        let pipeline = media.pipeline_stats();
        let report: Value = json!({
            "scope": "synthetic GPU input to native loopback receiver; excludes capture OS and presentation",
            "debugAssertions": cfg!(debug_assertions),
            "requestedTimerResolutionMs": std::env::var("WEBLINK_PERF_TIMER_MS").ok(),
            "measurementSeconds": measured_seconds,
            "pipelineRollingWindow": 120,
            "encoder": hardware.name, "requestedFps": fps,
            "codec": codec, "preset": preset,
            "offeredFps": f64::from(fps * 7 - 1) / measured_seconds,
            "decodedFps": f64::from(decoded) / measured_seconds,
            "encodedFps": (after_send.encode_frames - before_send.encode_frames) as f64 / measured_seconds,
            "rtpMbps": (after_send.bytes - before_send.bytes) as f64 * 8.0 / measured_seconds / 1_000_000.0,
            "targetBitrate": after_send.target_bitrate,
            "encoderBitrate": after_send.encoder_bitrate,
            "availableOutgoingBitrate": after_send.available_outgoing_bitrate,
            "sendQueueMeanMs": per_item_ms(after_send.send_delay_seconds - before_send.send_delay_seconds, after_send.packets_sent - before_send.packets_sent),
            "decodeMeanMs": per_item_ms(after_receive.2 - before_receive.2, u64::from(decoded)),
            "jitterBufferMeanMs": per_item_ms(after_receive.3 - before_receive.3, emitted),
            "receiveProcessingMeanMs": per_item_ms(after_receive.4 - before_receive.4, u64::from(decoded)),
            "rttMs": after_send.round_trip_seconds.map(|seconds| seconds * 1000.0),
            "pipeline": pipeline,
        });
        println!("LATENCY_PROBE {}", serde_json::to_string(&report).unwrap());
        assert!(decoded > 0, "No synthetic frames decoded");
        for encoder in &pipeline.encoders {
            assert!(encoder.stages.input.samples > 0);
            assert!(encoder.stages.output_wait.samples > 0);
            assert_eq!(encoder.stages.output.samples, encoder.frames);
        }
        media.close();
    }
}

/// Isolate worker timing when ICE/receiver availability would prevent a run.
async fn encoder_only(
    hardware: &crate::media::EncoderInfo,
    options: MediaOptions,
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    textures: &[ID3D11Texture2D],
) {
    let dynamic = std::env::var("WEBLINK_PERF_DYNAMIC_BITRATE").as_deref() == Ok("1");
    let worker = hardware::Encoder::shared(
        hardware.id.clone(),
        options.clone(),
        Arc::new(|| {}),
        Arc::new(|| {}),
        if dynamic {
            8_000_000
        } else {
            options.max_bitrate as u32
        },
    )
    .unwrap();
    let frame = |index: usize| TextureFrame {
        device,
        context,
        texture: &textures[index % textures.len()],
        dirty_regions: None,
        rotation: Rotation::Identity,
        cursor: None,
    };
    let pool = hardware::gpu::CapturePool::new(&frame(0), Arc::new(|| {}));
    let fps = options.frame_rate;
    let mut cadence = tokio::time::interval(Duration::from_secs_f64(1.0 / f64::from(fps)));
    cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut baseline = 0;
    let mut baseline_stats = None;
    let mut measured_at = Instant::now();
    let mut submitted = 0;
    for index in 0..fps * 10 {
        cadence.tick().await;
        if dynamic && index % (fps / 10).max(1) == 0 {
            let alternating = index / (fps / 10).max(1) % 2 == 0;
            let target = if index < fps * 3 {
                8_000_000
            } else if index < fps * 6 {
                if alternating {
                    7_984_000
                } else {
                    8_016_000
                }
            } else if index < fps * 8 {
                if alternating {
                    4_000_000
                } else {
                    16_000_000
                }
            } else if alternating {
                8_000_000
            } else {
                8_032_000
            };
            worker.set_bitrate(target);
        }
        let captured_at = Instant::now();
        if let Some(captured) = pool.capture(&frame(index as usize), false).unwrap() {
            worker.submit(Arc::new(hardware::Frame::from_gpu(
                captured,
                &options,
                Some(captured_at),
            )));
            submitted += 1;
        }
        assert!(worker.error().is_none(), "{:?}", worker.error());
        if index == fps * 3 {
            let stats = worker.statistics();
            baseline = stats.frames;
            baseline_stats = Some(stats.snapshot("probe".into()));
            measured_at = Instant::now();
            submitted = 0;
        }
    }
    let elapsed = measured_at.elapsed().as_secs_f64();
    let stats = worker.statistics();
    println!(
        "ENCODER_STAGE_PROBE {}",
        json!({
            "scope": "synthetic GPU to hardware worker; excludes desktop capture, network and decoding",
            "debugAssertions": cfg!(debug_assertions),
            "encoder": hardware.name, "codec": options.codec, "preset": options.encoding_preset,
            "requestedFps": fps, "offeredFps": submitted as f64 / elapsed,
            "encodedFps": (stats.frames - baseline) as f64 / elapsed,
            "measurementSeconds": elapsed, "pipeline": stats.snapshot("probe".into()),
            "baseline": baseline_stats, "dynamicBitrate": dynamic,
        })
    );
    assert!(stats.frames > baseline, "No hardware output");
    assert_eq!(
        stats.snapshot("probe".into()).stages.output.samples,
        stats.frames
    );
    assert_eq!(
        stats.snapshot("probe".into()).stages.output_wait.samples,
        stats.frames
    );
    assert_eq!(
        stats.snapshot("probe".into()).stages.event_dispatch.samples,
        stats.frames
    );
    if dynamic {
        assert!(stats.snapshot("probe".into()).stages.bitrate_update.samples > 0);
    }
    worker.close();
}
