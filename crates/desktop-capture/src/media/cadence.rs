//! A frame-rate limit is consumed by submitted frames, never by worker wakeups.
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub(super) struct CaptureCadence {
    interval: Duration,
    deadline: Instant,
    // Earliest source arrival eligible for the next slot before its deadline.
    earliest_arrival: Option<Instant>,
}

impl CaptureCadence {
    pub fn new(interval: Duration, now: Instant) -> Self {
        Self {
            interval,
            deadline: now,
            earliest_arrival: None,
        }
    }

    pub fn reset(&mut self, interval: Duration, now: Instant) {
        *self = Self::new(interval, now);
    }

    pub fn set_interval(&mut self, interval: Duration, now: Instant) {
        if interval != self.interval {
            self.reset(interval, now);
        }
    }

    fn ready(&self, now: Instant) -> bool {
        now >= self.deadline
    }

    pub fn admitted_interval(&self, arrived_at: Option<Instant>, now: Instant) -> Option<Duration> {
        // Only a new arrival can borrow. Waking again for the same pending frame
        // leaves room for a newer one until the regular deadline flushes it.
        (self.ready(now)
            || arrived_at
                .zip(self.earliest_arrival)
                .is_some_and(|(at, earliest)| at >= earliest))
        .then_some(self.interval)
    }

    fn covered_by(&self, capture_interval: Option<Duration>) -> bool {
        capture_interval.is_some_and(|interval| interval >= self.interval)
    }

    pub fn remaining(&self, now: Instant) -> Duration {
        self.deadline.saturating_duration_since(now)
    }

    pub fn input_wait(&self, capture_interval: Option<Duration>, now: Instant) -> Duration {
        if self.covered_by(capture_interval) {
            Duration::ZERO
        } else {
            self.remaining(now)
        }
    }

    pub fn complete_input(&mut self, at: Instant, capture_interval: Option<Duration>) {
        if self.covered_by(capture_interval) {
            // If the source later speeds up, limit from the last accepted input.
            self.deadline = at + self.interval;
            self.earliest_arrival = None;
        } else {
            self.complete(Some(at));
        }
    }

    pub fn complete(&mut self, submitted_at: Option<Instant>) {
        let Some(now) = submitted_at else { return };
        // Preserve the cap's phase after a small delay, but never accumulate
        // catch-up frames while idle or blocked on a full GPU readback queue.
        let stalled = now >= self.deadline + self.interval;
        if stalled {
            self.deadline = now;
        }
        // Anchor to the scheduled slot, even when its pending frame was flushed
        // late. Anchoring every slot to delivery can keep a matching source late.
        let next = self.deadline + self.interval;
        self.earliest_arrival = Some(if stalled || self.earliest_arrival.is_none() {
            // Start without a back-to-back burst after idle or a rate change.
            (now + self.interval / 2).min(next)
        } else {
            self.deadline
        });
        self.deadline = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_tick_covers_only_encoders_at_least_as_fast_as_the_source() {
        let start = Instant::now();
        let at_60 = Duration::from_secs_f64(1.0 / 60.0);
        let at_155 = Duration::from_secs_f64(1.0 / 155.0);
        let mut source = CaptureCadence::new(at_60, start);
        let mut viewer = CaptureCadence::new(at_60, start);
        let first = source.admitted_interval(None, start);
        source.complete(Some(start));
        let late_input = start + Duration::from_millis(9);
        viewer.complete_input(late_input, first);

        let next = start + at_60;
        assert_eq!(source.admitted_interval(None, late_input), None);
        assert!(viewer.remaining(next) > Duration::ZERO);
        let next_admission = source.admitted_interval(None, next);
        assert_eq!(viewer.input_wait(next_admission, next), Duration::ZERO);
        viewer.complete_input(next, next_admission);

        source.set_interval(at_155, next);
        let faster_input = source.admitted_interval(None, next);
        assert_eq!(
            viewer.input_wait(faster_input, next + at_155),
            at_60 - at_155
        );
        assert_eq!(viewer.input_wait(None, next + at_155), at_60 - at_155);
        viewer.complete_input(next + at_60, faster_input);
        assert_eq!(viewer.remaining(next + at_60), at_60);

        viewer.set_interval(at_155, next + at_60);
        viewer.complete_input(next + at_60, faster_input);
        assert_eq!(viewer.input_wait(first, next + at_60), Duration::ZERO);
    }

    #[test]
    fn a_sixty_fps_viewer_limits_a_155_fps_source() {
        let start = Instant::now();
        let interval = Some(Duration::from_secs_f64(1.0 / 155.0));
        let mut viewer = CaptureCadence::new(Duration::from_secs_f64(1.0 / 60.0), start);
        let mut outputs = 0;
        for frame in 0..155 {
            let now = start + Duration::from_secs_f64(f64::from(frame) / 155.0);
            if viewer.input_wait(interval, now).is_zero() {
                viewer.complete_input(now, interval);
                outputs += 1;
            }
        }
        assert_eq!(outputs, 60);
    }

    #[test]
    fn sixty_fps_updates_on_a_155_hz_display_can_follow_the_source() {
        let start = Instant::now();
        let interval = Duration::from_secs_f64(1.0 / 60.0);
        let mut source = CaptureCadence::new(interval, start);
        let mut viewer = CaptureCadence::new(interval, start);
        for frame in 0..600 {
            // Presentation falls on alternating two- or three-refresh gaps.
            let refresh = frame * 155 / 60;
            let arrival = start + Duration::from_secs_f64(f64::from(refresh) / 155.0);
            let admission = source.admitted_interval(Some(arrival), arrival);
            assert_eq!(admission, Some(interval));
            assert_eq!(viewer.input_wait(admission, arrival), Duration::ZERO);
            source.complete(Some(arrival));
            viewer.complete_input(arrival, admission);
        }
    }

    #[test]
    fn borrowing_for_fresh_input_does_not_raise_the_sustained_source_cap() {
        let start = Instant::now();
        let interval = Duration::from_secs_f64(1.0 / 60.0);
        let mut source = CaptureCadence::new(interval, start);
        let mut outputs = 0;
        for frame in 0..1550 {
            let now = start + Duration::from_secs_f64(f64::from(frame) / 155.0);
            if source.admitted_interval(Some(now), now).is_some() {
                outputs += 1;
                source.complete(Some(now));
            }
            let nominal_frames = frame * 60 / 155 + 1;
            assert!(outputs <= nominal_frames + 1);
        }
        assert!((600..=601).contains(&outputs));
    }

    #[test]
    fn flushing_a_pending_frame_does_not_shift_the_next_arrival_window() {
        let start = Instant::now();
        let at = |millis| start + Duration::from_millis(millis);
        let interval = Duration::from_millis(16);
        let mut source = CaptureCadence::new(interval, start);
        source.complete(Some(start));
        assert_eq!(
            source.admitted_interval(Some(at(12)), at(12)),
            Some(interval)
        );
        source.complete(Some(at(12)));
        assert_eq!(source.admitted_interval(Some(at(14)), at(30)), None);
        assert_eq!(
            source.admitted_interval(Some(at(14)), at(33)),
            Some(interval)
        );
        source.complete(Some(at(33)));
        assert_eq!(
            source.admitted_interval(Some(at(35)), at(35)),
            Some(interval)
        );
        source.complete(Some(at(35)));
        assert_eq!(source.admitted_interval(Some(at(36)), at(36)), None);
    }

    #[test]
    fn repeats_and_empty_wakes_do_not_borrow_a_fresh_frame_slot() {
        let start = Instant::now();
        let interval = Duration::from_millis(16);
        let mut source = CaptureCadence::new(interval, start);
        source.complete(Some(start));
        let early = start + Duration::from_millis(12);
        assert_eq!(source.admitted_interval(None, early), None);
        assert_eq!(source.admitted_interval(Some(early), early), Some(interval));
        source.complete(None);
        assert_eq!(source.admitted_interval(Some(early), early), Some(interval));
        source.complete(Some(early));
        assert_eq!(source.remaining(early), interval * 2 - (early - start));
        let resumed = start + Duration::from_secs(3);
        source.complete(Some(resumed));
        let too_soon = resumed + interval / 4;
        let next_arrival = resumed + interval / 2;
        assert_eq!(source.admitted_interval(Some(too_soon), next_arrival), None);
        assert_eq!(source.admitted_interval(None, next_arrival), None);
        assert_eq!(
            source.admitted_interval(Some(next_arrival), next_arrival),
            Some(interval)
        );
        // If the desktop goes static, flush even this too-early last update.
        assert_eq!(
            source.admitted_interval(Some(too_soon), resumed + interval),
            Some(interval)
        );
        source.set_interval(interval * 2, resumed);
        assert_eq!(source.admitted_interval(None, resumed), Some(interval * 2));
    }

    #[test]
    fn idle_gpu_wakeups_do_not_delay_the_next_source_frame() {
        let start = Instant::now();
        let interval = Duration::from_millis(10);
        let mut cadence = CaptureCadence::new(interval, start);
        // The worker starts before the first capture callback.
        cadence.complete(None);
        assert!(cadence.ready(start + Duration::from_millis(1)));
        cadence.complete(Some(start + Duration::from_millis(1)));
        // The copy completes after the deadline without another source frame.
        assert!(cadence.ready(start + Duration::from_millis(12)));
        cadence.complete(None);
        // Previously that empty wake advanced the deadline to 20 ms.
        assert!(cadence.ready(start + Duration::from_millis(16)));
        cadence.complete(Some(start + Duration::from_millis(16)));
        assert!(!cadence.ready(start + Duration::from_millis(19)));
        assert!(cadence.ready(start + Duration::from_millis(20)));
    }

    #[test]
    fn full_readback_queue_does_not_spend_an_admission_slot() {
        let start = Instant::now();
        let mut cadence = CaptureCadence::new(Duration::from_millis(10), start);
        cadence.complete(Some(start));
        for millis in 10..15 {
            assert!(cadence.ready(start + Duration::from_millis(millis)));
            cadence.complete(None);
        }
        cadence.complete(Some(start + Duration::from_millis(15)));
        assert_eq!(
            cadence.remaining(start + Duration::from_millis(15)),
            Duration::from_millis(5)
        );
    }

    #[test]
    fn long_stalls_do_not_create_a_catch_up_burst() {
        let start = Instant::now();
        let interval = Duration::from_millis(10);
        let mut cadence = CaptureCadence::new(interval, start);
        cadence.complete(Some(start));
        let resumed = start + Duration::from_secs(1);
        cadence.complete(Some(resumed));
        assert_eq!(cadence.remaining(resumed), interval);
        assert!(!cadence.ready(resumed));
    }

    #[test]
    fn setting_changes_and_consumer_resume_reset_the_cap() {
        let start = Instant::now();
        let interval = Duration::from_millis(10);
        let mut cadence = CaptureCadence::new(interval, start);
        cadence.complete(Some(start));
        let now = start + Duration::from_millis(2);
        cadence.set_interval(interval, now);
        assert!(!cadence.ready(now));
        cadence.set_interval(Duration::from_millis(5), now);
        assert!(cadence.ready(now));
        cadence.complete(Some(now));
        cadence.reset(interval, now);
        assert!(cadence.ready(now));
    }
}
