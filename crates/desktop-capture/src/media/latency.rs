//! Local monotonic stage measurements. These are not glass-to-glass latency.
use super::pipeline::StageStats;
use serde::Serialize;
#[cfg(any(windows, test))]
use std::{collections::VecDeque, time::Duration};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecControl {
    pub name: String,
    pub requested: u32,
    pub actual: Option<u32>,
    pub accepted: bool,
    pub error: Option<String>,
}

#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareEncoderSelection {
    pub requested: String,
    pub encoder: String,
    pub name: String,
    pub capture_adapter: Option<String>,
    pub encoder_adapter: Option<String>,
    pub adapter_matched: bool,
    pub fallback: Option<String>,
}

#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderPipelineStats {
    pub peer: String,
    pub group_id: u64,
    pub consumers: Vec<String>,
    pub frames: u64,
    pub gpu_inputs: u64,
    pub cpu_inputs: u64,
    pub gpu_fallback: Option<String>,
    pub selection: Option<HardwareEncoderSelection>,
    pub fresh_frames: u64,
    pub replaced_inputs: u64,
    pub rate_limited_inputs: u64,
    pub encoded_bytes: u64,
    pub in_flight: usize,
    pub max_in_flight: usize,
    pub queue: StageStats,
    pub encode: StageStats,
    pub capture_to_encode: StageStats,
    pub stages: EncoderStages,
    /// Interval between delivered outputs, including idle/capture gaps; not an encode stage.
    pub output_interval: StageMeasurement,
    pub controls: Vec<CodecControl>,
}

/// Cumulative counters plus the most recent 120 observations. Zero samples
/// means unobserved/unsupported, not a measured zero-cost stage.
#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageMeasurement {
    pub samples: u64,
    pub total_seconds: f64,
    #[serde(flatten)]
    pub latency: StageStats,
}

#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderStages {
    pub prepare: StageMeasurement,
    pub context_lock: StageMeasurement,
    pub input: StageMeasurement,
    pub output_wait: StageMeasurement,
    pub event_dispatch: StageMeasurement,
    pub output: StageMeasurement,
    pub delivery: StageMeasurement,
    pub bitrate_update: StageMeasurement,
}

#[cfg(any(windows, test))]
#[derive(Clone, Default)]
pub(crate) struct Distribution {
    pub count: u64,
    pub seconds: f64,
    samples: VecDeque<f64>,
}
#[cfg(any(windows, test))]
impl Distribution {
    pub fn record(&mut self, duration: Duration) {
        self.count += 1;
        self.seconds += duration.as_secs_f64();
        if self.samples.len() == 120 {
            self.samples.pop_front();
        }
        self.samples.push_back(duration.as_secs_f64() * 1000.0);
    }
    pub fn snapshot(&self) -> StageStats {
        StageStats::from_samples(self.samples.iter().copied())
    }
    pub fn measurement(&self) -> StageMeasurement {
        StageMeasurement {
            samples: self.count,
            total_seconds: self.seconds,
            latency: self.snapshot(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rolling_latency_expires_spikes_without_resetting_interval_counters() {
        let mut samples = Distribution::default();
        samples.record(Duration::from_millis(900));
        for _ in 0..120 {
            samples.record(Duration::from_millis(2));
        }
        assert_eq!(samples.count, 121);
        assert!((samples.seconds - 1.14).abs() < 1e-9);
        assert_eq!(samples.snapshot().max_ms, 2.0);
        assert_eq!(samples.snapshot().p95_ms, 2.0);
    }
}
