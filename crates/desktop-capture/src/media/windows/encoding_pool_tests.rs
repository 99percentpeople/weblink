use super::*;
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
fn staggered_recovery_keeps_the_shared_encoder_until_all_feedback_arrives() {
    let pool = Arc::new(Pool::default());
    let first = acquire(&pool, "first", false);
    let second = acquire(&pool, "second", false);
    let original = first.encoder().unwrap();
    let now = std::time::Instant::now();
    {
        let mut state = pool.state.lock().unwrap();
        for slot in state.slots.values_mut() {
            slot.target = 160_000;
        }
    }
    pool.reconcile_at(Arc::new(|| {}), now).unwrap();
    pool.state
        .lock()
        .unwrap()
        .slots
        .get_mut(&first.token)
        .unwrap()
        .target = 300_000;
    pool.reconcile_at(Arc::new(|| {}), now).unwrap();
    assert_eq!(
        pool.active().len(),
        1,
        "Do not split on staggered upward feedback"
    );
    pool.state
        .lock()
        .unwrap()
        .slots
        .get_mut(&second.token)
        .unwrap()
        .target = 300_000;
    pool.reconcile_at(Arc::new(|| {}), now + std::time::Duration::from_millis(50))
        .unwrap();
    assert_eq!(pool.active().len(), 1);
    assert!(Arc::ptr_eq(&original, &first.encoder().unwrap()));
    assert!(Arc::ptr_eq(&original, &second.encoder().unwrap()));
    assert_eq!(
        pool.state.lock().unwrap().slots[&first.token].key.bitrate,
        bitrate_bucket(300_000, 300_000)
    );
    pool.close();
}

#[test]
fn sustained_recovery_splits_after_grace_but_reductions_and_resume_are_immediate() {
    let pool = Arc::new(Pool::default());
    let first = acquire(&pool, "first", false);
    let second = acquire(&pool, "second", false);
    let now = std::time::Instant::now();
    let set = |consumer: &Consumer, target| {
        pool.state
            .lock()
            .unwrap()
            .slots
            .get_mut(&consumer.token)
            .unwrap()
            .target = target;
    };
    set(&first, 160_000);
    set(&second, 160_000);
    pool.reconcile_at(Arc::new(|| {}), now).unwrap();
    let original = second.encoder().unwrap();
    set(&first, 300_000);
    pool.reconcile_at(Arc::new(|| {}), now).unwrap();
    assert_eq!(pool.active().len(), 1);
    pool.reconcile_at(Arc::new(|| {}), now + std::time::Duration::from_secs(1))
        .unwrap();
    assert_eq!(
        pool.active().len(),
        2,
        "A persistently faster viewer must regain its bitrate"
    );
    assert!(Arc::ptr_eq(&original, &second.encoder().unwrap()));
    set(&first, 0);
    pool.reconcile_at(
        Arc::new(|| {}),
        now + std::time::Duration::from_millis(1001),
    )
    .unwrap();
    assert_eq!(
        pool.state.lock().unwrap().slots[&first.token].key.bitrate,
        0
    );
    set(&first, 160_000);
    pool.reconcile_at(
        Arc::new(|| {}),
        now + std::time::Duration::from_millis(1002),
    )
    .unwrap();
    assert_eq!(
        pool.active().len(),
        1,
        "Resuming from zero must not wait for migration grace"
    );
    assert!(Arc::ptr_eq(&original, &first.encoder().unwrap()));
    pool.close();
}

#[test]
fn a_budget_dip_cancels_pending_upward_migration() {
    let pool = Arc::new(Pool::default());
    let first = acquire(&pool, "first", false);
    let second = acquire(&pool, "second", false);
    let now = Instant::now();
    for slot in pool.state.lock().unwrap().slots.values_mut() {
        slot.target = 160_000;
    }
    pool.reconcile_at(Arc::new(|| {}), now).unwrap();
    let original = first.encoder().unwrap();
    for (ms, target) in [(0, 300_000), (450, 160_000), (500, 300_000), (600, 300_000)] {
        pool.state
            .lock()
            .unwrap()
            .slots
            .get_mut(&first.token)
            .unwrap()
            .target = target;
        pool.reconcile_at(Arc::new(|| {}), now + Duration::from_millis(ms))
            .unwrap();
        assert_eq!(pool.active().len(), 1);
        assert!(Arc::ptr_eq(&original, &first.encoder().unwrap()));
        assert!(Arc::ptr_eq(&original, &second.encoder().unwrap()));
    }
    pool.reconcile_at(Arc::new(|| {}), now + Duration::from_millis(1000))
        .unwrap();
    assert_eq!(pool.active().len(), 2);
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
