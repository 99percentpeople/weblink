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
        let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
        let mut texture = None;
        let pixels = [32u8, 64, 192, 255].repeat(320 * 180);
        unsafe {
            device
                .CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Width: 320,
                        Height: 180,
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
                        SysMemPitch: 1280,
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
        encoder.set_bitrate(750_000).unwrap();
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
