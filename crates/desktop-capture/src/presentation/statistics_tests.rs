use super::*;

#[test]
fn same_frame_segments_cover_delivery_network_decode_and_presentation_without_overlap() {
    let mut stats = visible();
    let capture = Instant::now();
    let received = capture + Duration::from_millis(30);
    let decoded = capture + Duration::from_millis(40);
    let submitted = capture + Duration::from_millis(60);
    stats.presented_frame(
        submitted,
        4.,
        1.,
        FrameTiming {
            captured: Some(capture),
            received: Some(received),
            decoded: Some(decoded),
        },
    );
    let s = stats.snapshot(submitted);
    assert_eq!(s.capture_to_receive_ms, Some(30.));
    assert_eq!(s.receive_to_present_ms, Some(30.));
    assert_eq!(s.decode_to_present_ms, Some(20.));
    assert_eq!(s.end_to_end_ms, Some(60.));
    assert_eq!(
        s.capture_to_receive_ms.unwrap() + s.receive_to_present_ms.unwrap(),
        s.end_to_end_ms.unwrap()
    );
    let stale = stats.snapshot(submitted + Duration::from_millis(1501));
    assert_eq!(stale.timing_age_ms, None);
    assert_eq!(stale.receive_to_present_ms, None);
    assert_eq!(stale.decode_to_present_ms, None);
    stats.presented_frame(
        submitted,
        0.,
        0.,
        FrameTiming {
            captured: Some(decoded),
            received: Some(received),
            decoded: None,
        },
    );
    let invalid = stats.snapshot(submitted);
    assert_eq!(invalid.end_to_end_ms, None);
    assert_eq!(invalid.capture_to_receive_ms, None);
    assert_eq!(invalid.receive_to_present_ms, Some(30.));
    assert_eq!(invalid.decode_to_present_ms, None);
    stats.presented_frame(submitted, 0., 0., FrameTiming::default());
    assert_eq!(stats.snapshot(submitted).receive_to_present_ms, None);
}

#[test]
fn latency_belongs_to_each_submitted_frame_and_expires_like_browser_timing() {
    let mut stats = visible();
    let start = Instant::now();
    stats.presented(start, 3., 1., Some(start - Duration::from_millis(80)));
    let sample = stats.snapshot(start);
    assert_eq!(sample.end_to_end_ms, Some(80.));
    assert_eq!(sample.end_to_end_state, Some("estimated"));
    assert_eq!(sample.end_to_end_age_ms, Some(0.));
    let later = stats.snapshot(start + Duration::from_millis(1500));
    assert_eq!(later.end_to_end_ms, Some(80.));
    assert_eq!(later.end_to_end_age_ms, Some(1500.));
    let stale = stats.snapshot(start + Duration::from_millis(1501));
    assert_eq!(stale.end_to_end_ms, None);
    assert_eq!(stale.end_to_end_state, None);
    assert_eq!(stale.end_to_end_age_ms, None);

    stats.presented(start, 0., 0., None);
    assert_eq!(stats.snapshot(start).end_to_end_ms, None);
    stats.presented(start, 0., 0., Some(start + Duration::from_millis(1)));
    assert_eq!(stats.snapshot(start).end_to_end_ms, None);
    stats.presented(start, 0., 0., Some(start));
    assert_eq!(stats.snapshot(start).end_to_end_ms, Some(0.));
    stats.set_visible(false);
    stats.presented(start, 0., 0., Some(start));
    assert_eq!(stats.snapshot(start).end_to_end_ms, None);
    stats.set_visible(true);
    assert_eq!(stats.snapshot(start).end_to_end_ms, None);
}

#[test]
fn two_views_of_one_frame_measure_their_own_presentation_time() {
    let capture = Instant::now();
    let mut first = visible();
    let mut second = visible();
    first.presented(capture + Duration::from_millis(40), 1., 1., Some(capture));
    second.presented(capture + Duration::from_millis(70), 2., 2., Some(capture));
    let now = capture + Duration::from_millis(100);
    assert_eq!(first.snapshot(now).end_to_end_ms, Some(40.));
    assert_eq!(second.snapshot(now).end_to_end_ms, Some(70.));
    assert_eq!(first.snapshot(capture).end_to_end_ms, None);
}

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
    stats.presented(at, 0., 0., None);
    for i in 1..=200 {
        at += Duration::from_millis(match i {
            5 => 40,
            9 => 20,
            _ => 10,
        });
        stats.presented(at, 2., 1., None);
        if i == 99 {
            assert_eq!(low(&mut stats, at), 25.);
        }
    }
    assert!((low(&mut stats, at) - 1000. / 30.).abs() < 1e-9);
    for _ in 201..=500 {
        at += Duration::from_millis(10);
        stats.presented(at, 2., 1., None);
    }
    assert!((low(&mut stats, at) - 1000. / 18.).abs() < 1e-9);
    for _ in 501..=1100 {
        at += Duration::from_millis(10);
        stats.presented(at, 2., 1., None);
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
        stats.presented(start, 0., 0., None);
        stats.presented(start + Duration::from_millis(100), 0., 0., None);
        for n in 1..=(fps as usize * 10) {
            stats.presented(
                start + Duration::from_secs_f64(0.1 + n as f64 / fps),
                0.,
                0.,
                None,
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
    stats.presented(start, 0., 0., None);
    stats.presented(start + Duration::from_millis(200), 0., 0., None);
    assert_eq!(low(&mut stats, start + Duration::from_millis(200)), 5.);
    stats.set_visible(true); // Repeated layout messages do not reset a live window.
    assert_eq!(low(&mut stats, start + Duration::from_millis(200)), 5.);
    stats.set_visible(false);
    stats.presented(start + Duration::from_secs(5), 0., 0., None);
    let hidden = stats.snapshot(start + Duration::from_secs(5));
    assert_eq!(hidden.one_percent_low_fps, None);
    assert_eq!(hidden.presented_frames, 2);
    stats.set_visible(true);
    stats.presented(start + Duration::from_secs(20), 0., 0., None);
    assert_eq!(low(&mut stats, start + Duration::from_secs(20)), 0.);
    stats.presented(start + Duration::from_millis(20010), 0., 0., None);
    assert_eq!(low(&mut stats, start + Duration::from_millis(20010)), 100.);
}

#[test]
fn stalled_and_restarted_clocks_do_not_emit_invalid_low_values() {
    let mut stats = visible();
    let start = Instant::now();
    stats.presented(start, 0., 0., None);
    stats.presented(start, 0., 0., None);
    assert_eq!(low(&mut stats, start), 0.);
    stats.presented(start + Duration::from_millis(10), 0., 0., None);
    assert_eq!(low(&mut stats, start + Duration::from_millis(10)), 100.);
    stats.presented(start, 0., 0., None);
    assert_eq!(low(&mut stats, start), 0.);
}

#[test]
fn dense_histories_are_bounded_and_marked_estimated_until_truncation_expires() {
    let mut stats = visible();
    let start = Instant::now();
    for i in 0..=MAX_INTERVALS + 10 {
        stats.presented(start + Duration::from_micros(i as u64 * 100), 0., 0., None);
    }
    assert_eq!(stats.intervals.len(), MAX_INTERVALS);
    let snapshot = stats.snapshot(start + Duration::from_secs(2));
    assert_eq!(snapshot.one_percent_low_state, Some("estimated"));
    assert!((snapshot.one_percent_low_fps.unwrap() - 10_000.).abs() < 1e-6);
    let expired = stats.snapshot(start + Duration::from_secs(11));
    assert_eq!(expired.one_percent_low_state, None);
    assert!(expired.one_percent_low_fps.unwrap().is_finite());
}
