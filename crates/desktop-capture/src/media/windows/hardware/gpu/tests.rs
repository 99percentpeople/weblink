use super::*;
use crate::media::{
    color::{ColorMatrix, ColorRange},
    windows::{
        compose,
        mf::{sample, transform},
    },
};
use libwebrtc::{native::yuv_helper::argb_to_i420_with_matrix, video_frame::I420Buffer};
use std::{
    thread,
    time::{Duration, Instant},
};

fn texture(device: &ID3D11Device, bytes: &[u8]) -> ID3D11Texture2D {
    let mut texture = None;
    unsafe {
        device
            .CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Width: 64,
                    Height: 32,
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
                    pSysMem: bytes.as_ptr().cast(),
                    SysMemPitch: 64 * 4,
                    SysMemSlicePitch: 0,
                }),
                Some(&mut texture),
            )
            .unwrap();
    }
    texture.unwrap()
}
fn read_nv12(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    texture: &ID3D11Texture2D,
) -> Vec<u8> {
    unsafe {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        desc.BindFlags = 0;
        desc.Usage = D3D11_USAGE_STAGING;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut staging))
            .unwrap();
        let staging = staging.unwrap();
        context.CopyResource(&staging, texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .unwrap();
        let mut bytes = Vec::new();
        for row in 0..desc.Height * 3 / 2 {
            bytes.extend_from_slice(std::slice::from_raw_parts(
                mapped
                    .pData
                    .cast::<u8>()
                    .add((row * mapped.RowPitch) as usize),
                desc.Width as usize,
            ));
        }
        context.Unmap(&staging, 0);
        bytes
    }
}

#[test]
#[ignore = "Requires D3D11 NV12 render targets"]
fn gpu_color_rotation_and_all_cursor_shapes_match_cpu_composition() {
    let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
    let pixels: Vec<u8> = (0..32)
        .flat_map(|y| {
            (0..64).flat_map(move |x| [(x * 3) as u8, (y * 7) as u8, ((x + y) * 2) as u8, 255])
        })
        .collect();
    let texture = texture(&device, &pixels);
    for rotation in [
        Rotation::Identity,
        Rotation::Clockwise90,
        Rotation::Clockwise180,
        Rotation::Clockwise270,
    ] {
        for shape in [
            None,
            Some(CursorShape::Color),
            Some(CursorShape::MaskedColor),
            Some(CursorShape::Monochrome),
        ] {
            let cursor = shape.map(|shape| Cursor {
                visible: true,
                x: -2,
                y: 3,
                width: 8,
                height: 4,
                pitch: if shape == CursorShape::Monochrome {
                    1
                } else {
                    32
                },
                shape,
                bytes: Arc::new(if shape == CursorShape::Monochrome {
                    vec![0x55, 0xaa, 0x00, 0xff, 0x33, 0xcc, 0xff, 0x00]
                } else {
                    [16, 64, 192, 128, 200, 100, 0, 0].repeat(16)
                }),
            });
            let frame = TextureFrame {
                dirty_regions: None,
                device: &device,
                context: &context,
                texture: &texture,
                rotation,
                cursor: cursor.as_ref(),
            };
            let pool = CapturePool::new(&frame, Arc::new(|| {}));
            let captured = pool.capture(&frame, true).unwrap().unwrap();
            let size = captured.size();
            let mut composed = Vec::new();
            compose::compose(
                &pixels,
                64 * 4,
                64,
                32,
                rotation,
                cursor.as_ref(),
                &mut composed,
            );
            for color_matrix in [ColorMatrix::Bt601, ColorMatrix::Bt709] {
                for color_range in [ColorRange::Limited, ColorRange::Full] {
                    let options = MediaOptions {
                        color_matrix,
                        color_range,
                        ..Default::default()
                    };
                    let mut converter = Converter::new(&device, size, Arc::new(|| {})).unwrap();
                    let surface = converter.convert(&captured, &options).unwrap().unwrap();
                    let repeated = converter.convert(&captured, &options).unwrap().unwrap();
                    assert!(
                        Arc::ptr_eq(&surface, &repeated),
                        "Static refresh must reuse converted NV12"
                    );
                    let actual = read_nv12(&device, &context, &surface.texture);
                    let mut reference = I420Buffer::new(size.0, size.1);
                    argb_to_i420_with_matrix(
                        &composed,
                        size.0 * 4,
                        &mut reference,
                        options.color_space().yuv_matrix(),
                    );
                    let reference =
                        crate::media::windows::hardware::Frame::from_i420(&reference, None);
                    let crate::media::windows::hardware::Input::Memory(reference) = reference.input
                    else {
                        unreachable!()
                    };
                    assert_eq!(actual.len(), reference.len());
                    let difference = actual
                        .iter()
                        .zip(&reference)
                        .map(|(a, b)| a.abs_diff(*b))
                        .max()
                        .unwrap();
                    assert!(difference <= 3, "{rotation:?}/{shape:?}/{color_matrix:?}/{color_range:?}: difference={difference}");
                }
            }
        }
    }
}

#[test]
#[ignore = "Requires D3D11 NV12 surfaces and Media Foundation"]
fn gpu_pool_waits_for_final_mf_sample_release_and_survives_owner_teardown() {
    let _runtime = transform::Runtime::new().unwrap();
    let (device, _) = windows_capture::d3d11::create_d3d_device().unwrap();
    let converter = Converter::new(&device, (320, 180), Arc::new(|| {})).unwrap();
    let mut samples = Vec::new();
    for _ in 0..8 {
        let lease = converter
            .pool
            .take(|| converter.surface())
            .unwrap()
            .unwrap();
        let sample = sample::tracked(Arc::new(lease)).unwrap();
        let retained = sample.clone();
        drop(sample);
        samples.push(retained);
    }
    assert!(converter
        .pool
        .take(|| converter.surface())
        .unwrap()
        .is_none());
    samples.pop();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if converter
            .pool
            .take(|| converter.surface())
            .unwrap()
            .is_some()
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "MF did not release its tracked surface"
        );
        thread::sleep(Duration::from_millis(5));
    }
    let pool = Arc::downgrade(&converter.pool);
    drop(converter);
    assert!(pool.upgrade().is_none());
    drop(samples);
}

#[test]
#[ignore = "Requires D3D11 NV12 render targets"]
fn concurrent_encoders_share_conversion_but_separate_pixels_and_formats() {
    let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
    let pixels = [32, 96, 192, 255].repeat(64 * 32);
    let texture = texture(&device, &pixels);
    let frame = TextureFrame {
        device: &device,
        context: &context,
        texture: &texture,
        rotation: Rotation::Identity,
        cursor: None,
        dirty_regions: None,
    };
    let pool = CapturePool::new(&frame, Arc::new(|| {}));
    let captured = pool.capture(&frame, false).unwrap().unwrap();
    let weak_capture = Arc::downgrade(&captured);
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = ["video/h264", "video/h265"]
        .into_iter()
        .map(|codec| {
            let device = device.clone();
            let captured = captured.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                let mut converter = Converter::new(&device, (64, 32), Arc::new(|| {})).unwrap();
                let options = MediaOptions {
                    codec: Some(codec.into()),
                    ..Default::default()
                };
                barrier.wait();
                let surface = converter.convert(&captured, &options).unwrap().unwrap();
                (converter, surface)
            })
        })
        .collect();
    let mut results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert!(Arc::ptr_eq(&results[0].1, &results[1].1));
    assert_eq!(captured.converted.lock().unwrap().len(), 1);

    let options = MediaOptions {
        codec: Some("video/h265".into()),
        ..Default::default()
    };
    let full = MediaOptions {
        color_range: ColorRange::Full,
        ..options.clone()
    };
    let other = results[0].0.convert(&captured, &full).unwrap().unwrap();
    assert!(!Arc::ptr_eq(&other, &results[1].1));
    assert_ne!(
        read_nv12(&device, &context, &other.texture),
        read_nv12(&device, &context, &results[1].1.texture)
    );
    // Returning to the prior color must retrieve its original conversion.
    let restored = results[0].0.convert(&captured, &options).unwrap().unwrap();
    assert!(Arc::ptr_eq(&restored, &results[1].1));
    let bt601 = MediaOptions {
        color_matrix: ColorMatrix::Bt601,
        ..options.clone()
    };
    let alternate = results[0].0.convert(&captured, &bt601).unwrap().unwrap();
    assert!(!Arc::ptr_eq(&alternate, &restored));
    assert_ne!(
        read_nv12(&device, &context, &alternate.texture),
        read_nv12(&device, &context, &restored.texture)
    );
    let mut resized = Converter::new(&device, (32, 16), Arc::new(|| {})).unwrap();
    let small = resized.convert(&captured, &options).unwrap().unwrap();
    assert!(!Arc::ptr_eq(&small, &restored));
    let next = pool.capture(&frame, false).unwrap().unwrap();
    let fresh = results[0].0.convert(&next, &options).unwrap().unwrap();
    assert!(!Arc::ptr_eq(&fresh, &restored));
    assert_eq!(
        read_nv12(&device, &context, &fresh.texture),
        read_nv12(&device, &context, &restored.texture)
    );

    // The shared result remains valid when its producing worker exits, without
    // retaining the captured BGRA input or an encoder/pool ownership cycle.
    drop(results);
    drop(captured);
    assert!(weak_capture.upgrade().is_none());
    assert!(!read_nv12(&device, &context, &restored.texture).is_empty());
}

#[test]
#[ignore = "Requires D3D11 NV12 render targets"]
fn shared_conversion_cache_is_bounded_and_rejects_other_devices() {
    let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
    let texture = texture(&device, &[96, 96, 96, 255].repeat(64 * 32));
    let frame = TextureFrame {
        device: &device,
        context: &context,
        texture: &texture,
        rotation: Rotation::Identity,
        cursor: None,
        dirty_regions: None,
    };
    let captured = CapturePool::new(&frame, Arc::new(|| {}))
        .capture(&frame, false)
        .unwrap()
        .unwrap();
    for index in 0..MAX_SHARED_CONVERSIONS + 3 {
        let mut converter =
            Converter::new(&device, (16 + index as u32 * 2, 16), Arc::new(|| {})).unwrap();
        let surface = converter
            .convert(&captured, &MediaOptions::default())
            .unwrap()
            .unwrap();
        assert!(!read_nv12(&device, &context, &surface.texture).is_empty());
    }
    assert_eq!(
        captured.converted.lock().unwrap().len(),
        MAX_SHARED_CONVERSIONS
    );
    let (other, _) = windows_capture::d3d11::create_d3d_device().unwrap();
    let mut converter = Converter::new(&other, (16, 16), Arc::new(|| {})).unwrap();
    assert!(converter
        .convert(&captured, &MediaOptions::default())
        .is_err());
}
