//! A frame-rate limit is consumed by submitted frames, never by worker wakeups.
use std::time::{Duration, Instant};

pub(super) struct CaptureCadence {
    interval: Duration,
    deadline: Instant,
}

impl CaptureCadence {
    pub fn new(interval: Duration, now: Instant) -> Self {
        Self {
            interval,
            deadline: now,
        }
    }

    pub fn reset(&mut self, interval: Duration, now: Instant) {
        self.interval = interval;
        self.deadline = now;
    }

    pub fn set_interval(&mut self, interval: Duration, now: Instant) {
        if interval != self.interval {
            self.reset(interval, now);
        }
    }

    pub fn ready(&self, now: Instant) -> bool {
        now >= self.deadline
    }

    pub fn remaining(&self, now: Instant) -> Duration {
        self.deadline.saturating_duration_since(now)
    }

    pub fn complete(&mut self, submitted_at: Option<Instant>) {
        let Some(now) = submitted_at else { return };
        // Preserve the cap's phase after a small delay, but never accumulate
        // catch-up frames while idle or blocked on a full GPU readback queue.
        if now >= self.deadline + self.interval {
            self.deadline = now;
        }
        self.deadline += self.interval;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
