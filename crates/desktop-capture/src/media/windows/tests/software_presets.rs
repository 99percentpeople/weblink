use super::*;
use crate::media::preset::EncodingPreset;

#[test]
fn software_presets_encode_decode_reconnect_and_keep_limits() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        for codec in ["video/vp8", "video/vp9", "video/h264", "video/av1"] {
            for preset in EncodingPreset::ALL {
                let options = MediaOptions {
                    encoder: "software".into(),
                    codec: Some(codec.into()),
                    encoding_preset: preset,
                    max_width: 320,
                    max_height: 180,
                    frame_rate: 30,
                    max_bitrate: 2_000_000,
                    degradation_preference: "maintain-resolution".into(),
                    ..Default::default()
                };
                let media = MediaSession::new(options).unwrap();
                let weak = Arc::downgrade(&media);
                for negotiated in [false, true] {
                    let receiver = connect_with_codecs(
                        &media,
                        "preset",
                        false,
                        negotiated.then(|| crate::media::SendCodecs {
                            video: codec.into(),
                            audio: "audio/opus".into(),
                        }),
                    )
                    .await
                    .unwrap();
                    let input = vfr::Frames::with_size(320, 180);
                    tokio::time::timeout(Duration::from_secs(8), async {
                        let mut index = 0;
                        loop {
                            input.send(&media, index);
                            index += 1;
                            let stats = media.stats("preset").await.unwrap();
                            if decoded(&receiver).await >= 4
                                && stats.iter().any(|s| {
                                    s.frames >= 4
                                        && s.implementation.contains(match preset {
                                            EncodingPreset::Balanced => "[balanced]",
                                            EncodingPreset::Quality => "[quality]",
                                            EncodingPreset::Latency => "[latency]",
                                        })
                                })
                            {
                                break;
                            }
                            assert!(
                                media.error().is_none(),
                                "{codec} {preset:?}: {:?}",
                                media.error()
                            );
                            tokio::time::sleep(Duration::from_millis(33)).await;
                        }
                    })
                    .await
                    .unwrap_or_else(|_| {
                        panic!("{codec} {preset:?} did not encode/decode (negotiated={negotiated})")
                    });
                    let peers = media.peers.lock().unwrap();
                    let params = peers["preset"].connection.senders().remove(0).parameters();
                    assert_eq!(params.encodings[0].max_bitrate, Some(2_000_000));
                    assert_eq!(params.encodings[0].max_framerate, Some(30.0));
                    assert_eq!(
                        params.degradation_preference(),
                        Some(DegradationPreference::MaintainResolution)
                    );
                    drop(peers);
                    media.close_peer("preset");
                    drop(receiver);
                }
                // Teardown with a negotiated but unanswered peer exercises cancellation.
                media
                    .offer("cancel".into(), vec![], false, false)
                    .await
                    .unwrap();
                media.close();
                assert!(media.peers.lock().unwrap().is_empty());
                drop(media);
                tokio::time::timeout(Duration::from_secs(3), async {
                    while weak.upgrade().is_some() {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("Software preset session leaked after cancellation");
                eprintln!("{codec} {preset:?}: decode, reconnect, limits and teardown OK");
            }
        }
    });
}
