//! Filter encoder reconfiguration, never the transport's congestion control.
use std::time::Duration;

const START_BITRATE: u32 = 300_000;
const QUANTUM: u32 = 16_000;
const INCREASE_INTERVAL: Duration = Duration::from_millis(200);

pub(super) struct BitrateController {
    limit: u32,
    target: u32,
    applied: u32,
    changed: Duration,
}
impl BitrateController {
    pub fn new(limit: u32) -> Self {
        Self::with_start(limit, START_BITRATE)
    }
    pub fn with_start(limit: u32, start: u32) -> Self {
        let applied = Self::quantize(limit.min(start));
        Self {
            limit,
            target: applied,
            applied,
            changed: Duration::ZERO,
        }
    }
    fn quantize(bitrate: u32) -> u32 {
        if bitrate < QUANTUM {
            bitrate
        } else {
            bitrate / QUANTUM * QUANTUM
        }
    }
    pub fn current(&self) -> u32 {
        self.applied
    }
    /// Schedule only a pending upward update; media events wake other work.
    pub fn next_update_in(&self, now: Duration) -> Option<Duration> {
        (self.target > self.applied
            && self.target - self.applied >= (self.applied / 10).max(QUANTUM))
        .then(|| INCREASE_INTERVAL.saturating_sub(now.saturating_sub(self.changed)))
    }
    pub fn set_limit(&mut self, limit: u32) {
        self.limit = limit;
        // Raising a user ceiling is not evidence of more network capacity.
        // Keep feedback-driven recovery and apply reductions on the next poll.
        self.target = Self::quantize(self.target.min(limit));
    }
    pub fn observe(&mut self, bitrate: u64) {
        // libwebrtc owns sender suspension; MF requires a positive bitrate.
        // The pass-through currently forwards feedback only with an encoded frame.
        if bitrate > 0 {
            self.target = Self::quantize(bitrate.min(u64::from(self.limit)) as u32);
        }
    }
    pub fn poll(&mut self, now: Duration) -> Option<u32> {
        let next = if self.target < self.applied {
            // A falling budget must not be averaged with old, higher estimates:
            // doing that would fill the pacer and turn congestion into latency.
            self.target
        } else {
            // Small upward estimates buy little quality but can oscillate with
            // the next reduction. Recover meaningful increases in bounded steps.
            if self.target - self.applied < (self.applied / 10).max(QUANTUM)
                || now.saturating_sub(self.changed) < INCREASE_INTERVAL
            {
                return None;
            }
            let step = (self.applied / 2).max(QUANTUM);
            Self::quantize(self.applied.saturating_add(step).min(self.target))
        };
        if next == self.applied {
            return None;
        }
        self.applied = next;
        self.changed = now;
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rate_updates_have_a_deadline_without_polling_idle_encoders() {
        let mut rate = BitrateController::new(4_000_000);
        assert_eq!(rate.next_update_in(Duration::ZERO), None);
        rate.observe(2_000_000);
        assert_eq!(
            rate.next_update_in(Duration::from_millis(150)),
            Some(Duration::from_millis(50))
        );
        rate.poll(Duration::from_millis(200));
        assert_eq!(
            rate.next_update_in(Duration::from_millis(201)),
            Some(Duration::from_millis(199))
        );
        rate.observe(128_000);
        rate.poll(Duration::from_millis(202));
        assert_eq!(rate.next_update_in(Duration::from_millis(203)), None);
    }
    #[test]
    fn catches_up_with_confirmed_bandwidth_without_waiting_several_seconds() {
        let mut rate = BitrateController::new(8_000_000);
        rate.observe(4_000_000);
        for ms in (200..=1600).step_by(200) {
            rate.poll(Duration::from_millis(ms));
            assert!(rate.current() <= 4_000_000);
        }
        assert!(rate.current() >= 3_600_000);
        rate.observe(200_000);
        assert_eq!(rate.poll(Duration::from_millis(1601)), Some(192_000));
    }
    #[test]
    fn local_preview_can_start_at_its_budget_but_still_obeys_feedback_and_live_limits() {
        let mut rate = BitrateController::with_start(8_000_000, 8_000_000);
        assert_eq!(rate.current(), 8_000_000);
        rate.observe(1_000_000);
        assert_eq!(rate.poll(Duration::ZERO), Some(992_000));
        rate.set_limit(128_000);
        assert_eq!(rate.poll(Duration::ZERO), Some(128_000));
    }
    #[test]
    fn live_limit_cuts_immediately_but_increases_wait_for_transport_feedback() {
        let mut rate = BitrateController::new(4_000_000);
        rate.observe(2_000_000);
        rate.set_limit(128_000);
        assert_eq!(rate.poll(Duration::ZERO), Some(128_000));
        rate.set_limit(4_000_000);
        assert_eq!(rate.poll(Duration::from_secs(1)), None);
        rate.observe(2_000_000);
        assert_eq!(rate.poll(Duration::from_secs(1)), Some(192_000));
    }
    #[test]
    fn starts_conservatively_and_never_exceeds_the_current_budget_or_user_limit() {
        let mut rate = BitrateController::new(4_000_000);
        assert!(rate.current() <= START_BITRATE);
        rate.observe(u64::MAX);
        for ms in (0..10_000).step_by(10) {
            rate.poll(Duration::from_millis(ms));
            assert!(rate.current() <= 4_000_000);
        }
        assert!(rate.current() >= 3_600_000);
        assert_eq!(BitrateController::new(128_000).current(), 128_000);
    }
    #[test]
    fn cuts_immediately_and_recovers_without_large_bitrate_jumps() {
        let mut rate = BitrateController::new(4_000_000);
        rate.observe(2_000_000);
        for ms in (500..=5_000).step_by(500) {
            rate.poll(Duration::from_millis(ms));
        }
        rate.observe(97_000);
        assert_eq!(rate.poll(Duration::from_millis(5_010)), Some(96_000));
        rate.observe(4_000_000);
        assert_eq!(rate.poll(Duration::from_millis(5_020)), None);
        let recovered = rate.poll(Duration::from_millis(5_510)).unwrap();
        assert!(recovered > 96_000 && recovered <= 144_000);
    }
    #[test]
    fn suppresses_small_estimate_fluctuations_and_keeps_tiny_positive_budgets() {
        let mut rate = BitrateController::new(2_000_000);
        rate.observe(200_000);
        assert_eq!(rate.poll(Duration::ZERO), Some(192_000));
        let mut writes = 0;
        for ms in (0..4_000).step_by(20) {
            rate.observe(if ms % 40 == 0 { 198_000 } else { 202_000 });
            writes += usize::from(rate.poll(Duration::from_millis(ms)).is_some());
        }
        assert_eq!(writes, 0);
        rate.observe(10_000);
        assert_eq!(rate.poll(Duration::from_secs(4)), Some(10_000));
    }
}
