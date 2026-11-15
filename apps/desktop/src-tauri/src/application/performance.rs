//! Application owner for startup power preferences and leased stream scheduling.
//! Startup results are retained; stream teardown never rewrites driver profiles.
mod diagnostics;
mod power;
pub use diagnostics::PipelineReport;

use diagnostics::PowerPolicyReport;
use std::sync::Arc;
use weblink_desktop_capture::{
    media::{pipeline::PipelineStats, MediaOptions, MediaSession},
    performance::Manager,
};

#[cfg(test)]
mod tests;

pub type Shared = Arc<PerformanceService>;

pub struct PerformanceService {
    power_policy: PowerPolicyReport,
    streams: Arc<Manager>,
}

impl PerformanceService {
    /// Initialize once, before Tauri/WebView or capture can create GPU devices.
    pub fn new() -> Self {
        Self::initialize(power::configure)
    }

    fn initialize(configure: impl FnOnce() -> power::Report) -> Self {
        let result = configure();
        result.log();
        Self {
            power_policy: PowerPolicyReport::new(result),
            streams: Arc::default(),
        }
    }

    pub fn create_media(&self, options: MediaOptions) -> Result<Arc<MediaSession>, String> {
        MediaSession::with_performance(options, self.streams.clone())
    }

    pub fn pipeline_stats(&self, media: &MediaSession) -> PipelineReport {
        self.report(media.pipeline_stats())
    }

    fn report(&self, pipeline: PipelineStats) -> PipelineReport {
        PipelineReport::new(pipeline, &self.power_policy)
    }
}
