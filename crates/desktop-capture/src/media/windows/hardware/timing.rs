//! Keep encoder scheduling delays out of the media timeline.
use std::time::Instant;

pub(super) struct Timeline {
    origin: Instant,
    last: Option<i64>,
}

impl Timeline {
    pub fn new(origin: Instant) -> Self {
        Self { origin, last: None }
    }

    fn relative(&self, at: Instant) -> i64 {
        at.saturating_duration_since(self.origin)
            .as_micros()
            .min(i64::MAX as u128) as i64
    }

    // Compute before submission, commit only when the driver accepts the input.
    // A retried GPU input retains its timestamp even if a surface is unavailable.
    pub fn timestamp(&self, captured: Option<Instant>, ready: Instant) -> i64 {
        let captured = captured.map(|at| self.relative(at));
        let timestamp = captured
            .filter(|value| self.last.is_none_or(|last| *value > last))
            .unwrap_or_else(|| self.relative(ready));
        self.last
            .map_or(timestamp, |last| timestamp.max(last.saturating_add(1)))
    }

    pub fn accepted(&mut self, timestamp: i64) {
        self.last = Some(timestamp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn capture_cadence_survives_variable_processing_delay_and_retries() {
        let origin = Instant::now();
        let mut timeline = Timeline::new(origin);
        for (capture_us, processing_us) in [(8_333, 6_000), (16_666, 1_000), (24_999, 12_000)] {
            let captured = origin + Duration::from_micros(capture_us);
            let ready = captured + Duration::from_micros(processing_us);
            let timestamp = timeline.timestamp(Some(captured), ready);
            assert_eq!(timestamp, capture_us as i64);
            assert_eq!(timeline.timestamp(Some(captured), ready), timestamp);
            timeline.accepted(timestamp);
        }
    }

    #[test]
    fn static_refresh_and_reused_cpu_pixels_advance_without_reusing_capture_time() {
        let origin = Instant::now();
        let mut timeline = Timeline::new(origin);
        let captured = origin + Duration::from_millis(10);
        timeline.accepted(timeline.timestamp(Some(captured), captured));
        let repeated = origin + Duration::from_millis(510);
        assert_eq!(timeline.timestamp(None, repeated), 510_000);
        assert_eq!(timeline.timestamp(Some(captured), repeated), 510_000);
        timeline.accepted(510_000);
        assert_eq!(timeline.timestamp(Some(captured), repeated), 510_001);
    }

    #[test]
    fn independently_started_groups_preserve_the_same_absolute_capture_time() {
        let origin = Instant::now();
        let first = Timeline::new(origin);
        let second = Timeline::new(origin + Duration::from_millis(100));
        let captured = origin + Duration::from_millis(120);
        let ready = captured + Duration::from_millis(4);
        assert_eq!(
            first.timestamp(Some(captured), ready),
            100_000 + second.timestamp(Some(captured), ready)
        );
        // A retained frame can predate a newly created worker. Never pass a
        // negative timestamp to a driver, or panic on a reversed Instant.
        assert_eq!(second.timestamp(Some(origin), ready), 0);
    }
}
