use super::*;

#[test]
#[ignore = "Requires a Windows H.264 hardware encoder"]
fn viewer_quality_splits_and_rejoins_live_encoders_without_reconnecting() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let hardware = mf::detect()
            .unwrap()
            .into_iter()
            .find(|e| e.codecs.contains(&"video/h264".into()))
            .unwrap();
        let media = MediaSession::new(MediaOptions {
            encoder: hardware.id,
            codec: Some("video/h264".into()),
            frame_rate: 30,
            max_width: 640,
            max_height: 360,
            max_bitrate: 300_000,
            ..Default::default()
        })
        .unwrap();
        let first = connect(&media, "first", false).await.unwrap();
        let second = connect(&media, "second", false).await.unwrap();
        recording::frames(&media, 45).await;
        let original = media.hardware.encoder("second").unwrap();
        let before = decoded(&first).await;
        let update = |width, height, fps| {
            let media = media.clone();
            tokio::task::spawn_blocking(move || {
                media.update_peer_video_settings(
                    "first",
                    VideoSettings {
                        max_width: width,
                        max_height: height,
                        frame_rate: fps,
                        max_bitrate: 300_000,
                        degradation_preference: "balanced".into(),
                    },
                )
            })
        };
        let (result, _) = tokio::join!(update(320, 180, 15), recording::frames(&media, 60));
        result.unwrap().unwrap();
        assert!(decoded(&first).await > before + 5);
        assert!(decoded(&second).await > 10);
        assert!(Arc::ptr_eq(
            &original,
            &media.hardware.encoder("second").unwrap()
        ));
        assert!(!Arc::ptr_eq(
            &original,
            &media.hardware.encoder("first").unwrap()
        ));
        assert!(media
            .stats("first")
            .await
            .unwrap()
            .iter()
            .any(|s| s.width == 320 && s.height == 180));
        assert!(media
            .stats("second")
            .await
            .unwrap()
            .iter()
            .any(|s| s.width == 640 && s.height == 360));
        let (result, _) = tokio::join!(update(640, 360, 30), recording::frames(&media, 45));
        result.unwrap().unwrap();
        assert!(Arc::ptr_eq(
            &original,
            &media.hardware.encoder("first").unwrap()
        ));
        assert_eq!(media.peers.lock().unwrap().len(), 2);
        media.close();
    });
}

async fn drain(media: Arc<MediaSession>) -> usize {
    let started = Instant::now();
    let mut packets = 0;
    while started.elapsed() < Duration::from_millis(1250) {
        let source = media.clone();
        let data = tokio::task::spawn_blocking(move || source.read_recording("shared").unwrap())
            .await
            .unwrap();
        let mut at = 0;
        while at < data.len() {
            let size = u32::from_le_bytes(data[at..at + 4].try_into().unwrap()) as usize;
            assert_ne!(
                data[at + 32],
                2,
                "Recording terminated: {}",
                String::from_utf8_lossy(&data[at + 36..at + 36 + size])
            );
            assert_eq!(data[at + 32], 0);
            assert_eq!(data[at + 33], 1);
            packets += 1;
            at += 36 + size;
        }
    }
    packets
}

#[test]
#[ignore = "Requires a Windows H.264 hardware encoder"]
fn shared_encoder_survives_viewer_churn_and_recording_owns_the_last_lease() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let hardware = mf::detect()
            .unwrap()
            .into_iter()
            .find(|encoder| encoder.codecs.contains(&"video/h264".into()))
            .unwrap();
        let media = MediaSession::new(MediaOptions {
            encoder: hardware.id,
            codec: Some("video/h264".into()),
            frame_rate: 30,
            max_width: 640,
            max_height: 360,
            max_bitrate: 300_000,
            ..Default::default()
        })
        .unwrap();
        let first = connect(&media, "first", false).await.unwrap();
        recording::frames(&media, 45).await;
        let before = decoded(&first).await;
        assert!(before > 5);
        let second = connect(&media, "second", false).await.unwrap();
        recording::frames(&media, 60).await;
        assert!(decoded(&first).await > before + 10);
        assert!(decoded(&second).await > 10);
        assert_eq!(media.hardware.active().len(), 1);
        assert!(Arc::ptr_eq(
            &media.hardware.encoder("first").unwrap(),
            &media.hardware.encoder("second").unwrap()
        ));
        media
            .open_recording("shared".into(), false, Some("video/h264".into()))
            .unwrap()
            .unwrap();
        media.control_recording("shared", true, 1).unwrap();
        let (_, packets) = tokio::join!(recording::frames(&media, 35), drain(media.clone()));
        assert!(packets > 10);
        assert_eq!(media.hardware.active().len(), 1);
        let before = decoded(&second).await;
        media.close_peer("first");
        let (_, packets) = tokio::join!(recording::frames(&media, 35), drain(media.clone()));
        assert!(packets > 10);
        assert!(decoded(&second).await > before + 10);
        media.close_peer("second");
        assert!(media.has_consumers());
        let (_, packets) = tokio::join!(recording::frames(&media, 35), drain(media.clone()));
        assert!(packets > 10, "Recording must outlive all viewers");
        let group_id = media.pipeline_stats().encoders[0].group_id;
        media
            .update_video_settings(VideoSettings {
                max_width: 640,
                max_height: 360,
                frame_rate: 30,
                max_bitrate: 200_000,
                degradation_preference: "balanced".into(),
            })
            .unwrap();
        let (_, packets) = tokio::join!(recording::frames(&media, 35), drain(media.clone()));
        assert!(
            packets > 10,
            "Live bitrate changes must preserve the recording tap"
        );
        assert_eq!(media.pipeline_stats().encoders[0].group_id, group_id);
        // Keep draining while ICE gathering connects a returning viewer.
        let (third, _) = tokio::join!(connect(&media, "third", false), drain(media.clone()));
        let third = third.unwrap();
        let (_, packets) = tokio::join!(recording::frames(&media, 35), drain(media.clone()));
        assert!(packets > 10);
        assert!(decoded(&third).await > 10);
        assert_eq!(media.hardware.active().len(), 1);
        media.close_recording("shared");
        let before = decoded(&third).await;
        recording::frames(&media, 30).await;
        assert!(decoded(&third).await > before + 5);
        media.close_peer("third");
        assert!(media.hardware.active().is_empty());
        media.close();
    });
}
