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
                    let reference = crate::media::windows::mf::Frame::from_i420(&reference, None);
                    let crate::media::windows::mf::Input::Memory(reference) = reference.input
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
