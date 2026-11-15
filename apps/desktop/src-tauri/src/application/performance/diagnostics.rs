//! Compose startup and stream diagnostics without coupling the capture crate to the app.
use super::power;
use serde::Serialize;
use weblink_desktop_capture::{media::pipeline::PipelineStats, performance::Snapshot};

#[derive(Serialize)]
pub struct PipelineReport {
    #[serde(flatten)]
    pipeline: PipelineStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    performance: Option<PerformanceReport>,
}

impl PipelineReport {
    pub(super) fn new(mut pipeline: PipelineStats, power_policy: &PowerPolicyReport) -> Self {
        // Preserve the wire shape without duplicate serialized `performance` keys.
        let performance = pipeline.performance.take().map(|stream| PerformanceReport {
            stream,
            power_policy: power_policy.clone(),
        });
        Self {
            pipeline,
            performance,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PerformanceReport {
    #[serde(flatten)]
    stream: Snapshot,
    power_policy: PowerPolicyReport,
}

#[derive(Clone, Serialize)]
pub(super) struct PowerPolicyReport {
    #[serde(flatten)]
    result: power::Report,
    /// Describes the startup preference contract, including unsupported requests.
    lifetime: PowerPolicyLifetime,
}

impl PowerPolicyReport {
    pub(super) fn new(result: power::Report) -> Self {
        Self {
            result,
            lifetime: PowerPolicyLifetime::PersistentApplication,
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum PowerPolicyLifetime {
    PersistentApplication,
}
