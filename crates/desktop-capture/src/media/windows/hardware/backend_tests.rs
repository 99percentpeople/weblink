use super::*;
#[test]
fn optional_driver_policy_preserves_manual_mf_and_other_gpus() {
    for requested in [nvenc::H264, nvenc::HEVC, "mf:old"] {
        let mut policy = Preference::new(requested, true);
        assert!(
            !policy.allows(false),
            "Intel/AMD must not open the NVIDIA driver"
        );
        assert!(policy.allows(true));
        for failure in [
            "missing DLL",
            "old API",
            "unsupported codec",
            "session limit",
            "device lost",
        ] {
            policy.failed = Some(failure.into());
            assert!(!policy.allows(true));
        }
    }
    assert!(!Preference::new("mf:selected", false).allows(true));
    assert!(Preference::new(nvenc::HEVC, false).allows(true));
}
#[test]
fn mf_failure_cannot_trigger_nvenc_recovery_loop() {
    let mut selection = Selection::new(nvenc::HEVC.into(), false);
    assert!(!selection.reject_nvenc("MF error"));
    selection.nvenc_active = true;
    assert!(selection.reject_nvenc("NVENC output failed"));
    assert!(!selection.preference.allows(true));
    assert!(!selection.reject_nvenc("MF error"));
    assert_eq!(selection.codec, Codec::Hevc);
}

use crate::{
    media::MediaOptions,
    surface::{Rotation, TextureFrame},
};
use std::{thread, time::Instant};
use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};

struct Image {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    texture: ID3D11Texture2D,
}
impl Image {
    fn new() -> Self {
        Self::with_size(320, 180)
    }
    fn with_size(width: u32, height: u32) -> Self {
        let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
        let mut texture = None;
        let pixels = [32u8, 64, 192, 255].repeat((width * height) as usize);
        unsafe {
            device
                .CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
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
                    },
                    Some(&D3D11_SUBRESOURCE_DATA {
                        pSysMem: pixels.as_ptr().cast(),
                        SysMemPitch: width * 4,
                        SysMemSlicePitch: 0,
                    }),
                    Some(&mut texture),
                )
                .unwrap();
        }
        Self {
            device,
            context,
            texture: texture.unwrap(),
        }
    }
    fn captured(&self) -> Arc<gpu::Captured> {
        let frame = TextureFrame {
            device: &self.device,
            context: &self.context,
            texture: &self.texture,
            rotation: Rotation::Identity,
            cursor: None,
            dirty_regions: None,
        };
        gpu::CapturePool::new(&frame, Arc::new(|| {}))
            .capture(&frame, false)
            .unwrap()
            .unwrap()
    }
}
fn configuration(codec: Codec) -> Configuration {
    Configuration {
        codec,
        width: 320,
        height: 180,
        fps: 30,
        bitrate: 1_000_000,
        bitrate_limit: 2_000_000,
        color: MediaOptions::default().color_space(),
    }
}

#[test]
#[ignore = "Requires a Windows MF HEVC encoder; measures synthetic GPU frames"]
fn mf_worker_preserves_one_instance_across_live_bitrate_changes() {
    use super::super::{Encoder as Worker, Frame};

    let info = mf::detect()
        .unwrap()
        .into_iter()
        .find(|e| e.codecs.iter().any(|c| c == "video/h265"))
        .unwrap();
    let (width, height) = (1280, 720);
    let image = Image::with_size(width, height);
    let options = MediaOptions {
        max_width: width,
        max_height: height,
        frame_rate: 30,
        max_bitrate: 20_000_000,
        encoder: info.id.clone(),
        codec: Some("video/h265".into()),
        ..Default::default()
    };
    // Cycle identical moving blocks at each rate so content complexity is fixed.
    let mut frames = Vec::new();
    for phase in 0u32..12 {
        let mut pixels = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let hash = (x / 8).wrapping_mul(747796405) ^ (y / 8).wrapping_mul(2891336453);
                let value = (hash.wrapping_mul(phase * 2 + 1) >> 24) as u8;
                pixels.extend_from_slice(&[value, value, value, 255]);
            }
        }
        unsafe {
            image.context.UpdateSubresource(
                &image.texture,
                0,
                None,
                pixels.as_ptr().cast(),
                width * 4,
                0,
            )
        };
        frames.push(Arc::new(Frame::from_gpu(image.captured(), &options, None)));
    }
    let low = 2_000_000;
    let worker = Worker::shared(info.id, options, Arc::new(|| {}), Arc::new(|| {}), low).unwrap();
    let mut means = Vec::new();
    let mut confirmed = Vec::new();
    for rate in [low, 20_000_000, low] {
        worker.set_bitrate(rate);
        let mut before = worker.statistics();
        for i in 0..120 {
            worker.submit(frames[i % frames.len()].clone());
            thread::sleep(Duration::from_millis(33));
            if i == 29 {
                before = worker.statistics();
            }
        }
        assert!(worker.error().is_none(), "{:?}", worker.error());
        let after = worker.statistics();
        assert_eq!(after.opens, 1, "Changing the bitrate replaced the encoder");
        confirmed.push(after.bitrate.unwrap());
        let count = after.frames - before.frames;
        assert!(count >= 15, "Only {count} frames at {rate}");
        means.push((after.encoded_bytes - before.encoded_bytes) / count);
    }
    eprintln!(
        "{} HEVC bytes per frame at low/high/low: {means:?}",
        info.name
    );
    let vbr = windows::Win32::Media::MediaFoundation::eAVEncCommonRateControlMode_UnconstrainedVBR;
    if worker
        .statistics()
        .controls
        .iter()
        .any(|control| control.name == "rateControl" && control.actual == Some(vbr.0 as u32))
    {
        assert_eq!(confirmed, [low, 20_000_000, low]);
    }
    if confirmed == [low, 20_000_000, low] {
        assert!(means[1] > means[0] * 2 && means[1] > means[2] * 2);
    } else {
        assert_eq!(confirmed, [20_000_000; 3], "unexpected confirmed rates");
    }
}
fn encode(encoder: &mut Encoder, surface: Arc<Lease<gpu::Surface>>, timestamp: i64) -> Packet {
    let started = Instant::now();
    let mut accepted = false;
    loop {
        let packets = encoder.poll().unwrap();
        if let Some(packet) = packets.into_iter().next() {
            assert!(accepted);
            assert_eq!(packet.timestamp_us, timestamp);
            assert!(!packet.bytes.is_empty());
            return packet;
        }
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "Encoder did not produce a packet"
        );
        if !accepted && encoder.ready() {
            accepted = encoder.input_gpu(surface.clone(), timestamp, None).unwrap();
        }
        thread::sleep(Duration::from_millis(1));
    }
}

#[test]
#[ignore = "Requires NVIDIA NVENC H.264 and H.265"]
fn nvenc_scene_changes_follow_the_live_bitrate() {
    let image = Image::new();
    let mut converter = gpu::Converter::new(&image.device, (320, 180), Arc::new(|| {})).unwrap();
    let flat = converter
        .convert(&image.captured(), &MediaOptions::default())
        .unwrap()
        .unwrap();
    let mut pixels = Vec::new();
    for y in 0u32..180 {
        for x in 0u32..320 {
            let value =
                (((x / 3).wrapping_mul(747796405) ^ (y / 3).wrapping_mul(2891336453)) >> 24) as u8;
            pixels.extend_from_slice(&[value, value, value, 255]);
        }
    }
    unsafe {
        image
            .context
            .UpdateSubresource(&image.texture, 0, None, pixels.as_ptr().cast(), 320 * 4, 0)
    };
    let scene = converter
        .convert(&image.captured(), &MediaOptions::default())
        .unwrap()
        .unwrap();
    for (id, codec) in [(nvenc::H264, Codec::H264), (nvenc::HEVC, Codec::Hevc)] {
        let low = 512_000;
        let high = 8_000_000;
        let mut selection = Selection::new(id.into(), false);
        let config = configuration(codec);
        let mut encoder = selection
            .open(
                config.width,
                config.height,
                config.fps,
                low,
                high,
                config.color,
                Arc::new(|| {}),
                Some(&image.device),
            )
            .unwrap();
        assert_eq!(encoder.implementation(), "NVENC");
        let mut timestamp = 0;
        let mut peaks = Vec::new();
        for rate in [low, high, low] {
            assert!(encoder.try_set_bitrate(rate));
            let controls = encoder.control_status();
            let buffer = controls
                .iter()
                .find(|control| control.name == "bufferBytes")
                .unwrap();
            assert_eq!(buffer.requested, (rate / config.fps).div_ceil(8));
            // Warm up on a static desktop, then switch to a detailed image.
            for _ in 0..30 {
                encode(&mut encoder, flat.clone(), timestamp);
                timestamp += 33_333;
            }
            let packet = encode(&mut encoder, scene.clone(), timestamp);
            timestamp += 33_333;
            assert!(!packet.keyframe);
            peaks.push(packet.bytes.len());
        }
        eprintln!("{id} scene change bytes at low/high/low budgets: {peaks:?}");
        assert!(
            peaks[0] * 2 < peaks[1] && peaks[2] * 2 < peaks[1],
            "The same scene cut must spend fewer bits at the lower target: {id} {peaks:?}"
        );
    }
}

#[test]
#[ignore = "Requires NVIDIA NVENC H.264 and H.265"]
fn nvenc_uses_only_requested_keyframes_across_bitrate_changes() {
    let image = Image::new();
    let captured = image.captured();
    for (id, codec) in [(nvenc::H264, Codec::H264), (nvenc::HEVC, Codec::Hevc)] {
        let mut converter =
            gpu::Converter::new(&image.device, (320, 180), Arc::new(|| {})).unwrap();
        let surface = converter
            .convert(&captured, &MediaOptions::default())
            .unwrap()
            .unwrap();
        let mut selection = Selection::new(id.into(), false);
        let mut encoder = selection
            .open_with(
                configuration(codec),
                Arc::new(|| {}),
                Some(&image.device),
                nvenc::Encoder::open,
            )
            .unwrap();
        assert_eq!(selection.report.as_ref().unwrap().encoder, id);
        // Six seconds at 30 FPS spans several old two-second GOP boundaries.
        // PLI/recording requests must still produce an immediate recovery IDR.
        for frame in 0..180 {
            if frame == 45 {
                assert!(encoder.try_set_bitrate(750_000));
            }
            if frame == 95 {
                encoder.request_keyframe().unwrap();
            }
            let packet = encode(&mut encoder, surface.clone(), frame * 1_000_000 / 30);
            assert_eq!(
                packet.keyframe,
                frame == 0 || frame == 95,
                "{id}: unexpected keyframe state at frame {frame}"
            );
        }
    }
}

#[test]
#[ignore = "Requires NVIDIA NVENC H.264 and H.265"]
fn nvenc_presets_accept_concurrent_shared_surfaces_and_bitrate_changes() {
    use crate::media::preset::EncodingPreset;
    let image = Image::new();
    let captured = image.captured();
    for preset in [
        EncodingPreset::Balanced,
        EncodingPreset::Quality,
        EncodingPreset::Latency,
    ] {
        let mut first_converter =
            gpu::Converter::new(&image.device, (320, 180), Arc::new(|| {})).unwrap();
        let mut second_converter =
            gpu::Converter::new(&image.device, (320, 180), Arc::new(|| {})).unwrap();
        let surface = first_converter
            .convert(&captured, &MediaOptions::default())
            .unwrap()
            .unwrap();
        let shared = second_converter
            .convert(&captured, &MediaOptions::default())
            .unwrap()
            .unwrap();
        assert!(Arc::ptr_eq(&surface, &shared));
        let mut encoders: Vec<_> = [(nvenc::H264, Codec::H264), (nvenc::HEVC, Codec::Hevc)]
            .into_iter()
            .map(|(id, codec)| {
                let mut selection = Selection::new(id.into(), false);
                selection.set_preset(preset);
                let config = configuration(codec);
                let mut encoder = selection
                    .open(
                        config.width,
                        config.height,
                        config.fps,
                        config.bitrate,
                        config.bitrate_limit,
                        config.color,
                        Arc::new(|| {}),
                        Some(&image.device),
                    )
                    .unwrap();
                assert_eq!(encoder.implementation(), "NVENC");
                let controls = encoder.control_status();
                let effective = controls
                    .iter()
                    .find(|c| c.name == "encodingPreset")
                    .unwrap();
                assert_eq!(effective.requested, preset.code());
                assert_eq!(effective.actual, Some(preset.code()));
                assert!(effective.accepted);
                assert!(encoder.input_gpu(surface.clone(), 123_456, None).unwrap());
                encoder
            })
            .collect();
        drop(first_converter);
        drop(second_converter);
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut completed = [false; 2];
        while !completed.iter().all(|done| *done) {
            for (index, encoder) in encoders.iter_mut().enumerate() {
                for packet in encoder.poll().unwrap() {
                    assert!(!completed[index]);
                    assert_eq!(packet.timestamp_us, 123_456);
                    assert!(packet.keyframe && !packet.bytes.is_empty());
                    completed[index] = true;
                }
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
        for encoder in &mut encoders {
            assert!(encoder.try_set_bitrate(750_000));
            encode(encoder, shared.clone(), 160_000);
            encoder.request_keyframe().unwrap();
            assert!(encode(encoder, shared.clone(), 200_000).keyframe);
            // Shared inputs can come from different conversion pools over time.
            // More than eight distinct textures must retire idle registrations,
            // not overflow the registration cache or force a backend fallback.
            for index in 0..12 {
                let mut converter =
                    gpu::Converter::new(&image.device, (320, 180), Arc::new(|| {})).unwrap();
                let fresh = converter
                    .convert(&image.captured(), &MediaOptions::default())
                    .unwrap()
                    .unwrap();
                encode(encoder, fresh, 240_000 + index * 40_000);
            }
        }
    }
}

#[test]
#[ignore = "Requires NVIDIA NVENC and Windows MF GPU encoding"]
fn nvenc_gpu_output_and_same_codec_fallback_preserve_timestamps_and_keyframes() {
    let _runtime = transform::Runtime::new().unwrap();
    let image = Image::new();
    assert!(nvenc::is_nvidia(&image.device));
    let captured = image.captured();
    for (id, codec) in [(nvenc::H264, Codec::H264), (nvenc::HEVC, Codec::Hevc)] {
        let mut converter =
            gpu::Converter::new(&image.device, (320, 180), Arc::new(|| {})).unwrap();
        let surface = converter
            .convert(&captured, &MediaOptions::default())
            .unwrap()
            .unwrap();
        let config = configuration(codec);
        let mut selection = Selection::new(id.into(), false);
        let mut encoder = selection
            .open_with(
                config,
                Arc::new(|| {}),
                Some(&image.device),
                nvenc::Encoder::open,
            )
            .unwrap();
        assert_eq!(
            selection.report.as_ref().unwrap().encoder,
            id,
            "{:?}",
            selection.report
        );
        let packet = encode(&mut encoder, surface.clone(), 123_456);
        assert!(packet.keyframe);
        assert!(encoder.try_set_bitrate(750_000));
        assert_eq!(encoder.codec, codec.encoded());
        encode(&mut encoder, surface.clone(), 1_000_000);
        encoder.request_keyframe().unwrap();
        assert!(encode(&mut encoder, surface.clone(), 1_111_111).keyframe);
        // Async output owns at most four distinct texture leases. Completion
        // must be consumed before admission can reuse their registered resources.
        let surfaces: Vec<_> = (0..4)
            .map(|_| {
                converter
                    .convert(&image.captured(), &MediaOptions::default())
                    .unwrap()
                    .unwrap()
            })
            .collect();
        for (i, surface) in surfaces.iter().enumerate() {
            assert!(encoder
                .input_gpu(surface.clone(), 2_000_000 + i as i64, None)
                .unwrap());
        }
        assert!(!encoder.ready());
        assert!(!encoder.input_gpu(surface.clone(), 3_000_000, None).unwrap());
        let started = Instant::now();
        let mut timestamps = Vec::new();
        while timestamps.len() < 4 {
            timestamps.extend(encoder.poll().unwrap().into_iter().map(|p| p.timestamp_us));
            assert!(started.elapsed() < Duration::from_secs(5));
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(timestamps, vec![2_000_000, 2_000_001, 2_000_002, 2_000_003]);
        assert!(encoder.ready());
        // Runtime failure follows the same selection transition as the worker.
        assert!(selection.reject_nvenc("controlled output failure"));
        drop(encoder);
        let mut fallback = selection
            .open_with(config, Arc::new(|| {}), Some(&image.device), |_, _, _| {
                panic!("Failed NVENC must not reopen")
            })
            .unwrap();
        assert!(selection
            .report
            .as_ref()
            .unwrap()
            .encoder
            .starts_with("mf:"));
        assert!(selection
            .report
            .as_ref()
            .unwrap()
            .fallback
            .as_ref()
            .unwrap()
            .contains("controlled output failure"));
        assert_eq!(fallback.codec, codec.encoded());
        assert!(encode(&mut fallback, surface, 1_222_222).keyframe);
        eprintln!(
            "{id}: native GPU output, timestamps, bitrate, IDR and same-codec MF recovery passed"
        );
    }
}

#[test]
#[ignore = "Requires Windows MF GPU encoding; injects optional-driver initialization failures"]
fn nvenc_initialization_errors_and_non_nvidia_devices_keep_mf_available() {
    let _runtime = transform::Runtime::new().unwrap();
    let image = Image::new();
    let captured = image.captured();
    for (id, codec) in [(nvenc::H264, Codec::H264), (nvenc::HEVC, Codec::Hevc)] {
        for reason in [
            "driver DLL missing",
            "API too old",
            "unsupported codec",
            "NVENC sessions exhausted",
        ] {
            let mut selection = Selection::new(id.into(), false);
            let mut encoder = selection
                .open_with(
                    configuration(codec),
                    Arc::new(|| {}),
                    Some(&image.device),
                    |_, _, _| Err(reason.into()),
                )
                .unwrap();
            let report = selection.report.as_ref().unwrap();
            assert!(report.encoder.starts_with("mf:"));
            if nvenc::is_nvidia(&image.device) {
                assert!(report.fallback.as_ref().unwrap().contains(reason));
            }
            let mut converter =
                gpu::Converter::new(&image.device, (320, 180), Arc::new(|| {})).unwrap();
            let surface = converter
                .convert(&captured, &MediaOptions::default())
                .unwrap()
                .unwrap();
            assert!(encode(&mut encoder, surface, 444_000).keyframe);
        }
    }
}

#[test]
fn non_nvidia_device_declines_nvenc_before_loading_the_optional_driver() {
    use windows::Win32::{Foundation::HMODULE, Graphics::Direct3D::D3D_DRIVER_TYPE_WARP};
    let mut device = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_WARP,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
        .unwrap();
    }
    let device = device.unwrap();
    assert!(!nvenc::is_nvidia(&device));
    let error = nvenc::Encoder::open(&device, configuration(Codec::H264), Arc::new(|| {}))
        .err()
        .unwrap();
    assert!(error.contains("capture adapter"));
}
