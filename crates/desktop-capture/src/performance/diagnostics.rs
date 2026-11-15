//! Serializable scheduling outcomes, not measured latency or clock speed.
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "reason", rename_all = "camelCase")]
pub enum Status {
    Inactive,
    Applied,
    AlreadyApplied,
    Unsupported,
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReport {
    pub scheduling: Status,
    pub timing: Status,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub remote_consumers: usize,
    pub timing: Status,
    pub gpu_scheduling: Status,
    /// Last request on each kind of worker; these are not latency measurements.
    pub capture_thread: Option<ThreadReport>,
    pub encode_thread: Option<ThreadReport>,
}
