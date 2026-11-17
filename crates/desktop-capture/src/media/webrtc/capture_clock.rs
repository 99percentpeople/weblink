//! Bridge application Instants to WebRTC's monotonic capture clock.
use std::time::{Duration, Instant};

pub(crate) struct CaptureClock {
    instant: Instant,
    micros: i64,
}

impl CaptureClock {
    pub fn read() -> Self {
        let sample = || {
            let before = Instant::now();
            let micros = super::clock_us();
            let after = Instant::now();
            let span = after.duration_since(before);
            (
                Self {
                    instant: before + span / 2,
                    micros,
                },
                span,
            )
        };
        let (mut clock, mut span) = sample();
        for _ in 0..2 {
            if span <= Duration::from_millis(2) {
                break;
            }
            let (next, next_span) = sample();
            if next_span < span {
                clock = next;
                span = next_span;
            }
        }
        clock
    }

    pub fn timestamp(&self, at: Instant) -> Option<i64> {
        let offset = if at >= self.instant {
            i128::try_from(at.duration_since(self.instant).as_micros()).ok()?
        } else {
            -i128::try_from(self.instant.duration_since(at).as_micros()).ok()?
        };
        i64::try_from(i128::from(self.micros) + offset)
            .ok()
            .filter(|time| *time >= 0)
    }

    #[cfg(test)]
    pub fn new(instant: Instant, micros: i64) -> Self {
        Self { instant, micros }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_capture_before_clock_sampling_and_across_worker_origins() {
        let now = Instant::now();
        let first = CaptureClock::new(now, 5_000_000);
        let later = CaptureClock::new(now + Duration::from_millis(200), 5_200_000);
        for offset in [0, 50, 300] {
            let captured = now - Duration::from_millis(offset);
            assert_eq!(
                first.timestamp(captured),
                Some(5_000_000 - offset as i64 * 1000)
            );
            assert_eq!(first.timestamp(captured), later.timestamp(captured));
        }
        assert_eq!(first.timestamp(now - Duration::from_secs(6)), None);
        assert_eq!(
            CaptureClock::new(now, i64::MAX).timestamp(now + Duration::from_secs(1)),
            None
        );
    }

    #[test]
    fn maps_live_monotonic_clock_with_sub_millisecond_units() {
        let before = super::super::clock_us();
        let clock = CaptureClock::read();
        let at = Instant::now();
        let after = super::super::clock_us();
        let mapped = clock.timestamp(at).unwrap();
        assert!(mapped >= before - 1000 && mapped <= after + 1000);
    }
}
