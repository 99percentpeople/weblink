//! Filter encoder reconfiguration, never the transport's congestion control.
use std::time::Duration;

const START_BITRATE: u32 = 300_000;
const QUANTUM: u32 = 16_000;
// Coalesce driver writes, without adding another bandwidth-recovery ramp.
const UPDATE_INTERVAL: Duration = Duration::from_millis(50);

/// Bounds hardware overshoot by admitting raw inputs, never discarding encoded references.
pub(super) struct FrameBudget {
    bitrate: u32,
    credit_bits: f64,
    updated: Duration,
}
impl FrameBudget {
    // Allow short encoder bursts without banking unlimited credit while idle.
    const BURST_SECONDS: f64 = 0.05;

    pub fn new(bitrate: u32) -> Self {
        Self {
            bitrate,
            credit_bits: f64::from(bitrate) * Self::BURST_SECONDS,
            updated: Duration::ZERO,
        }
    }
    fn refill(&mut self, now: Duration) {
        self.credit_bits = (self.credit_bits
            + now.saturating_sub(self.updated).as_secs_f64() * f64::from(self.bitrate))
        .min(f64::from(self.bitrate) * Self::BURST_SECONDS);
        self.updated = now;
    }
    pub fn set_bitrate(&mut self, bitrate: u32, now: Duration) {
        // Settle elapsed time at the old rate; a cut must not forgive existing debt.
        self.refill(now);
        self.bitrate = bitrate;
        self.credit_bits = self
            .credit_bits
            .min(f64::from(bitrate) * Self::BURST_SECONDS);
    }
    pub fn record_output(&mut self, bytes: usize, now: Duration) {
        self.refill(now);
        self.credit_bits -= bytes as f64 * 8.0;
    }
    pub fn can_encode(&mut self, now: Duration) -> bool {
        self.refill(now);
        self.bitrate > 0 && self.credit_bits >= 0.0
    }
}

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
    /// Schedule a pending upward update; reductions and resume apply immediately.
    pub fn next_update_in(&self, now: Duration) -> Option<Duration> {
        (self.target > self.applied).then(|| {
            if self.applied == 0 {
                Duration::ZERO
            } else {
                UPDATE_INTERVAL.saturating_sub(now.saturating_sub(self.changed))
            }
        })
    }
    pub fn set_limit(&mut self, limit: u32) {
        self.limit = limit;
        // Raising a user ceiling is not evidence of more network capacity.
        // Keep feedback-driven recovery and apply reductions on the next poll.
        self.target = Self::quantize(self.target.min(limit));
    }
    pub fn observe(&mut self, bitrate: u64) {
        // Zero suspends raw input. The worker never writes zero to MF, and
        // independent feedback wakes it again when the sender resumes.
        self.target = Self::quantize(bitrate.min(u64::from(self.limit)) as u32);
    }
    pub fn poll(&mut self, now: Duration) -> Option<u32> {
        let next = if self.target < self.applied {
            // A falling budget must not be averaged with old, higher estimates:
            // doing that would fill the pacer and turn congestion into latency.
            self.target
        } else {
            // WebRTC already controls recovery. Apply its latest allocation in
            // one write once the short coalescing window expires.
            if self.applied > 0 && now.saturating_sub(self.changed) < UPDATE_INTERVAL {
                return None;
            }
            self.target
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
    fn hardware_overshoot_is_limited_before_encoding_and_recovers() {
        let mut budget = FrameBudget::new(8_000_000);
        let mut encoded = 0;
        for ms in (0..2_000).step_by(10) {
            let now = Duration::from_millis(ms);
            if budget.can_encode(now) {
                // Driver produces 16 Mbps despite an 8 Mbps target.
                budget.record_output(20_000, now);
                encoded += 1;
            }
        }
        assert!((100..=103).contains(&encoded));
        // Once output obeys the target, every input is admitted again.
        let mut recovered = 0;
        for ms in (2_100..3_100).step_by(10) {
            let now = Duration::from_millis(ms);
            if budget.can_encode(now) {
                budget.record_output(10_000, now);
                recovered += 1;
            }
        }
        assert_eq!(recovered, 100);
    }
    #[test]
    fn hardware_budget_preserves_debt_across_rate_changes_and_bounds_idle_credit() {
        let mut budget = FrameBudget::new(8_000_000);
        budget.record_output(100_000, Duration::ZERO);
        budget.set_bitrate(1_000_000, Duration::ZERO);
        assert!(!budget.can_encode(Duration::from_millis(399)));
        assert!(budget.can_encode(Duration::from_millis(401)));
        assert!(budget.can_encode(Duration::from_secs(60)));
        budget.record_output(10_000, Duration::from_secs(60));
        assert!(!budget.can_encode(Duration::from_secs(60)));
        budget.set_bitrate(8_000_000, Duration::from_secs(60));
        assert!(!budget.can_encode(Duration::from_secs(60)));
        assert!(budget.can_encode(Duration::from_millis(60_004)));
    }
    #[test]
    fn coalesces_feedback_to_the_latest_target_without_a_second_ramp() {
        let mut rate = BitrateController::new(150_000_000);
        rate.observe(30_000_000);
        assert_eq!(
            rate.next_update_in(Duration::from_millis(20)),
            Some(Duration::from_millis(30))
        );
        assert_eq!(rate.poll(Duration::from_millis(49)), None);
        rate.observe(100_000_000);
        assert_eq!(rate.poll(Duration::from_millis(50)), Some(100_000_000));
        assert_eq!(rate.next_update_in(Duration::from_millis(51)), None);
        assert_eq!(rate.poll(Duration::from_secs(1)), None);
    }
    #[test]
    fn a_cut_cancels_a_pending_increase_without_waiting() {
        let mut rate = BitrateController::with_start(150_000_000, 30_000_000);
        rate.observe(100_000_000);
        assert_eq!(rate.poll(Duration::from_millis(20)), None);
        rate.observe(5_000_000);
        assert_eq!(rate.poll(Duration::from_millis(21)), Some(4_992_000));
        assert_eq!(rate.next_update_in(Duration::from_millis(21)), None);
        assert_eq!(rate.poll(Duration::from_secs(1)), None);
    }
    #[test]
    fn local_preview_obeys_feedback_and_live_limits() {
        let mut rate = BitrateController::with_start(8_000_000, 8_000_000);
        assert_eq!(rate.current(), 8_000_000);
        rate.observe(1_000_000);
        assert_eq!(rate.poll(Duration::ZERO), Some(992_000));
        rate.set_limit(128_000);
        assert_eq!(rate.poll(Duration::ZERO), Some(128_000));
    }
    #[test]
    fn raising_the_user_limit_alone_does_not_invent_bandwidth() {
        let mut rate = BitrateController::new(4_000_000);
        rate.observe(2_000_000);
        rate.set_limit(128_000);
        assert_eq!(rate.poll(Duration::ZERO), Some(128_000));
        rate.set_limit(150_000_000);
        assert_eq!(rate.poll(Duration::from_secs(1)), None);
        rate.observe(u64::MAX);
        assert_eq!(rate.poll(Duration::from_secs(1)), Some(150_000_000));
    }
    #[test]
    fn pause_and_resume_do_not_need_frames_or_a_recovery_timer() {
        let mut rate = BitrateController::new(150_000_000);
        let mut budget = FrameBudget::new(rate.current());
        rate.observe(0);
        let paused = rate.poll(Duration::from_millis(1)).unwrap();
        assert_eq!(paused, 0);
        budget.set_bitrate(paused, Duration::from_millis(1));
        assert!(!budget.can_encode(Duration::from_secs(30)));
        assert_eq!(rate.next_update_in(Duration::from_secs(30)), None);
        rate.observe(100_000_000);
        let resumed = rate.poll(Duration::from_secs(30)).unwrap();
        assert_eq!(resumed, 100_000_000);
        budget.set_bitrate(resumed, Duration::from_secs(30));
        assert!(budget.can_encode(Duration::from_secs(30)));
    }
    #[test]
    fn small_positive_targets_and_small_increases_are_not_lost() {
        let mut rate = BitrateController::new(4_000_000);
        rate.observe(10_000);
        assert_eq!(rate.poll(Duration::ZERO), Some(10_000));
        rate.observe(10_001);
        assert_eq!(rate.poll(Duration::from_millis(49)), None);
        assert_eq!(rate.poll(Duration::from_millis(50)), Some(10_001));
        assert_eq!(BitrateController::new(128_000).current(), 128_000);
    }
}
