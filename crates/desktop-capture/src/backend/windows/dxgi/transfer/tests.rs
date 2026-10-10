use super::*;
use crate::surface::readback::{PendingReadback, Readback};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Notify;

fn mode(size: (u32, u32)) -> DXGI_MODE_DESC {
    DXGI_MODE_DESC {
        Width: size.0,
        Height: size.1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        ..Default::default()
    }
}

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
        ..Default::default()
    };
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }.unwrap();
    texture.unwrap()
}

async fn pixels(pending: &mut PendingReadback, notify: &Notify, value: u8) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            notify.notified().await;
            if let Some(mapped) = pending.try_map().unwrap() {
                // Each row proves both copy pitch and complete surface contents.
                for row in mapped.bytes().chunks(mapped.stride() as usize) {
                    assert_eq!(&row[..4], &[value, value, value, 255]);
                }
                break;
            }
        }
    })
    .await
    .expect("No completion notification for the retained final frame");
}

#[test]
fn isolated_transfer_preserves_inflight_pixels_resize_and_retained_source() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
        let mut transfer = Transfer::new(&device, &mode((8, 8))).unwrap();
        assert_ne!(transfer.device, device);
        assert_ne!(transfer.context, context);
        let mut retained = Readback::default();
        let mut copies = Vec::new();
        for (size, value) in [((8, 8), 32), ((16, 8), 96), ((16, 8), 160)] {
            let input = texture(&device, size, value);
            transfer
                .deliver(&context, &input, Rotation::Identity, None, |frame| {
                    retained.copy(&frame)
                })
                .unwrap();
            let notify = Arc::new(Notify::new());
            let pending = retained
                .submit_notifying(size, None, notify.clone())
                .unwrap();
            copies.push((pending, notify, value));
        }
        // Closing the acquisition bridge cannot invalidate readbacks already
        // handed off or prevent rescaling the retained static source later.
        drop(transfer);
        drop(context);
        drop(device);
        for (pending, notify, value) in &mut copies {
            pixels(pending, notify, *value).await;
        }
        let notify = Arc::new(Notify::new());
        let mut small = retained
            .submit_notifying((8, 4), None, notify.clone())
            .unwrap();
        pixels(&mut small, &notify, 160).await;
        let mut full = retained
            .submit_notifying((16, 8), Some(small), notify.clone())
            .unwrap();
        pixels(&mut full, &notify, 160).await;
    });
}

#[test]
fn isolated_transfer_releases_on_sink_failure_and_rejects_positive_timeout() {
    let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
    let mut transfer = Transfer::new(&device, &mode((8, 8))).unwrap();
    assert!(Access::acquire(&transfer.surface.write, 7, 0, 0)
        .err()
        .unwrap()
        .contains("timed out"));
    // An access dropped early still releases the owned key.
    drop(Access::acquire(&transfer.surface.write, 0, 0, 0).unwrap());
    let input = texture(&device, (8, 8), 64);
    assert_eq!(
        transfer.deliver(&context, &input, Rotation::Identity, None, |_| Err(
            "sink failed".into()
        )),
        Err("sink failed".into())
    );
    let mut retained = Readback::default();
    transfer
        .deliver(&context, &input, Rotation::Identity, None, |frame| {
            retained.copy(&frame)
        })
        .unwrap();
    let mapped = retained.map().unwrap();
    assert_eq!(&mapped.bytes()[..4], &[64, 64, 64, 255]);
}

#[test]
fn isolated_readback_completes_while_acquisition_context_is_locked() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
        let mut transfer = Transfer::new(&device, &mode((32, 16))).unwrap();
        let mut retained = Readback::default();
        let input = texture(&device, (32, 16), 96);
        transfer
            .deliver(&context, &input, Rotation::Identity, None, |frame| {
                retained.copy(&frame)
            })
            .unwrap();
        let protection: ID3D11Multithread = context.cast().unwrap();
        unsafe {
            let _ = protection.SetMultithreadProtected(true);
        }
        let (ready, entered) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let lock = std::thread::spawn(move || {
            unsafe {
                protection.Enter();
            }
            ready.send(()).unwrap();
            // Bounded test cleanup even if a regression blocks the readback.
            let _ = released.recv_timeout(Duration::from_secs(2));
            unsafe {
                protection.Leave();
            }
        });
        entered.recv().unwrap();
        let started = Instant::now();
        let notify = Arc::new(Notify::new());
        let mut pending = retained
            .submit_notifying((32, 16), None, notify.clone())
            .unwrap();
        pixels(&mut pending, &notify, 96).await;
        let elapsed = started.elapsed();
        let _ = release.send(());
        lock.join().unwrap();
        assert!(
            elapsed < Duration::from_secs(1),
            "Readback waited for acquisition: {elapsed:?}"
        );
    });
}

#[test]
#[ignore = "Opt-in synthetic GPU handoff cost; no desktop pixels or display latency"]
fn synthetic_dxgi_transfer_cost() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
        let size = (2560, 1440);
        let inputs = [texture(&device, size, 32), texture(&device, size, 160)];
        for isolated in [false, true, true, false] {
            let mut transfer = Transfer::new(&device, &mode(size)).unwrap();
            let mut retained = Readback::default();
            let notify = Arc::new(Notify::new());
            let mut reusable = None;
            let (mut handoff, mut total) = (Vec::new(), Vec::new());
            for index in 0..210 {
                let started = Instant::now();
                let input = &inputs[index % 2];
                if isolated {
                    transfer
                        .deliver(&context, input, Rotation::Identity, None, |frame| {
                            retained.copy(&frame)
                        })
                        .unwrap();
                } else {
                    retained
                        .copy(&TextureFrame {
                            device: &device,
                            context: &context,
                            texture: input,
                            rotation: Rotation::Identity,
                            cursor: None,
                        })
                        .unwrap();
                }
                let copied = started.elapsed();
                let mut pending = retained
                    .submit_notifying(size, reusable.take(), notify.clone())
                    .unwrap();
                pixels(&mut pending, &notify, if index % 2 == 0 { 32 } else { 160 }).await;
                if index >= 30 {
                    handoff.push(copied.as_secs_f64() * 1000.0);
                    total.push(started.elapsed().as_secs_f64() * 1000.0);
                }
                reusable = Some(pending);
            }
            handoff.sort_by(f64::total_cmp);
            total.sort_by(f64::total_cmp);
            println!(
                "TRANSFER_COST {}",
                serde_json::json!({
                    "isolated": isolated, "size": size, "samples": total.len(),
                    "handoffMedianMs": handoff[90], "handoffP95Ms": handoff[171],
                    "readbackMedianMs": total[90], "readbackP95Ms": total[171],
                })
            );
        }
    });
}
