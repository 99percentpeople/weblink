use super::*;
use crate::media::MediaOptions;
use crate::surface::{gpu::ContextLock, Rotation, TextureFrame};
use std::{
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use windows::core::Interface;
use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};

fn image(device: &ID3D11Device) -> ID3D11Texture2D {
    let pixels = [32u8, 64, 192, 255].repeat(320 * 180);
    let mut texture = None;
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
                    SysMemPitch: 320 * 4,
                    SysMemSlicePitch: 0,
                }),
                Some(&mut texture),
            )
            .unwrap();
    }
    texture.unwrap()
}

#[test]
#[ignore = "Requires Windows GPU NV12 texture input for hardware encoding"]
fn gpu_nv12_surface_encodes_with_h264_and_hevc_without_memory_input() {
    let _runtime = transform::Runtime::new().unwrap();
    let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
    let texture = image(&device);
    let frame = TextureFrame {
        dirty_regions: None,
        device: &device,
        context: &context,
        texture: &texture,
        rotation: Rotation::Identity,
        cursor: None,
    };
    let pool = gpu::CapturePool::new(&frame, Arc::new(|| {}));
    let captured = pool.capture(&frame, false).unwrap().unwrap();
    for info in detect().unwrap() {
        let options = MediaOptions::default();
        let mut converter = gpu::Converter::new(&device, (320, 180), Arc::new(|| {})).unwrap();
        let mut encoder = transform::Transform::open(
            &info.id,
            320,
            180,
            30,
            1_000_000,
            1_000_000,
            options.color_space(),
            Arc::new(|| {}),
            Some(&device),
        )
        .unwrap();
        let mut submitted = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut count = 0;
        while Instant::now() < deadline {
            count += encoder.poll().unwrap().len();
            if count > 0 {
                break;
            }
            if !submitted && encoder.ready() {
                let surface = converter.convert(&captured, &options).unwrap().unwrap();
                encoder.input_gpu(surface, 1000, None).unwrap();
                submitted = true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(count > 0, "{} produced no GPU output", info.id);
        println!("GPU input verified: {}", info.name);
    }
    let _guard = ContextLock::enter(&context).unwrap();
}

#[test]
#[ignore = "Requires Windows GPU H.264/H.265 encoders with adapter-scoped D3D11 input"]
fn gpu_adapter_selection_matches_real_devices_and_preserves_memory_fallback() {
    use windows::Win32::{
        Foundation::HMODULE,
        Graphics::{Direct3D::D3D_DRIVER_TYPE_UNKNOWN, Dxgi::*},
    };
    let _runtime = transform::Runtime::new().unwrap();
    let hardware = detect().unwrap();
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.unwrap();
    let mut index = 0;
    let mut verified = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
        index += 1;
        let desc = unsafe { adapter.GetDesc1() }.unwrap();
        if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
            continue;
        }
        let (mut device, mut context) = (None, None);
        unsafe {
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .unwrap();
        let device = device.unwrap();
        let context = context.unwrap();
        let multithread: ID3D11Multithread = device.cast().unwrap();
        unsafe {
            let _ = multithread.SetMultithreadProtected(true);
        }
        let expected = super::adapter::Adapter::from_device(&device)
            .unwrap()
            .label();
        let texture = image(&device);
        let frame = TextureFrame {
            dirty_regions: None,
            device: &device,
            context: &context,
            texture: &texture,
            rotation: Rotation::Identity,
            cursor: None,
        };
        let pool = gpu::CapturePool::new(&frame, Arc::new(|| {}));
        let captured = pool.capture(&frame, false).unwrap().unwrap();
        for codec in ["video/h264", "video/h265"] {
            if !encoders::has_adapter_codec(&device, codec).unwrap() {
                eprintln!("No {codec} encoder registered for {expected}");
                continue;
            }
            let Some(info) = hardware
                .iter()
                .find(|info| info.codecs.iter().any(|c| c == codec))
            else {
                continue;
            };
            let options = MediaOptions::default();
            let mut selection = encoders::Selection::new(info.id.clone(), true);
            let mut converter = gpu::Converter::new(&device, (320, 180), Arc::new(|| {})).unwrap();
            let mut transform = selection
                .open(
                    320,
                    180,
                    30,
                    1_000_000,
                    1_000_000,
                    options.color_space(),
                    Arc::new(|| {}),
                    Some(&device),
                )
                .unwrap();
            let report = selection.report.as_ref().unwrap().clone();
            assert!(report.adapter_matched, "{report:?}");
            assert_eq!(report.capture_adapter.as_deref(), Some(expected.as_str()));
            assert_eq!(report.encoder_adapter, report.capture_adapter);
            let mut submitted = false;
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut output = Vec::new();
            while output.is_empty() && Instant::now() < deadline {
                output.extend(transform.poll().unwrap());
                if !submitted && transform.ready() {
                    let surface = converter.convert(&captured, &options).unwrap().unwrap();
                    transform.input_gpu(surface, 1000, None).unwrap();
                    submitted = true;
                }
                thread::sleep(Duration::from_millis(5));
            }
            assert!(
                !output.is_empty(),
                "{expected} {codec} produced no GPU output"
            );
            drop(transform);
            let mut fallback = selection
                .open(
                    320,
                    180,
                    30,
                    1_000_000,
                    1_000_000,
                    options.color_space(),
                    Arc::new(|| {}),
                    None,
                )
                .unwrap();
            assert!(fallback.device.is_none());
            assert_eq!(selection.report.as_ref().unwrap().encoder, report.encoder);
            assert_eq!(
                selection.report.as_ref().unwrap().encoder_adapter,
                report.encoder_adapter
            );
            let mut submitted = false;
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut output = Vec::new();
            while output.is_empty() && Instant::now() < deadline {
                output.extend(fallback.poll().unwrap());
                if !submitted && fallback.ready() {
                    fallback
                        .input(&vec![128; 320 * 180 * 3 / 2], 2000, None)
                        .unwrap();
                    submitted = true;
                }
                thread::sleep(Duration::from_millis(5));
            }
            assert!(
                !output.is_empty(),
                "{expected} {codec} produced no memory fallback output"
            );
            eprintln!(
                "Adapter match {codec}: {report:?}; memory fallback reopened the same adapter"
            );
            verified += 1;
        }
    }
    assert!(verified > 0, "No physical GPU encoder was verified");
}

#[test]
#[ignore = "Requires Windows GPU H.264/H.265 encoders; reports actual optional dirty-region support"]
fn gpu_dirty_region_hints_preserve_full_partial_and_unchanged_inputs() {
    use crate::damage::DirtyRect;
    let _runtime = transform::Runtime::new().unwrap();
    let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
    let texture = image(&device);
    let frame = TextureFrame {
        device: &device,
        context: &context,
        texture: &texture,
        rotation: Rotation::Identity,
        cursor: None,
        dirty_regions: None,
    };
    let pool = gpu::CapturePool::new(&frame, Arc::new(|| {}));
    let captured = pool.capture(&frame, false).unwrap().unwrap();
    let options = MediaOptions::default();
    let partial = [DirtyRect {
        left: 10,
        top: 20,
        right: 30,
        bottom: 40,
    }];
    let mut tested = 0;
    for info in detect().unwrap() {
        let mut converter = gpu::Converter::new(&device, (320, 180), Arc::new(|| {})).unwrap();
        let mut encoder = transform::Transform::open(
            &info.id,
            320,
            180,
            30,
            1_000_000,
            1_000_000,
            options.color_space(),
            Arc::new(|| {}),
            Some(&device),
        )
        .unwrap();
        encoder.request_keyframe().unwrap();
        let hints = [None, Some(partial.as_slice()), Some([].as_slice())];
        let mut submitted = 0;
        let mut completed = 0;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && completed < hints.len() {
            completed += encoder.poll().unwrap().len();
            if submitted < hints.len() && encoder.ready() {
                let surface = converter.convert(&captured, &options).unwrap().unwrap();
                encoder
                    .input_gpu(surface, submitted as i64 * 33_333, hints[submitted])
                    .unwrap();
                submitted += 1;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            completed,
            hints.len(),
            "{} did not continue encoding all inputs",
            info.name
        );
        println!(
            "DIRTY_REGIONS {} {}",
            info.name,
            serde_json::to_string(
                &encoder
                    .control_status()
                    .into_iter()
                    .filter(|c| c.name == "dirtyRegions")
                    .collect::<Vec<_>>()
            )
            .unwrap()
        );
        tested += 1;
    }
    assert!(tested > 0, "No hardware encoders were exercised");
}
