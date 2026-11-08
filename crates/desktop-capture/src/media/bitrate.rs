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
    /// None means paused until new transport feedback arrives.
    pub fn next_input_in(&mut self, now: Duration) -> Option<Duration> {
        self.refill(now);
        if self.bitrate == 0 {
            None
        } else if self.credit_bits >= 0.0 {
            Some(Duration::ZERO)
        } else {
            let seconds = -self.credit_bits / f64::from(self.bitrate);
            Some(Duration::from_secs_f64(seconds).max(Duration::from_nanos(1)))
        }
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

/// Coalesce control writes independently of raw-frame admission on every backend.
/// Transport reductions still reach FrameBudget immediately. A delayed driver
/// write can reduce quality/fps temporarily, but cannot grant extra bandwidth.
pub(super) struct DriverBitrateUpdates {
    confirmed: u32,
    finished: Duration,
    cost: Duration,
    failed: bool,
    last_output: Option<Duration>,
    output_gap: Option<Duration>,
    debt_pressure: bool,
}
impl DriverBitrateUpdates {
    const MIN_INTERVAL: Duration = Duration::from_millis(50);
    const MAX_INTERVAL: Duration = Duration::from_secs(3);
    const SETTLE_INTERVAL: Duration = Duration::from_secs(5);

    pub fn new(confirmed: u32, now: Duration) -> Self {
        Self {
            confirmed,
            finished: now,
            cost: Duration::ZERO,
            failed: false,
            last_output: None,
            output_gap: None,
            debt_pressure: false,
        }
    }

    /// Only completed output counts. Static capture without queued work must not
    /// be mistaken for a stalled encoder. Returns the observed delivery interval.
    pub fn output(&mut self, now: Duration) -> Option<Duration> {
        self.last_output
            .replace(now)
            .map(|previous| now.saturating_sub(previous))
    }

    pub fn pressure(
        &mut self,
        target: u32,
        debt_wait: Duration,
        frame_interval: Duration,
        busy: bool,
    ) {
        let cut = target > 0
            && target < self.confirmed
            && u64::from(self.confirmed - target) * 10 >= u64::from(self.confirmed);
        // Latch debt pressure until the cut is applied/cancelled, so refilling
        // credit during the cooldown cannot repeatedly postpone the driver cut.
        self.debt_pressure = cut && busy && (self.debt_pressure || debt_wait >= frame_interval);
        self.output_gap = (cut && busy)
            .then(|| {
                self.last_output
                    .map(|at| at + frame_interval.saturating_mul(2))
            })
            .flatten();
    }

    pub fn next_update_in(&self, target: u32, now: Duration) -> Option<Duration> {
        // Zero pauses admission; never pass it to a hardware rate-control API.
        if target == 0 || target == self.confirmed {
            return None;
        }
        // Compare to the confirmed rate, not the previous feedback sample.
        let significant =
            u64::from(target.abs_diff(self.confirmed)) * 10 >= u64::from(self.confirmed);
        let interval = if self.failed {
            Self::SETTLE_INTERVAL
        } else if significant && target < self.confirmed {
            // Cuts repay admission debt sooner; recovery and tiny fluctuations
            // retain the original cost-based coalescing policy.
            self.cost
                .saturating_mul(2)
                .clamp(Self::MIN_INTERVAL, Duration::from_millis(500))
        } else if significant {
            self.cost
                .saturating_mul(10)
                .clamp(Self::MIN_INTERVAL, Self::MAX_INTERVAL)
        } else {
            self.cost
                .saturating_mul(20)
                .clamp(Self::MIN_INTERVAL, Self::SETTLE_INTERVAL)
        };
        let mut due = self.finished + interval;
        if !self.failed && significant && target < self.confirmed {
            let cooldown = self.finished
                + self
                    .cost
                    .clamp(Self::MIN_INTERVAL, Duration::from_millis(250));
            if self.debt_pressure {
                due = due.min(cooldown);
            } else if let Some(gap) = self.output_gap {
                // Wake when the gap becomes significant, even if no more frames
                // arrive. New output moves this deadline forward on the next loop.
                due = due.min(cooldown.max(gap));
            }
        }
        Some(due.saturating_sub(now))
    }

    pub fn completed(&mut self, target: u32, now: Duration, cost: Duration, success: bool) {
        if success {
            self.confirmed = target;
        }
        self.failed = !success;
        self.finished = now;
        self.debt_pressure = false;
        self.output_gap = None;
        // React immediately to expensive calls, then recover as successful calls
        // become cheap. A single fast call cannot erase a recent driver stall.
        self.cost = cost.max(self.cost / 2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cheap_driver_small_changes_use_short_window_and_latest_target() {
        let mut writes = DriverBitrateUpdates::new(8_000_000, Duration::ZERO);
        assert_eq!(
            writes.next_update_in(7_984_000, Duration::from_millis(20)),
            Some(Duration::from_millis(30))
        );
        assert_eq!(
            writes.next_update_in(8_016_000, Duration::from_millis(50)),
            Some(Duration::ZERO)
        );
        writes.completed(
            8_016_000,
            Duration::from_millis(51),
            Duration::from_micros(40),
            true,
        );
        assert_eq!(
            writes.next_update_in(8_016_000, Duration::from_secs(1)),
            None
        );
        assert_eq!(
            writes.next_update_in(8_000_000, Duration::from_millis(52)),
            Some(Duration::from_millis(49))
        );
        assert_eq!(
            writes.next_update_in(4_000_000, Duration::from_millis(101)),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn expensive_driver_coalesces_small_changes_without_resetting_deadline() {
        let mut writes = DriverBitrateUpdates::new(8_000_000, Duration::ZERO);
        writes.completed(8_000_000, Duration::ZERO, Duration::from_millis(300), true);
        for ms in (100..5_000).step_by(100) {
            let target = if ms % 200 == 0 { 7_984_000 } else { 8_016_000 };
            assert_eq!(
                writes.next_update_in(target, Duration::from_millis(ms)),
                Some(Duration::from_millis(5_000 - ms))
            );
        }
        assert_eq!(
            writes.next_update_in(7_984_000, Duration::from_secs(5)),
            Some(Duration::ZERO)
        );
        assert_eq!(
            writes.next_update_in(16_000_000, Duration::from_secs(3)),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn adaptive_interval_recovers_from_spikes_and_reopen_resets_cost() {
        let mut writes = DriverBitrateUpdates::new(8_000_000, Duration::ZERO);
        writes.completed(8_000_000, Duration::ZERO, Duration::from_secs(1), true);
        assert_eq!(
            writes.next_update_in(16_000_000, Duration::ZERO),
            Some(Duration::from_secs(3))
        );
        for _ in 0..9 {
            writes.completed(8_000_000, Duration::ZERO, Duration::from_micros(40), true);
        }
        assert_eq!(
            writes.next_update_in(8_016_000, Duration::ZERO),
            Some(Duration::from_millis(50))
        );
        let reopened = DriverBitrateUpdates::new(10_000, Duration::ZERO);
        assert_eq!(
            reopened.next_update_in(10_001, Duration::from_millis(50)),
            Some(Duration::ZERO)
        );
        assert_eq!(
            DriverBitrateUpdates::new(u32::MAX, Duration::ZERO)
                .next_update_in(1, Duration::from_secs(1)),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn deferred_driver_cut_does_not_defer_admission_budget_or_pause() {
        let mut writes = DriverBitrateUpdates::new(8_000_000, Duration::ZERO);
        writes.completed(8_000_000, Duration::ZERO, Duration::from_millis(200), true);
        let mut rate = BitrateController::with_start(8_000_000, 8_000_000);
        let mut budget = FrameBudget::new(rate.current());
        budget.record_output(100_000, Duration::ZERO);
        rate.observe(1_000_000);
        let now = Duration::from_millis(1);
        budget.set_bitrate(rate.poll(now).unwrap(), now);
        assert!(budget.next_input_in(now).unwrap() > Duration::from_millis(300));
        writes.pressure(
            rate.current(),
            budget.next_input_in(now).unwrap(),
            Duration::from_millis(16),
            true,
        );
        assert_eq!(
            writes.next_update_in(rate.current(), now),
            Some(Duration::from_millis(199))
        );
        rate.observe(0);
        budget.set_bitrate(rate.poll(now).unwrap(), now);
        assert_eq!(budget.next_input_in(Duration::from_secs(30)), None);
        assert_eq!(writes.next_update_in(0, Duration::from_secs(30)), None);
        rate.observe(8_000_000);
        budget.set_bitrate(
            rate.poll(Duration::from_secs(30)).unwrap(),
            Duration::from_secs(30),
        );
        assert_eq!(rate.current(), 8_000_000);
        assert_eq!(
            writes.next_update_in(rate.current(), Duration::from_secs(30)),
            None
        );
    }

    #[test]
    fn failed_driver_write_retries_slowly_without_claiming_success() {
        let mut writes = DriverBitrateUpdates::new(8_000_000, Duration::ZERO);
        writes.completed(
            2_000_000,
            Duration::from_secs(1),
            Duration::from_micros(40),
            false,
        );
        writes.pressure(
            1_000_000,
            Duration::from_secs(2),
            Duration::from_millis(16),
            true,
        );
        assert_eq!(
            writes.next_update_in(8_000_000, Duration::from_secs(2)),
            None
        );
        assert_eq!(
            writes.next_update_in(1_000_000, Duration::from_secs(2)),
            Some(Duration::from_secs(4))
        );
        assert_eq!(
            writes.next_update_in(2_000_000, Duration::from_secs(6)),
            Some(Duration::ZERO)
        );
        writes.completed(2_000_000, Duration::from_secs(6), Duration::ZERO, true);
        assert_eq!(
            writes.next_update_in(2_000_000, Duration::from_secs(7)),
            None
        );
    }

    #[test]
    fn slow_driver_cuts_accelerate_without_spending_or_forgiving_budget() {
        let ms = Duration::from_millis;
        let mut writes = DriverBitrateUpdates::new(8_000_000, Duration::ZERO);
        writes.completed(8_000_000, Duration::ZERO, ms(300), true);
        // A cut has a shorter bound even before pressure is observed.
        assert_eq!(writes.next_update_in(4_000_000, ms(100)), Some(ms(400)));
        writes.pressure(4_000_000, ms(100), ms(16), true);
        assert_eq!(writes.next_update_in(4_000_000, ms(100)), Some(ms(150)));
        // Refilling debt and a newer downward target must not reset the deadline.
        writes.pressure(3_000_000, Duration::ZERO, ms(16), true);
        assert_eq!(
            writes.next_update_in(3_000_000, ms(250)),
            Some(Duration::ZERO)
        );
        // A rebound cancels the expedited cut; small changes and rises stay coalesced.
        writes.pressure(7_984_000, ms(100), ms(16), true);
        assert_eq!(writes.next_update_in(7_984_000, ms(250)), Some(ms(4750)));
        assert_eq!(writes.next_update_in(16_000_000, ms(250)), Some(ms(2750)));
        assert_eq!(writes.next_update_in(0, ms(250)), None);
        writes.completed(4_000_000, ms(300), ms(40), true);
        assert_eq!(writes.next_update_in(4_000_000, ms(301)), None);
        assert_eq!(writes.next_update_in(2_000_000, ms(301)), Some(ms(299)));
    }

    #[test]
    fn output_gap_deadline_wakes_for_pending_work_but_not_idle_capture() {
        let ms = Duration::from_millis;
        let mut writes = DriverBitrateUpdates::new(8_000_000, Duration::ZERO);
        writes.completed(8_000_000, Duration::ZERO, ms(100), true);
        assert_eq!(writes.output(ms(80)), None);
        writes.pressure(4_000_000, Duration::ZERO, ms(16), true);
        // Cooldown ends at 100, but two frame intervals do not elapse until 112.
        assert_eq!(writes.next_update_in(4_000_000, ms(90)), Some(ms(22)));
        assert_eq!(
            writes.next_update_in(4_000_000, ms(112)),
            Some(Duration::ZERO)
        );
        assert_eq!(writes.output(ms(110)), Some(ms(30)));
        writes.pressure(4_000_000, Duration::ZERO, ms(16), true);
        assert_eq!(writes.next_update_in(4_000_000, ms(112)), Some(ms(30)));
        // At 30 fps the tolerated output gap is correspondingly larger.
        writes.pressure(4_000_000, Duration::ZERO, ms(33), true);
        assert_eq!(writes.next_update_in(4_000_000, ms(112)), Some(ms(64)));
        writes.pressure(4_000_000, ms(500), ms(16), false);
        assert_eq!(writes.next_update_in(4_000_000, ms(112)), Some(ms(88)));
        // No output history on a reopened encoder cannot imply a stalled stream.
        let mut reopened = DriverBitrateUpdates::new(8_000_000, Duration::ZERO);
        reopened.completed(8_000_000, Duration::ZERO, ms(100), true);
        reopened.pressure(4_000_000, Duration::ZERO, ms(16), true);
        assert_eq!(reopened.next_update_in(4_000_000, ms(112)), Some(ms(88)));
    }

    #[test]
    fn hardware_overshoot_is_limited_before_encoding_and_recovers() {
        let mut budget = FrameBudget::new(8_000_000);
        let mut encoded = 0;
        for ms in (0..2_000).step_by(10) {
            let now = Duration::from_millis(ms);
            if budget.next_input_in(now) == Some(Duration::ZERO) {
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
            if budget.next_input_in(now) == Some(Duration::ZERO) {
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
        assert_eq!(
            budget.next_input_in(Duration::from_millis(399)),
            Some(Duration::from_millis(1))
        );
        assert_eq!(
            budget.next_input_in(Duration::from_millis(400)),
            Some(Duration::ZERO)
        );
        assert_eq!(
            budget.next_input_in(Duration::from_secs(60)),
            Some(Duration::ZERO)
        );
        budget.record_output(10_000, Duration::from_secs(60));
        assert_eq!(
            budget.next_input_in(Duration::from_secs(60)),
            Some(Duration::from_millis(30))
        );
        budget.set_bitrate(8_000_000, Duration::from_secs(60));
        assert_eq!(
            budget.next_input_in(Duration::from_secs(60)),
            Some(Duration::from_micros(3750))
        );
        assert_eq!(
            budget.next_input_in(Duration::from_millis(60_004)),
            Some(Duration::ZERO)
        );
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
        assert_eq!(budget.next_input_in(Duration::from_secs(30)), None);
        assert_eq!(rate.next_update_in(Duration::from_secs(30)), None);
        rate.observe(100_000_000);
        let resumed = rate.poll(Duration::from_secs(30)).unwrap();
        assert_eq!(resumed, 100_000_000);
        budget.set_bitrate(resumed, Duration::from_secs(30));
        assert_eq!(
            budget.next_input_in(Duration::from_secs(30)),
            Some(Duration::ZERO)
        );
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
