use super::*;
use crate::receive::Receiver;
use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};

fn process_handles() -> u32 {
    let mut count = 0;
    // SAFETY: the pseudo handle denotes this process and count is writable.
    unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count).unwrap() };
    count
}

#[test]
#[ignore = "Windows HEVC/D3D11 lifecycle and final-frame test; synthetic pixels only"]
fn async_receive_finishes_static_frames_and_cancels_repeated_inflight_closes() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let encoder = MediaSession::encoders()
            .unwrap()
            .into_iter()
            .find(|e| e.codecs.iter().any(|c| c == "video/h265"))
            .expect("HEVC hardware encoder required");
        let mut handles = Vec::new();
        for cycle in 0..10 {
            let media = MediaSession::new(MediaOptions {
                encoder: encoder.id.clone(),
                codec: Some("video/h265".into()),
                max_width: 640,
                max_height: 360,
                frame_rate: 30,
                ..Default::default()
            })
            .unwrap();
            let candidates = Arc::new(Mutex::new(Vec::new()));
            let gathered = candidates.clone();
            let receiver = Receiver::new(
                vec![],
                false,
                Arc::new(move |event| {
                    if event["type"] == "candidate" {
                        gathered.lock().unwrap().push(event["candidate"].clone());
                    }
                    true
                }),
            )
            .unwrap();
            let weak = Arc::downgrade(&receiver);
            let offer = media
                .offer_configured("readback".into(), vec![], false, false, None, None, None)
                .await
                .unwrap();
            let answer = receiver.answer(&offer).await.unwrap();
            media.answer("readback", &answer).await.unwrap();
            let mut cadence = tokio::time::interval(Duration::from_millis(33));
            let mut target = vec![0; crate::receive::FRAME_CAPACITY];
            let mut sequence = 0;
            for _ in 0..40 {
                cadence.tick().await;
                for candidate in std::mem::take(&mut *candidates.lock().unwrap()) {
                    media
                        .add_ice_candidate("readback", serde_json::from_value(candidate).unwrap())
                        .await
                        .unwrap();
                }
                let mut pixels = I420Buffer::new_black(640, 360);
                pixels.data_mut().0.fill(40);
                media.publish_frame(&VideoFrame::new(VideoRotation::VideoRotation0, pixels));
                if let Some(frame) = receiver.copy_frame(sequence, &mut target).unwrap() {
                    sequence = frame.sequence;
                }
            }
            assert!(sequence > 0, "No native frame in cycle {cycle}");
            let stats = receiver.stats().await.unwrap();
            let inbound = stats
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["type"] == "inbound-rtp" && s["kind"] == "video")
                .unwrap();
            assert!(
                inbound["decoderImplementation"]
                    .as_str()
                    .unwrap_or("")
                    .contains("async readback"),
                "{inbound}"
            );
            // No subsequent input may be needed to finish this GPU copy.
            // Admit a fresh frame after the encoder's cadence deadline; a
            // publication immediately after the loop may legitimately be skipped.
            tokio::time::sleep(Duration::from_millis(70)).await;
            let mut last = I420Buffer::new_black(640, 360);
            last.data_mut().0.fill(200);
            media.publish_frame(&VideoFrame::new(VideoRotation::VideoRotation0, last));
            if cycle % 2 == 0 {
                tokio::time::timeout(Duration::from_secs(3), async {
                    loop {
                        if let Some(frame) = receiver.copy_frame(sequence, &mut target).unwrap() {
                            sequence = frame.sequence;
                            if target[0] > 120 {
                                break;
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .expect("Final GPU output required another encoded frame");
            }
            receiver.close();
            drop(receiver);
            media.close();
            drop(media);
            tokio::time::timeout(Duration::from_secs(2), async {
                while weak.upgrade().is_some() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("Receiver retained after closing GPU work");
            tokio::time::sleep(Duration::from_millis(200)).await;
            handles.push(process_handles());
        }
        // Warm up driver/codec caches before comparing repeated teardown. Ten
        // cycles exercise completed and cancelled GPU waits and their posted tasks.
        eprintln!("Native readback process handles after close: {handles:?}");
        assert!(
            handles[9] <= handles[2] + 6,
            "GPU completion handles leaked: {handles:?}"
        );
    });
}
