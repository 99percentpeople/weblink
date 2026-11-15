use super::*;

fn visible() -> ViewStatistics {
    let mut stats = ViewStatistics::default();
    stats.set_visible(true);
    stats
}

fn low(stats: &mut ViewStatistics, at: Instant) -> f64 {
    stats.snapshot(at).one_percent_low_fps.unwrap()
}

#[test]
fn low_uses_the_same_slowest_interval_tail_as_browser_presentation() {
    let mut stats = visible();
    let mut at = Instant::now();
    assert_eq!(low(&mut stats, at), 0.);
    stats.presented(at, 0., 0.);
    for i in 1..=200 {
        at += Duration::from_millis(match i {
            5 => 40,
            9 => 20,
            _ => 10,
        });
        stats.presented(at, 2., 1.);
        if i == 99 {
            assert_eq!(low(&mut stats, at), 25.);
        }
    }
    assert!((low(&mut stats, at) - 1000. / 30.).abs() < 1e-9);
    for _ in 201..=500 {
        at += Duration::from_millis(10);
        stats.presented(at, 2., 1.);
    }
    assert!((low(&mut stats, at) - 1000. / 18.).abs() < 1e-9);
    for _ in 501..=1100 {
        at += Duration::from_millis(10);
        stats.presented(at, 2., 1.);
    }
    let snapshot = stats.snapshot(at);
    assert_eq!(snapshot.presented_frames, 1101);
    assert!((snapshot.one_percent_low_fps.unwrap() - 100.).abs() < 1e-9);
    assert_eq!(snapshot.one_percent_low_state, None);
    assert_eq!(snapshot.decoded_queue_ms, 2.);
    assert_eq!(snapshot.submit_ms, 1.);
    assert_eq!(low(&mut stats, at + LOW_WINDOW), 0.);
}

#[test]
fn expiration_uses_wall_time_at_every_frame_rate_without_waiting_for_another_frame() {
    for fps in [30., 60., 120.] {
        let mut stats = visible();
        let start = Instant::now();
        stats.presented(start, 0., 0.);
        stats.presented(start + Duration::from_millis(100), 0., 0.);
        for n in 1..=(fps as usize * 10) {
            stats.presented(
                start + Duration::from_secs_f64(0.1 + n as f64 / fps),
                0.,
                0.,
            );
        }
        assert!(low(&mut stats, start + Duration::from_millis(10099)) < fps);
        assert!((low(&mut stats, start + Duration::from_millis(10100)) - fps).abs() < 1e-4);
    }
}

#[test]
fn hiding_resets_the_window_and_excludes_background_submissions_and_time() {
    let mut stats = visible();
    let start = Instant::now();
    stats.presented(start, 0., 0.);
    stats.presented(start + Duration::from_millis(200), 0., 0.);
    assert_eq!(low(&mut stats, start + Duration::from_millis(200)), 5.);
    stats.set_visible(true); // Repeated layout messages do not reset a live window.
    assert_eq!(low(&mut stats, start + Duration::from_millis(200)), 5.);
    stats.set_visible(false);
    stats.presented(start + Duration::from_secs(5), 0., 0.);
    let hidden = stats.snapshot(start + Duration::from_secs(5));
    assert_eq!(hidden.one_percent_low_fps, None);
    assert_eq!(hidden.presented_frames, 2);
    stats.set_visible(true);
    stats.presented(start + Duration::from_secs(20), 0., 0.);
    assert_eq!(low(&mut stats, start + Duration::from_secs(20)), 0.);
    stats.presented(start + Duration::from_millis(20010), 0., 0.);
    assert_eq!(low(&mut stats, start + Duration::from_millis(20010)), 100.);
}

#[test]
fn stalled_and_restarted_clocks_do_not_emit_invalid_low_values() {
    let mut stats = visible();
    let start = Instant::now();
    stats.presented(start, 0., 0.);
    stats.presented(start, 0., 0.);
    assert_eq!(low(&mut stats, start), 0.);
    stats.presented(start + Duration::from_millis(10), 0., 0.);
    assert_eq!(low(&mut stats, start + Duration::from_millis(10)), 100.);
    stats.presented(start, 0., 0.);
    assert_eq!(low(&mut stats, start), 0.);
}

#[test]
fn dense_histories_are_bounded_and_marked_estimated_until_truncation_expires() {
    let mut stats = visible();
    let start = Instant::now();
    for i in 0..=MAX_INTERVALS + 10 {
        stats.presented(start + Duration::from_micros(i as u64 * 100), 0., 0.);
    }
    assert_eq!(stats.intervals.len(), MAX_INTERVALS);
    let snapshot = stats.snapshot(start + Duration::from_secs(2));
    assert_eq!(snapshot.one_percent_low_state, Some("estimated"));
    assert!((snapshot.one_percent_low_fps.unwrap() - 10_000.).abs() < 1e-6);
    let expired = stats.snapshot(start + Duration::from_secs(11));
    assert_eq!(expired.one_percent_low_state, None);
    assert!(expired.one_percent_low_fps.unwrap().is_finite());
}
