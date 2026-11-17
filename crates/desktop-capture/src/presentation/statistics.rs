//! Per-view compositor submissions. No polling or driver calls on the frame path.
use serde::Serialize;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

const LOW_WINDOW: Duration = Duration::from_secs(10);
const MAX_INTERVALS: usize = 16_384;
const LATENCY_MAX_AGE: Duration = Duration::from_millis(1500);

/// Receiver monotonic timestamps belonging to one immutable decoded frame.
#[derive(Clone, Copy, Default)]
pub(crate) struct FrameTiming {
    pub captured: Option<Instant>,
    pub received: Option<Instant>,
    pub decoded: Option<Instant>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewStats {
    pub presented_frames: u64,
    pub one_percent_low_fps: Option<f64>,
    pub one_percent_low_state: Option<&'static str>,
    pub decoded_queue_ms: f64,
    pub submit_ms: f64,
    pub end_to_end_ms: Option<f64>,
    pub end_to_end_state: Option<&'static str>,
    pub end_to_end_age_ms: Option<f64>,
    pub timing_age_ms: Option<f64>,
    pub capture_to_receive_ms: Option<f64>,
    pub receive_to_present_ms: Option<f64>,
    pub decode_to_present_ms: Option<f64>,
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
    end_to_end_ms: Option<f64>,
    capture_to_receive_ms: Option<f64>,
    receive_to_present_ms: Option<f64>,
    decode_to_present_ms: Option<f64>,
}

impl ViewStatistics {
    pub fn set_visible(&mut self, visible: bool) {
        if self.visible != visible {
            self.intervals.clear();
            self.last = None;
            self.end_to_end_ms = None;
            self.capture_to_receive_ms = None;
            self.receive_to_present_ms = None;
            self.decode_to_present_ms = None;
            self.truncated_at = None;
            self.visible = visible;
        }
    }

    #[cfg(test)]
    pub fn presented(
        &mut self,
        at: Instant,
        queue_ms: f64,
        submit_ms: f64,
        captured: Option<Instant>,
    ) {
        self.presented_frame(
            at,
            queue_ms,
            submit_ms,
            FrameTiming {
                captured,
                ..Default::default()
            },
        );
    }

    pub fn presented_frame(
        &mut self,
        at: Instant,
        queue_ms: f64,
        submit_ms: f64,
        timing: FrameTiming,
    ) {
        // Visibility may have changed while a driver submission was in flight.
        if !self.visible {
            return;
        }
        self.frames += 1;
        self.decoded_queue_ms = queue_ms;
        self.submit_ms = submit_ms;
        let received = timing.received.filter(|r| *r <= at);
        let captured = timing.captured.filter(|c| received.is_none_or(|r| *c <= r));
        let ms = |end: Instant, start: Instant| {
            end.checked_duration_since(start)
                .map(|d| d.as_secs_f64() * 1000.)
        };
        self.capture_to_receive_ms = received.zip(captured).and_then(|(r, c)| ms(r, c));
        self.receive_to_present_ms = received.and_then(|r| ms(at, r));
        self.decode_to_present_ms = timing
            .decoded
            .filter(|d| received.is_none_or(|r| *d >= r))
            .and_then(|d| ms(at, d));
        self.end_to_end_ms = captured
            .and_then(|captured| at.checked_duration_since(captured))
            .map(|age| age.as_secs_f64() * 1000.);
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
        let latency_age = self
            .last
            .and_then(|last| at.checked_duration_since(last))
            .filter(|age| self.visible && *age <= LATENCY_MAX_AGE);
        let end_to_end_ms = latency_age.and(self.end_to_end_ms);
        ViewStats {
            presented_frames: self.frames,
            one_percent_low_fps: low,
            one_percent_low_state: self.truncated_at.map(|_| "estimated"),
            decoded_queue_ms: self.decoded_queue_ms,
            submit_ms: self.submit_ms,
            end_to_end_ms,
            end_to_end_state: end_to_end_ms.map(|_| "estimated"),
            end_to_end_age_ms: end_to_end_ms
                .and(latency_age)
                .map(|age| age.as_secs_f64() * 1000.),
            timing_age_ms: latency_age.map(|age| age.as_secs_f64() * 1000.),
            capture_to_receive_ms: latency_age.and(self.capture_to_receive_ms),
            receive_to_present_ms: latency_age.and(self.receive_to_present_ms),
            decode_to_present_ms: latency_age.and(self.decode_to_present_ms),
        }
    }
}

#[cfg(test)]
#[path = "statistics_tests.rs"]
mod tests;
