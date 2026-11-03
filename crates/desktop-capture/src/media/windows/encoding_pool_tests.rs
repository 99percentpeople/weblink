use super::*;

#[test]
fn changed_feedback_retries_warmup_without_reconfiguring_a_replacement_viewer() {
    let pool = Arc::new(Pool::default());
    let first = acquire(&pool, "viewer", false);
    let other = acquire(&pool, "other", false);
    let update_pool = pool.clone();
    let updating = std::thread::spawn(move || {
        update_pool.update_peer(
            "viewer",
            &VideoSettings {
                max_width: 320,
                max_height: 180,
                frame_rate: 15,
                max_bitrate: 300_000,
                degradation_preference: "balanced".into(),
            },
            &options(),
        )
    });
    // With no capture frames, warmup stays pending until its allocation changes
    // or its consumer retires. This exercises the race without a hardware driver.
    let wait_for_budget = |target| {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !pool
            .state
            .lock()
            .unwrap()
            .slots
            .values()
            .any(|s| s.warming && s.key.bitrate == bitrate_bucket(target, 300_000))
        {
            assert!(
                std::time::Instant::now() < deadline,
                "missing warmup for {target}"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    };
    wait_for_budget(300_000);
    pool.state
        .lock()
        .unwrap()
        .slots
        .get_mut(&first.token)
        .unwrap()
        .target = 160_000;
    pool.reconcile(Arc::new(|| {})).unwrap();
    wait_for_budget(160_000);
    first.close();
    let replacement = acquire(&pool, "viewer", false);
    assert!(updating.join().unwrap().is_err());
    assert!(Arc::ptr_eq(
        &replacement.encoder().unwrap(),
        &other.encoder().unwrap()
    ));
    let state = pool.state.lock().unwrap();
    assert!(state.slots[&replacement.token].limits.is_none());
    assert_eq!(state.slots.len(), 2);
    assert_eq!(state.groups.len(), 1);
}
#[test]
fn different_viewer_ceilings_share_only_while_their_bitrate_buckets_match() {
    let pool = Arc::new(Pool::default());
    let viewer = |id: &str, limit| {
        pool.acquire(
            id.into(),
            "test".into(),
            MediaOptions {
                max_bitrate: limit,
                ..options()
            },
            false,
            false,
            Arc::new(|| {}),
        )
        .unwrap()
    };
    let high = viewer("high", 4_000_000);
    let low = viewer("low", 1_000_000);
    let encoder = high.encoder().unwrap();
    let low_output = low.output.as_ref().unwrap().clone();
    assert!(Arc::ptr_eq(&encoder, &low.encoder().unwrap()));
    assert_eq!(encoder.group_limit(), Some(1_000_000));
    let change = |target| {
        pool.state
            .lock()
            .unwrap()
            .slots
            .get_mut(&high.token)
            .unwrap()
            .target = target;
        pool.reconcile(Arc::new(|| {})).unwrap();
    };
    change(3_000_000);
    assert_eq!(pool.active().len(), 2);
    assert_eq!(low.encoder().unwrap().group_limit(), Some(1_000_000));
    assert_eq!(high.encoder().unwrap().group_limit(), Some(4_000_000));
    change(300_000);
    assert_eq!(pool.active().len(), 1);
    assert!(Arc::ptr_eq(&low_output, low.output.as_ref().unwrap()));
    pool.update_peer(
        "low",
        &VideoSettings {
            max_width: options().max_width,
            max_height: options().max_height,
            frame_rate: options().frame_rate,
            max_bitrate: 600_000,
            degradation_preference: "balanced".into(),
        },
        &MediaOptions {
            max_bitrate: 4_000_000,
            ..options()
        },
    )
    .unwrap();
    assert!(Arc::ptr_eq(&encoder, &high.encoder().unwrap()));
    assert_eq!(encoder.group_limit(), Some(600_000));
    low.close();
    assert_eq!(encoder.group_limit(), Some(4_000_000));
    high.close();
    assert!(pool.active().is_empty());
}
#[test]
fn failed_viewer_profile_keeps_the_original_encoder_and_other_consumers() {
    let pool = Arc::new(Pool::default());
    let viewer = acquire(&pool, "viewer", false);
    let other = acquire(&pool, "other", false);
    let recording = acquire(&pool, "recording", true);
    let original = viewer.encoder().unwrap();
    let output = viewer.output.as_ref().unwrap().clone();
    let worker_pool = pool.clone();
    let worker = std::thread::spawn(move || {
        worker_pool.update_peer(
            "viewer",
            &VideoSettings {
                max_width: 320,
                max_height: 180,
                frame_rate: 15,
                max_bitrate: 200_000,
                degradation_preference: "balanced".into(),
            },
            &options(),
        )
    });
    let started = std::time::Instant::now();
    while !worker.is_finished() && started.elapsed() < std::time::Duration::from_secs(5) {
        for (id, encoder) in pool.active() {
            if id.starts_with("warming:") {
                encoder.submit(Arc::new(hardware::Frame::from_i420(
                    &libwebrtc::video_frame::I420Buffer::new_black(320, 180),
                    None,
                )));
            }
        }
        assert!(pool.take_failed_peers().is_empty());
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(worker.join().unwrap().is_err());
    assert!(Arc::ptr_eq(&original, &viewer.encoder().unwrap()));
    assert!(Arc::ptr_eq(&original, &other.encoder().unwrap()));
    assert!(Arc::ptr_eq(&original, &recording.encoder().unwrap()));
    assert!(Arc::ptr_eq(&output, viewer.output.as_ref().unwrap()));
    assert_eq!(pool.active().len(), 1);
    pool.close();
}
fn options() -> MediaOptions {
    MediaOptions {
        codec: Some("video/h264".into()),
        max_bitrate: 300_000,
        ..Default::default()
    }
}
fn acquire(pool: &Arc<Pool>, id: &str, recording: bool) -> Arc<Consumer> {
    pool.acquire(
        id.into(),
        "test".into(),
        options(),
        false,
        recording,
        Arc::new(|| {}),
    )
    .unwrap()
}
#[test]
fn concurrent_viewers_and_recording_share_one_encoder_and_own_their_lifetimes() {
    let pool = Arc::new(Pool::default());
    let threads: Vec<_> = (0..8)
        .map(|n| {
            let pool = pool.clone();
            std::thread::spawn(move || acquire(&pool, &format!("viewer-{n}"), false))
        })
        .collect();
    let viewers: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    let recording = acquire(&pool, "recording", true);
    let encoder = recording.encoder().unwrap();
    assert_eq!(pool.active().len(), 1);
    let stats = pool.statistics();
    assert_eq!(stats[0].group_id, encoder.group_id);
    assert_eq!(stats[0].consumers.len(), 9);
    for viewer in &viewers {
        assert!(Arc::ptr_eq(&encoder, &viewer.encoder().unwrap()));
    }
    drop(viewers);
    assert_eq!(pool.active().len(), 1);
    assert_eq!(pool.statistics()[0].group_id, encoder.group_id);
    assert_eq!(pool.statistics()[0].consumers, ["recording"]);
    let later = acquire(&pool, "later", false);
    recording.close();
    assert!(Arc::ptr_eq(&encoder, &later.encoder().unwrap()));
    later.close();
    assert!(pool.active().is_empty());
    let next = acquire(&pool, "later", false);
    // A diagnostic Arc and a stale consumer cannot revive/close the old group.
    assert!(!Arc::ptr_eq(&encoder, &next.encoder().unwrap()));
    later.close();
    assert!(next.encoder().is_some());
    pool.close();
    assert!(next.encoder().is_none());
    assert!(pool
        .acquire(
            "closed".into(),
            "test".into(),
            options(),
            false,
            false,
            Arc::new(|| {})
        )
        .is_err());
}
#[test]
fn bandwidth_changes_split_only_the_changed_viewer_and_rejoin_without_replacing_outputs() {
    let pool = Arc::new(Pool::default());
    let first = acquire(&pool, "first", false);
    let second = acquire(&pool, "second", false);
    let original = first.encoder().unwrap();
    let output = second.output.as_ref().unwrap().clone();
    let target = |value| {
        pool.state
            .lock()
            .unwrap()
            .slots
            .get_mut(&second.token)
            .unwrap()
            .target = value;
        pool.reconcile(Arc::new(|| {})).unwrap();
    };
    target(160_000);
    assert!(Arc::ptr_eq(&original, &first.encoder().unwrap()));
    assert!(!Arc::ptr_eq(&original, &second.encoder().unwrap()));
    assert_eq!(pool.active().len(), 2);
    assert!(Arc::ptr_eq(&output, second.output.as_ref().unwrap()));
    let lower = second.encoder().unwrap();
    target(0);
    assert!(
        Arc::ptr_eq(&lower, &second.encoder().unwrap()),
        "A sole viewer pauses in place"
    );
    target(300_000);
    assert_eq!(pool.active().len(), 1);
    assert!(Arc::ptr_eq(&original, &second.encoder().unwrap()));
    first.close();
    second.close();
    assert!(pool.active().is_empty());
}
#[test]
fn viewers_changing_bandwidth_together_keep_their_shared_encoder() {
    let pool = Arc::new(Pool::default());
    let viewers: Vec<_> = (0..3)
        .map(|n| acquire(&pool, &format!("viewer-{n}"), false))
        .collect();
    let original = viewers[0].encoder().unwrap();
    for target in [160_000, 0, 300_000, 160_000, 300_000] {
        {
            let mut state = pool.state.lock().unwrap();
            for slot in state.slots.values_mut() {
                slot.target = target;
            }
        }
        pool.reconcile(Arc::new(|| {})).unwrap();
        assert_eq!(pool.active().len(), 1);
        for viewer in &viewers {
            assert!(
                Arc::ptr_eq(&original, &viewer.encoder().unwrap()),
                "A shared bandwidth change must not reopen the encoder or wait for a new keyframe"
            );
        }
        let state = pool.state.lock().unwrap();
        assert_eq!(state.groups.len(), 1);
        for slot in state.slots.values() {
            assert_eq!(
                slot.key.bitrate,
                bitrate_bucket(target, options().max_bitrate)
            );
        }
    }
    pool.close();
}

#[test]
fn staggered_recovery_applies_each_budget_and_rejoins_the_existing_encoder() {
    let pool = Arc::new(Pool::default());
    let first = acquire(&pool, "first", false);
    let second = acquire(&pool, "second", false);
    let first_output = first.output.as_ref().unwrap().clone();
    let second_output = second.output.as_ref().unwrap().clone();
    {
        let mut state = pool.state.lock().unwrap();
        for slot in state.slots.values_mut() {
            slot.target = 160_000;
        }
    }
    pool.reconcile(Arc::new(|| {})).unwrap();
    let original = second.encoder().unwrap();
    pool.state
        .lock()
        .unwrap()
        .slots
        .get_mut(&first.token)
        .unwrap()
        .target = 300_000;
    pool.reconcile(Arc::new(|| {})).unwrap();
    assert_eq!(
        pool.active().len(),
        2,
        "The faster viewer must recover without waiting for the slower viewer"
    );
    let recovered = first.encoder().unwrap();
    assert!(!Arc::ptr_eq(&original, &recovered));
    assert!(Arc::ptr_eq(&original, &second.encoder().unwrap()));
    {
        let state = pool.state.lock().unwrap();
        assert_eq!(
            state.slots[&first.token].key.bitrate,
            bitrate_bucket(300_000, 300_000)
        );
        assert_eq!(
            state.slots[&second.token].key.bitrate,
            bitrate_bucket(160_000, 300_000)
        );
    }
    pool.state
        .lock()
        .unwrap()
        .slots
        .get_mut(&second.token)
        .unwrap()
        .target = 300_000;
    pool.reconcile(Arc::new(|| {})).unwrap();
    assert_eq!(pool.active().len(), 1);
    assert!(Arc::ptr_eq(&recovered, &first.encoder().unwrap()));
    assert!(Arc::ptr_eq(&recovered, &second.encoder().unwrap()));
    assert!(Arc::ptr_eq(&first_output, first.output.as_ref().unwrap()));
    assert!(Arc::ptr_eq(&second_output, second.output.as_ref().unwrap()));
    assert_eq!(
        pool.state.lock().unwrap().slots[&first.token].key.bitrate,
        bitrate_bucket(300_000, 300_000)
    );
    pool.close();
}

#[test]
fn different_formats_do_not_share_and_live_settings_preserve_consumers() {
    let pool = Arc::new(Pool::default());
    let first = acquire(&pool, "first", false);
    let hevc = pool
        .acquire(
            "hevc".into(),
            "test".into(),
            MediaOptions {
                codec: Some("video/h265".into()),
                ..options()
            },
            false,
            false,
            Arc::new(|| {}),
        )
        .unwrap();
    assert_eq!(pool.active().len(), 2);
    let first_encoder = first.encoder().unwrap();
    pool.update(&VideoSettings {
        max_width: 1280,
        max_height: 720,
        frame_rate: 60,
        max_bitrate: 400_000,
        degradation_preference: "balanced".into(),
    })
    .unwrap();
    pool.reconcile(Arc::new(|| {})).unwrap();
    assert!(Arc::ptr_eq(&first_encoder, &first.encoder().unwrap()));
    assert!(!Arc::ptr_eq(&first_encoder, &hevc.encoder().unwrap()));
    pool.close();
}

#[test]
fn live_bitrate_changes_keep_the_recording_tap_on_its_original_worker() {
    let pool = Arc::new(Pool::default());
    let viewer = acquire(&pool, "viewer", false);
    let recording = acquire(&pool, "recording", true);
    let original = recording.encoder().unwrap();
    let slow = acquire(&pool, "slow", false);
    pool.state
        .lock()
        .unwrap()
        .slots
        .get_mut(&slow.token)
        .unwrap()
        .target = 150_000;
    pool.reconcile(Arc::new(|| {})).unwrap();
    assert_eq!(pool.active().len(), 2);
    pool.update(&VideoSettings {
        max_width: 1920,
        max_height: 1080,
        frame_rate: 30,
        max_bitrate: 150_000,
        degradation_preference: "balanced".into(),
    })
    .unwrap();
    pool.reconcile(Arc::new(|| {})).unwrap();
    assert!(Arc::ptr_eq(&original, &recording.encoder().unwrap()));
    assert!(Arc::ptr_eq(&original, &viewer.encoder().unwrap()));
    assert!(Arc::ptr_eq(&original, &slow.encoder().unwrap()));
    assert_eq!(pool.active().len(), 1);
    pool.close();
}
