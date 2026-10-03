use super::*;
use crate::{
    media::VideoSettings,
    surface::{readback::Readback, FrameSink, TextureFrame},
};
use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};

fn texture(device: &ID3D11Device, size: (u32, u32), value: u8) -> ID3D11Texture2D {
    let pixels = [value, value, value, 255].repeat((size.0 * size.1) as usize);
    let desc = D3D11_TEXTURE2D_DESC {
        Width: size.0,
        Height: size.1,
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
        SysMemPitch: size.0 * 4,
        SysMemSlicePitch: 0,
    };
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }.unwrap();
    texture.unwrap()
}

fn frame<'a>(
    device: &'a ID3D11Device,
    context: &'a ID3D11DeviceContext,
    texture: &'a ID3D11Texture2D,
) -> TextureFrame<'a> {
    TextureFrame {
        device,
        context,
        texture,
        rotation: Rotation::Identity,
        cursor: None,
    }
}

fn assert_pixels(pending: &mut PendingReadback, value: u8) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(mapped) = pending.try_map().unwrap() {
            assert_eq!(&mapped.bytes()[..4], &[value, value, value, 255]);
            break;
        }
        assert!(Instant::now() < deadline, "GPU copy did not complete");
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn pending_readbacks_preserve_pixels_across_new_arrivals_resize_and_device_change() {
    let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
    let mut source = Readback::default();
    let first = texture(&device, (8, 8), 32);
    source.copy(&frame(&device, &context, &first)).unwrap();
    let mut a = source.submit((8, 8), None).unwrap();
    let second = texture(&device, (16, 8), 96);
    source.copy(&frame(&device, &context, &second)).unwrap();
    let mut b = source.submit((16, 8), None).unwrap();
    // Replacing even the device must not invalidate copies already in flight.
    let (next_device, next_context) = windows_capture::d3d11::create_d3d_device().unwrap();
    let last = texture(&next_device, (8, 16), 160);
    source
        .copy(&frame(&next_device, &next_context, &last))
        .unwrap();
    assert_pixels(&mut a, 32);
    assert_pixels(&mut b, 96);
    let mut c = source.submit((8, 16), Some(a)).unwrap();
    assert_pixels(&mut c, 160);
    // Reprocessing a retained static source can increase resolution again.
    let mut small = source.submit((4, 8), Some(c)).unwrap();
    assert_pixels(&mut small, 160);
    let mut original = source.submit((8, 16), Some(small)).unwrap();
    assert_pixels(&mut original, 160);
}

#[test]
fn bounded_readbacks_deliver_the_final_static_update_and_live_resize() {
    // No await: the background worker stays parked, making admission/poll order
    // deterministic without touching real capture, the screen, or timing mocks.
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            for readback_buffers in 1..=3 {
                let media = MediaSession::new(MediaOptions {
                    encoder: "software".into(),
                    readback_buffers,
                    ..Default::default()
                })
                .unwrap();
                let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
                for index in 0..12 {
                    let pixels = texture(&device, (16, 8), if index == 11 { 240 } else { 16 });
                    media.frame(frame(&device, &context, &pixels)).unwrap();
                    media.capture_step(true).unwrap();
                    let state = media.conversion.lock().unwrap();
                    assert!(state.pending.len() <= readback_buffers as usize);
                    assert!(
                        state.pending.len() + state.reusable.len() <= readback_buffers as usize
                    );
                }
                media.flush().unwrap();
                {
                    let latest = media.latest.lock().unwrap();
                    let buffer = &latest.as_ref().unwrap().buffer;
                    assert_eq!((buffer.width(), buffer.height()), (16, 8));
                    assert!(buffer.data().0[0] > 180, "The last update was lost");
                }
                let settings = |width, height| VideoSettings {
                    max_width: width,
                    max_height: height,
                    frame_rate: 60,
                    max_bitrate: 25 * 1024 * 1024,
                    degradation_preference: "balanced".into(),
                };
                for (width, height) in [(8, 4), (16, 8)] {
                    media
                        .update_video_settings(settings(width, height))
                        .unwrap();
                    media.flush().unwrap();
                    let latest = media.latest.lock().unwrap();
                    let buffer = &latest.as_ref().unwrap().buffer;
                    assert_eq!((buffer.width(), buffer.height()), (width, height));
                    assert!(buffer.data().0[0] > 180);
                }
                assert!(!media.readback.lock().unwrap().dirty);
                assert!(media.conversion.lock().unwrap().pending.is_empty());
                media.close();
                assert!(media.conversion.lock().unwrap().reusable.is_empty());
            }
        });
}

#[test]
fn closing_with_pending_readback_releases_slots_without_publishing_late_frames() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let media = MediaSession::new(MediaOptions {
                encoder: "software".into(),
                ..Default::default()
            })
            .unwrap();
            let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
            let pixels = texture(&device, (8, 8), 128);
            media.frame(frame(&device, &context, &pixels)).unwrap();
            assert!(media.capture_step(true).unwrap().pending);
            media.close();
            let state = media.capture_step(false).unwrap();
            assert!(!state.pending && !state.dirty);
            assert!(media.latest.lock().unwrap().is_none());
            assert_eq!(media.latest_sequence.load(Ordering::Relaxed), 0);
            let state = media.conversion.lock().unwrap();
            assert!(state.pending.is_empty() && state.reusable.is_empty());
        });
}
