//! Map OS capture timestamps to the application's monotonic clock.
use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};

fn frequency() -> Option<i64> {
    static FREQUENCY: OnceLock<Option<i64>> = OnceLock::new();
    *FREQUENCY.get_or_init(|| {
        let mut value = 0;
        unsafe { QueryPerformanceFrequency(&mut value) }.ok()?;
        (value > 0).then_some(value)
    })
}

fn nanos(ticks: i64, frequency: i64) -> Option<i128> {
    (ticks > 0 && frequency > 0).then(|| i128::from(ticks) * 1_000_000_000 / i128::from(frequency))
}

fn anchor(captured_ns: i128, now_ns: i128, before: Instant, after: Instant) -> Option<Instant> {
    let elapsed = after.checked_duration_since(before)?;
    if elapsed > Duration::from_millis(2) {
        return None;
    }
    let age = u64::try_from(now_ns.checked_sub(captured_ns)?).ok()?;
    before
        .checked_add(elapsed / 2)?
        .checked_sub(Duration::from_nanos(age))
}

fn map(captured_ns: i128) -> Option<Instant> {
    let frequency = frequency()?;
    // Retry a preempted read; the OS timestamp remains attached to this frame.
    for _ in 0..3 {
        let before = Instant::now();
        let mut counter = 0;
        unsafe { QueryPerformanceCounter(&mut counter) }.ok()?;
        let after = Instant::now();
        if let Some(at) = anchor(captured_ns, nanos(counter, frequency)?, before, after) {
            return Some(at);
        }
    }
    None
}

/// DXGI LastPresentTime / LastMouseUpdateTime use raw QPC ticks.
pub(super) fn qpc(ticks: i64) -> Option<Instant> {
    map(nanos(ticks, frequency()?)?)
}

/// WGC SystemRelativeTime expresses QPC time in 100 ns units.
pub(super) fn system_relative(ticks: i64) -> Option<Instant> {
    map(nanos(ticks, 10_000_000)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qpc_and_wgc_units_preserve_capture_age() {
        let before = Instant::now();
        let after = before + Duration::from_micros(200);
        // A non-10 MHz QPC frequency exercises both OS timestamp units.
        let capture = nanos(21_600_000, 24_000_000).unwrap();
        assert_eq!(capture, nanos(9_000_000, 10_000_000).unwrap());
        assert_eq!(
            anchor(capture, 1_000_000_000, before, after),
            before.checked_sub(Duration::from_micros(99_900))
        );
        assert_eq!(nanos(0, 10_000_000), None);
        assert_eq!(nanos(-1, 10_000_000), None);
        assert_eq!(
            nanos(i64::MAX, 1),
            Some(i128::from(i64::MAX) * 1_000_000_000)
        );
    }

    #[test]
    fn rejects_future_timestamps_and_preempted_clock_reads() {
        let now = Instant::now();
        assert_eq!(anchor(101, 100, now, now), None);
        assert_eq!(anchor(0, 100, now, now + Duration::from_millis(3)), None);
        assert_eq!(anchor(0, 100, now + Duration::from_millis(1), now), None);
    }

    #[test]
    fn maps_the_real_qpc_clock() {
        let mut counter = 0;
        unsafe { QueryPerformanceCounter(&mut counter) }.unwrap();
        let at = qpc(counter).unwrap();
        assert!(at.elapsed() < Duration::from_secs(1));
    }
}
