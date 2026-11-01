use super::*;
use crate::presentation::Source;
use libwebrtc::video_frame::{
    BoxVideoFrame, I420Buffer, NV12Buffer, VideoBuffer, VideoFrame, VideoRotation,
};

fn pixels(width: u32, height: u32, nv12: bool, value: u8) -> BoxVideoFrame {
    let buffer: Box<dyn VideoBuffer> = if nv12 {
        let mut buffer = NV12Buffer::with_strides(width, height, width + 16, width + 16);
        let (y, uv) = buffer.data_mut();
        y.fill(value);
        for pair in uv.chunks_exact_mut(2) {
            pair.copy_from_slice(&[91, 173]);
        }
        Box::new(buffer)
    } else {
        let mut buffer =
            I420Buffer::with_strides(width, height, width + 16, width / 2 + 8, width / 2 + 8);
        let (y, u, v) = buffer.data_mut();
        y.fill(value);
        u.fill(91);
        v.fill(173);
        Box::new(buffer)
    };
    VideoFrame::new(VideoRotation::VideoRotation0, buffer)
}

#[test]
fn uploads_padded_nv12_and_i420_reuses_storage_and_preserves_gpu_pixels() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let mut upload = Upload::default();
        let source = Arc::new(Source::default());
        let recording = source.recording();
        let mut addresses = Vec::new();
        let mut cpu = None;
        for value in 1..=24u8 {
            let frame = upload
                .frame(&pixels(64, 36, value % 2 == 0, value))
                .unwrap()
                .unwrap();
            let pointer = upload.packed.as_ptr();
            if let Some(cpu) = cpu {
                assert_eq!(cpu, pointer);
            }
            cpu = Some(pointer);
            let address = frame.texture.as_raw() as usize;
            if !addresses.contains(&address) {
                addresses.push(address);
            }
            source.publish(frame);
            let data = recording.read_frame(0).await.unwrap();
            assert!(data[24..24 + 64 * 36].iter().all(|&v| v == value));
            assert!(data[24 + 64 * 36..]
                .chunks_exact(2)
                .all(|uv| uv == [91, 173]));
        }
        // Latest owns one texture while the next upload is prepared.
        assert_eq!(addresses.len(), 2);
        assert_eq!(upload.pool.lock().unwrap().allocated, 2);
        recording.close();
        source.close();
        assert_eq!(upload.pool.lock().unwrap().idle.len(), 2);
    });
}

#[test]
fn pool_exhaustion_and_resize_wait_for_complete_owners_and_discard_old_returns() {
    let mut upload = Upload::default();
    let mut frames = Vec::new();
    for value in 0..SLOTS {
        frames.push(
            upload
                .frame(&pixels(64, 36, true, value as u8))
                .unwrap()
                .unwrap(),
        );
    }
    assert!(upload.frame(&pixels(64, 36, true, 7)).unwrap().is_none());
    // A cloned texture owner stands for another compositor/recording GPU reader.
    let held = frames.pop().unwrap();
    let owner = held.owner.clone();
    drop(held);
    assert!(upload.frame(&pixels(128, 72, false, 8)).unwrap().is_none());
    drop(owner);
    let resized = upload.frame(&pixels(128, 72, false, 9)).unwrap().unwrap();
    assert_eq!(resized.size, (128, 72));
    assert_eq!(upload.pool.lock().unwrap().allocated, SLOTS);
    drop(frames);
    assert_eq!(upload.pool.lock().unwrap().allocated, 1);
    assert!(upload.pool.lock().unwrap().idle.is_empty());
    drop(resized);
    assert_eq!(upload.pool.lock().unwrap().idle.len(), 1);
    let final_frame = upload.frame(&pixels(128, 72, true, 10)).unwrap().unwrap();
    let weak = Arc::downgrade(&upload.pool);
    drop(upload);
    assert!(weak.upgrade().is_none());
    // Closing the uploader cannot invalidate a frame still owned by a reader.
    let mut desc = Default::default();
    unsafe {
        final_frame.texture.GetDesc(&mut desc);
    }
    assert_eq!(desc.Width, 128);
    drop(final_frame);
}
