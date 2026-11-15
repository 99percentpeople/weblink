//! Per-view compositor submissions. No polling or driver calls on the frame path.
use serde::Serialize;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

const LOW_WINDOW: Duration = Duration::from_secs(10);
const MAX_INTERVALS: usize = 16_384;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewStats {
    pub presented_frames: u64,
    pub one_percent_low_fps: Option<f64>,
    pub one_percent_low_state: Option<&'static str>,
    pub decoded_queue_ms: f64,
    pub submit_ms: f64,
}

#[derive(Default, Clone)]
pub(super) struct ViewStatistics {
    visible: bool,
    frames: u64,
    last: Option<Instant>,
    intervals: VecDeque<(Instant, Duration)>,
    truncated_at: Option<Instant>,
    decoded_queue_ms: f64,
    submit_ms: f64,
}

impl ViewStatistics {
    pub fn set_visible(&mut self, visible: bool) {
        if self.visible != visible {
            self.intervals.clear();
            self.last = None;
            self.truncated_at = None;
            self.visible = visible;
        }
    }

    pub fn presented(&mut self, at: Instant, queue_ms: f64, submit_ms: f64) {
        // Visibility may have changed while a driver submission was in flight.
        if !self.visible {
            return;
        }
        self.frames += 1;
        self.decoded_queue_ms = queue_ms;
        self.submit_ms = submit_ms;
        if let Some(previous) = self.last {
            match at.checked_duration_since(previous) {
                Some(interval) if !interval.is_zero() => {
                    self.intervals.push_back((at, interval));
                }
                Some(_) => return,
                None => {
                    self.intervals.clear();
                    self.truncated_at = None;
                }
            }
        }
        self.last = Some(at);
        self.expire(at);
        if self.intervals.len() > MAX_INTERVALS {
            self.truncated_at = self.intervals.pop_front().map(|(end, _)| end);
        }
    }

    fn expire(&mut self, at: Instant) {
        while self
            .intervals
            .front()
            .is_some_and(|(end, _)| at.saturating_duration_since(*end) >= LOW_WINDOW)
        {
            self.intervals.pop_front();
        }
        if self
            .truncated_at
            .is_some_and(|end| at.saturating_duration_since(end) >= LOW_WINDOW)
        {
            self.truncated_at = None;
        }
    }

    pub fn snapshot(&mut self, at: Instant) -> ViewStats {
        self.expire(at);
        // Match the browser's reciprocal of the mean slowest 1% of completed
        // presentation intervals, including the first interval crossing cutoff.
        let low = self.visible.then(|| {
            let tail = self.intervals.len().div_ceil(100);
            if tail == 0 {
                return 0.;
            }
            let mut durations: Vec<_> = self.intervals.iter().map(|(_, dt)| *dt).collect();
            durations.sort_unstable_by(|a, b| b.cmp(a));
            let seconds: f64 = durations.iter().take(tail).map(Duration::as_secs_f64).sum();
            tail as f64 / seconds
        });
        ViewStats {
            presented_frames: self.frames,
            one_percent_low_fps: low,
            one_percent_low_state: self.truncated_at.map(|_| "estimated"),
            decoded_queue_ms: self.decoded_queue_ms,
            submit_ms: self.submit_ms,
        }
    }
}

#[cfg(test)]
#[path = "statistics_tests.rs"]
mod tests;
