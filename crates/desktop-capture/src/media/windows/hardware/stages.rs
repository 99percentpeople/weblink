//! CPU wall-clock boundaries; GPU execution is asynchronous and is not timed here.
use crate::media::latency::{Distribution, EncoderStages};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
pub(super) struct Stages {
    pub prepare: Distribution,
    pub context_lock: Distribution,
    pub input: Distribution,
    pub output_wait: Distribution,
    pub event_dispatch: Distribution,
    pub output: Distribution,
    pub delivery: Distribution,
    pub bitrate_update: Distribution,
}

/// Backends record completion observation before publishing the event. The encoder
/// worker records output extraction separately from time awaiting that callback.
pub(in crate::media::windows) struct OutputTiming {
    pub ready: Instant,
    pub started: Instant,
    pub finished: Instant,
}

impl Stages {
    pub fn accepted(&mut self, prepare: Duration, lock: Option<Duration>, input: Duration) {
        self.prepare
            .record(prepare.saturating_sub(lock.unwrap_or_default()));
        if let Some(lock) = lock {
            self.context_lock.record(lock);
        }
        self.input.record(input);
    }

    pub fn completed(&mut self, accepted: Instant, timing: &OutputTiming) {
        // A driver can signal output before ProcessInput returns. Do not count
        // that overlap twice, or panic when the callback precedes acceptance.
        let ready = timing.ready.max(accepted);
        self.output_wait.record(ready.duration_since(accepted));
        self.event_dispatch
            .record(timing.started.saturating_duration_since(ready));
        self.output
            .record(timing.finished.duration_since(timing.started));
    }

    pub fn snapshot(&self) -> EncoderStages {
        EncoderStages {
            prepare: self.prepare.measurement(),
            context_lock: self.context_lock.measurement(),
            input: self.input.measurement(),
            output_wait: self.output_wait.measurement(),
            event_dispatch: self.event_dispatch.measurement(),
            output: self.output.measurement(),
            delivery: self.delivery.measurement(),
            bitrate_update: self.bitrate_update.measurement(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn driver_wait_and_worker_delay_are_distinct_and_additive() {
        let at = Instant::now();
        let ms = Duration::from_millis;
        let mut stages = Stages::default();
        stages.accepted(ms(7), Some(ms(3)), ms(2));
        stages.completed(
            at + ms(9),
            &OutputTiming {
                ready: at + ms(19),
                started: at + ms(49),
                finished: at + ms(54),
            },
        );
        let report = stages.snapshot();
        assert_eq!(report.prepare.latency.mean_ms, 4.0);
        assert_eq!(report.context_lock.latency.mean_ms, 3.0);
        assert_eq!(report.input.latency.mean_ms, 2.0);
        assert_eq!(report.output_wait.latency.mean_ms, 10.0);
        assert_eq!(report.event_dispatch.latency.mean_ms, 30.0);
        assert_eq!(report.output.latency.mean_ms, 5.0);
        assert_eq!(report.delivery.samples, 0);
    }

    #[test]
    fn callback_during_input_does_not_double_count_time() {
        let at = Instant::now();
        let mut stages = Stages::default();
        stages.completed(
            at + Duration::from_millis(5),
            &OutputTiming {
                ready: at,
                started: at + Duration::from_millis(8),
                finished: at + Duration::from_millis(9),
            },
        );
        assert_eq!(stages.output_wait.snapshot().max_ms, 0.0);
        assert_eq!(stages.event_dispatch.snapshot().max_ms, 3.0);
    }
}
