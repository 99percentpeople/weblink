//! Bounded rolling stage timings. Milliseconds are processing time, not end-to-end latency.
use serde::Serialize;
#[cfg(any(windows, test))]
use std::collections::VecDeque;

#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageStats {
    pub mean_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}
#[cfg(any(windows, test))]
impl StageStats {
    pub(crate) fn from_samples(values: impl Iterator<Item = f64>) -> Self {
        let mut values: Vec<_> = values.collect();
        if values.is_empty() {
            return Self::default();
        }
        values.sort_by(f64::total_cmp);
        Self {
            mean_ms: values.iter().sum::<f64>() / values.len() as f64,
            p95_ms: values
                [((values.len() as f64 * 0.95).ceil() as usize - 1).min(values.len() - 1)],
            max_ms: *values.last().unwrap(),
        }
    }
}
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStats {
    pub frames: u64,
    pub input_size: (u32, u32),
    pub readback_size: (u32, u32),
    pub gpu_scaled: bool,
    pub scale_fallback: Option<String>,
    pub peers: usize,
    pub hardware_encoders: usize,
    pub lock: StageStats,
    pub prepare: StageStats,
    pub map: StageStats,
    pub compose: StageStats,
    pub convert: StageStats,
    pub scale: StageStats,
    pub publish: StageStats,
    pub total: StageStats,
    /// Capture callback arrival to CPU processing, excluding intentional static repeats.
    pub capture_wait: StageStats,
    pub encoders: Vec<super::latency::EncoderPipelineStats>,
}

#[cfg(any(windows, test))]
#[derive(Default)]
pub(crate) struct Timings {
    frames: u64,
    samples: VecDeque<[f64; 7]>,
    pub input_size: (u32, u32),
    pub readback_size: (u32, u32),
    pub scale_fallback: Option<String>,
    pub capture_wait: super::latency::Distribution,
}
#[cfg(any(windows, test))]
impl Timings {
    pub fn record(&mut self, sample: [f64; 7]) {
        if sample
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return;
        }
        self.frames += 1;
        if self.samples.len() >= 120 {
            self.samples.pop_front();
        }
        self.samples.push_back(sample);
    }
    pub fn snapshot(&self) -> PipelineStats {
        let stage = |i| StageStats::from_samples(self.samples.iter().map(|s| s[i]));
        PipelineStats {
            frames: self.frames,
            input_size: self.input_size,
            readback_size: self.readback_size,
            gpu_scaled: self.input_size != self.readback_size,
            scale_fallback: self.scale_fallback.clone(),
            lock: stage(0),
            prepare: stage(1),
            map: stage(2),
            compose: stage(3),
            convert: stage(4),
            scale: stage(5),
            publish: stage(6),
            total: StageStats::from_samples(self.samples.iter().map(|s| s.iter().sum())),
            capture_wait: self.capture_wait.snapshot(),
            ..Default::default()
        }
    }
}

#[cfg(windows)]
pub(crate) struct Clock {
    last: std::time::Instant,
    pub stages: [f64; 7],
}
#[cfg(windows)]
impl Clock {
    pub fn new() -> Self {
        Self {
            last: std::time::Instant::now(),
            stages: [0.0; 7],
        }
    }
    pub fn mark(&mut self, index: usize) {
        let now = std::time::Instant::now();
        self.stages[index] = now.duration_since(self.last).as_secs_f64() * 1000.0;
        self.last = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timings_are_bounded_and_percentiles_expose_spikes() {
        let mut timings = Timings::default();
        timings.record([100.0; 7]);
        for _ in 0..120 {
            timings.record([1.0; 7]);
        }
        let report = timings.snapshot();
        assert_eq!(report.frames, 121);
        assert_eq!(report.total.max_ms, 7.0);
        assert_eq!(report.map.p95_ms, 1.0);
        timings.record([f64::NAN; 7]);
        assert_eq!(timings.snapshot().frames, 121);
        for _ in 0..7 {
            timings.record([10.0; 7]);
        }
        assert_eq!(timings.snapshot().map.p95_ms, 10.0);
    }
}
