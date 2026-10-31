//! Bounded recent distributions; samples never retain frame data.
use serde_json::{json, Value};
use std::collections::VecDeque;

#[derive(Default)]
pub(super) struct Timing {
    samples: VecDeque<f64>,
    count: u64,
    total: f64,
    max: f64,
}
impl Timing {
    pub fn record(&mut self, ms: f64) {
        if !ms.is_finite() || ms < 0.0 {
            return;
        }
        self.count += 1;
        self.total += ms;
        self.max = self.max.max(ms);
        if self.samples.len() == 256 {
            self.samples.pop_front();
        }
        self.samples.push_back(ms);
    }
    pub fn snapshot(&self) -> Value {
        let mut values: Vec<_> = self.samples.iter().copied().collect();
        values.sort_by(f64::total_cmp);
        let percentile = |fraction: f64| {
            values
                .get(((values.len() as f64 * fraction).ceil() as usize).saturating_sub(1))
                .copied()
        };
        json!({"count":self.count,"totalMs":self.total,"maxMs":self.max,
            "windowCount":values.len(),"p50Ms":percentile(0.5),"p95Ms":percentile(0.95)})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recent_window_is_bounded_and_bad_samples_do_not_poison_counters() {
        let mut timing = Timing::default();
        for value in [f64::NAN, f64::INFINITY, -1.0] {
            timing.record(value);
        }
        for value in 1..=300 {
            timing.record(f64::from(value));
        }
        let report = timing.snapshot();
        assert_eq!(report["count"], 300);
        assert_eq!(report["windowCount"], 256);
        assert_eq!(report["totalMs"], 45150.0);
        assert_eq!(report["p50Ms"], 172.0);
        assert_eq!(report["p95Ms"], 288.0);
        assert!(Timing::default().snapshot()["p95Ms"].is_null());
    }
}
