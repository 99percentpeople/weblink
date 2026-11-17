use std::time::{Duration, Instant};

/// Anchor WebRTC's receiver-clock capture estimate to the compositor clock.
pub(super) fn capture_instant(
    capture_us: Option<i64>,
    now_us: i64,
    before: Instant,
    after: Instant,
) -> Option<Instant> {
    // The native clock is read between these Instants, not necessarily at
    // `before`. A preempted call must not shift capture backwards by the whole
    // scheduling gap. Bound this bridge's uncertainty to at most one ms.
    let read_time = after.checked_duration_since(before)?;
    if read_time > Duration::from_millis(2) {
        return None;
    }
    let now = before.checked_add(read_time / 2)?;
    let capture_us = capture_us.filter(|value| *value >= 0)?;
    let age_us = now_us.checked_sub(capture_us)?;
    now.checked_sub(Duration::from_micros(u64::try_from(age_us).ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_capture_age_without_subtracting_sender_and_receiver_clocks() {
        let now = Instant::now();
        assert_eq!(
            capture_instant(Some(900_000), 1_000_000, now, now),
            now.checked_sub(Duration::from_millis(100))
        );
        assert_eq!(
            capture_instant(Some(1_000_000), 1_000_000, now, now),
            Some(now)
        );
        assert_eq!(capture_instant(None, 1_000_000, now, now), None);
        assert_eq!(capture_instant(Some(-1), 1_000_000, now, now), None);
        assert_eq!(capture_instant(Some(1_000_001), 1_000_000, now, now), None);
        assert_eq!(capture_instant(Some(i64::MAX), i64::MIN, now, now), None);
    }

    #[test]
    fn brackets_the_clock_read_and_rejects_scheduler_stalls() {
        let before = Instant::now();
        let after = before + Duration::from_millis(2);
        assert_eq!(
            capture_instant(Some(900_000), 1_000_000, before, after),
            before.checked_sub(Duration::from_millis(99)),
        );
        assert_eq!(
            capture_instant(
                Some(900_000),
                1_000_000,
                before,
                after + Duration::from_micros(1)
            ),
            None,
        );
        assert_eq!(
            capture_instant(Some(900_000), 1_000_000, after, before),
            None
        );
    }
}
