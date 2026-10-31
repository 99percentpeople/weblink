use super::*;
use crate::presentation::Texture;
use std::time::Instant;
use windows::Win32::Graphics::Direct3D11::{D3D11_SUBRESOURCE_DATA, D3D11_USAGE_DEFAULT};

fn texture(device: &ID3D11Device, width: u32, height: u32) -> Texture {
    let bytes = (width * height * 3 / 2) as usize;
    let first = vec![31u8; bytes];
    let mut second = vec![97u8; bytes];
    second[(width * height) as usize..].fill(143);
    let initial = [
        D3D11_SUBRESOURCE_DATA {
            pSysMem: first.as_ptr().cast(),
            SysMemPitch: width,
            SysMemSlicePitch: bytes as u32,
        },
        D3D11_SUBRESOURCE_DATA {
            pSysMem: second.as_ptr().cast(),
            SysMemPitch: width,
            SysMemSlicePitch: bytes as u32,
        },
    ];
    let mut desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 2,
        Format: DXGI_FORMAT_NV12,
        Usage: D3D11_USAGE_DEFAULT,
        ..Default::default()
    };
    desc.SampleDesc.Count = 1;
    let mut output = None;
    unsafe { device.CreateTexture2D(&desc, Some(initial.as_ptr()), Some(&mut output)) }.unwrap();
    Texture {
        cpu_upload: false,
        texture: output.unwrap(),
        subresource: 1,
        crop: (2, 2),
        size: (width - 4, height - 4),
        bt709: true,
        full_range: false,
        owner: Arc::new(()),
    }
}

fn pool(recording: &Recording) -> Arc<Pool> {
    recording.state.lock().unwrap().as_ref().unwrap().0.clone()
}

#[test]
fn recording_reuses_staging_and_preserves_cropped_nv12_pixels() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let (device, _) = windows_capture::d3d11::create_d3d_device().unwrap();
        let source = Arc::new(Source::default());
        let recording = source.recording();
        assert!(recording.read_frame(0).await.unwrap().is_empty());
        let mut previous = None;
        for sequence in 1u64..=8 {
            source.publish(texture(&device, 68, 40));
            let data = recording.read_frame(sequence - 1).await.unwrap();
            assert_eq!(&data[..4], &64u32.to_le_bytes());
            assert_eq!(&data[4..8], &36u32.to_le_bytes());
            assert_eq!(&data[8..16], &sequence.to_le_bytes());
            assert_eq!(&data[16..24], &[1, 0, 0, 0, 0, 0, 0, 0]);
            assert_eq!(data.len(), 24 + 64 * 36 * 3 / 2);
            assert!(data[24..24 + 64 * 36].iter().all(|&v| v == 97));
            assert!(data[24 + 64 * 36..].iter().all(|&v| v == 143));
            let pool = pool(&recording);
            let slots = pool.idle.lock().unwrap();
            assert_eq!(slots.len(), 1);
            let staging = slots[0].staging.clone();
            if let Some(previous) = &previous {
                assert_eq!(&staging, previous);
            }
            previous = Some(staging);
        }
        assert!(recording.read_frame(8).await.unwrap().is_empty());
        let weak = Arc::downgrade(&pool(&recording));
        recording.close();
        assert!(!source.active());
        assert!(
            weak.upgrade().is_none(),
            "Closed recording retained staging resources"
        );
        assert!(recording.read_frame(0).await.is_err());
    });
}

#[test]
fn recording_rebuilds_on_resize_or_device_change_and_shares_bounded_pool() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let (device, _) = windows_capture::d3d11::create_d3d_device().unwrap();
        let (other, _) = windows_capture::d3d11::create_d3d_device().unwrap();
        let source = Arc::new(Source::default());
        let first = source.recording();
        let second = source.recording();
        let pool = pool(&first);
        assert!(Arc::ptr_eq(&pool, &super::tests::pool(&second)));
        let mut previous = None;
        for (device, w, h) in [(&device, 68, 40), (&device, 132, 76), (&other, 132, 76)] {
            source.publish(texture(device, w, h));
            let data = first.read_frame(0).await.unwrap();
            assert_eq!(data.len(), 24 + ((w - 4) * (h - 4) * 3 / 2) as usize);
            let slots = pool.idle.lock().unwrap();
            assert_eq!(slots.len(), 1);
            let staging = slots[0].staging.clone();
            if let Some(previous) = &previous {
                assert_ne!(&staging, previous);
            }
            previous = Some(staging);
        }
        // Backpressure rejects work rather than queuing more source leases.
        let permits = pool.capacity.acquire_many(SLOTS as u32).await.unwrap();
        assert!(first.read_frame(0).await.unwrap_err().contains("pool busy"));
        drop(permits);
        let busy = first.reading.acquire().await.unwrap();
        assert!(first
            .read_frame(0)
            .await
            .unwrap_err()
            .contains("in progress"));
        drop(busy);
        first.close();
        assert!(source.active());
        assert!(!second.read_frame(0).await.unwrap().is_empty());
        second.close();
        assert!(!source.active());
    });
}

#[test]
fn pending_copy_keeps_frame_lease_after_recording_and_source_close() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let (device, _) = windows_capture::d3d11::create_d3d_device().unwrap();
        let source = Arc::new(Source::default());
        let recording = source.recording();
        let texture = texture(&device, 68, 40);
        let owner = Arc::downgrade(&texture.owner);
        source.publish(texture);
        let frame = source.latest().unwrap();
        let (device, desc) = describe(&frame).unwrap();
        let mut slot = Slot::new(device, &desc).unwrap();
        slot.submit(&frame).unwrap();
        let pool = pool(&recording);
        recording.close();
        source.close();
        assert!(owner.upgrade().is_some());
        let data = pool.finish(slot, frame).await.unwrap();
        assert_eq!(data.len(), 24 + 64 * 36 * 3 / 2);
        assert!(owner.upgrade().is_none());
    });
}

#[test]
fn invalid_crops_and_subresources_are_rejected_before_gpu_submission() {
    let (device, _) = windows_capture::d3d11::create_d3d_device().unwrap();
    for (crop, size, subresource) in [
        ((1, 0), (64, 36), 1),
        ((u32::MAX - 1, 0), (64, 36), 1),
        ((2, 2), (64, 37), 1),
        ((2, 2), (64, 36), 2),
        ((2, 2), (128, 36), 1),
    ] {
        let mut texture = texture(&device, 68, 40);
        texture.crop = crop;
        texture.size = size;
        texture.subresource = subresource;
        assert!(describe(&Frame {
            sequence: 1,
            texture,
            ready: Instant::now()
        })
        .is_err());
    }
}

#[test]
fn cancelled_request_finishes_its_copy_and_releases_the_pool() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let (device, _) = windows_capture::d3d11::create_d3d_device().unwrap();
        let source = Arc::new(Source::default());
        let recording = Arc::new(source.recording());
        let texture = texture(&device, 68, 40);
        let owner = Arc::downgrade(&texture.owner);
        source.publish(texture);
        let pool = pool(&recording);
        let weak_pool = Arc::downgrade(&pool);
        // Hold submission at the real pool boundary so cancellation deterministically
        // happens while the detached job still owns the decoder frame.
        let guard = pool.idle.lock().unwrap();
        let reader = recording.clone();
        let request = tokio::spawn(async move { reader.read_frame(0).await });
        tokio::time::timeout(TIMEOUT, async {
            while pool.capacity.available_permits() == SLOTS {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        recording.close();
        source.close();
        assert!(
            owner.upgrade().is_some(),
            "Cancelled read released the source lease early"
        );
        drop(guard);
        tokio::time::timeout(TIMEOUT, async {
            while pool.capacity.available_permits() != SLOTS {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(owner.upgrade().is_none());
        drop(pool);
        assert!(weak_pool.upgrade().is_none());
    });
}

#[test]
fn concurrent_readers_stay_within_two_slots_and_reject_a_third() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let (device, _) = windows_capture::d3d11::create_d3d_device().unwrap();
        let source = Arc::new(Source::default());
        source.publish(texture(&device, 68, 40));
        let first = Arc::new(source.recording());
        let second = Arc::new(source.recording());
        let third = source.recording();
        let pool = pool(&first);
        let guard = pool.idle.lock().unwrap();
        let first = tokio::spawn(async move { first.read_frame(0).await });
        let second = tokio::spawn(async move { second.read_frame(0).await });
        tokio::time::timeout(TIMEOUT, async {
            while pool.capacity.available_permits() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(third.read_frame(0).await.unwrap_err().contains("pool busy"));
        drop(guard);
        let first = first.await.unwrap().unwrap();
        let second = second.await.unwrap().unwrap();
        assert_eq!(first, second);
        let idle = pool.idle.lock().unwrap();
        assert!(idle.len() <= SLOTS);
        if idle.len() == 2 {
            assert_ne!(idle[0].staging, idle[1].staging);
        }
    });
}
