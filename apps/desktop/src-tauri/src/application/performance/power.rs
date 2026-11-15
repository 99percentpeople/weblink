//! Application-scoped GPU power preference, independent of the encoder and cadence.
//! Backends may persist this preference, but must never change machine-wide policy.
#[cfg(windows)]
mod nvidia;
#[cfg(test)]
mod tests;

use serde::Serialize;
use std::path::Path;

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Change {
    Applied,
    AlreadyApplied,
}

/// Implementations must target only the supplied absolute executable path and
/// verify the application override. A successful request does not prove GPU clocks
/// or encoder latency. CPU QoS and adapter selection do not implement this contract.
trait Backend {
    fn name(&self) -> Option<&'static str>;
    /// None means this backend cannot provide an application GPU power preference.
    fn prefer_maximum_performance(&self, executable: &Path) -> Result<Option<Change>>;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "reason", rename_all = "camelCase")]
pub enum Status {
    Applied,
    AlreadyApplied,
    Unsupported,
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The selected policy backend, not necessarily the GPU used by the active encoder.
    pub backend: Option<&'static str>,
    pub status: Status,
}

impl Report {
    pub fn log(&self) {
        let backend = self.backend.unwrap_or("platform");
        match &self.status {
            Status::Applied => {
                eprintln!("Enabled {backend} maximum performance for this Weblink executable")
            }
            Status::Failed(error) => {
                eprintln!("Could not configure Weblink GPU power preference ({backend}): {error}")
            }
            Status::AlreadyApplied | Status::Unsupported => {}
        }
    }
}

fn apply(backend: &impl Backend, executable: Result<&Path>) -> Report {
    let result = executable.and_then(|executable| {
        if !executable.is_absolute() {
            return Err("The GPU preference requires an absolute executable path".into());
        }
        backend.prefer_maximum_performance(executable)
    });
    Report {
        backend: backend.name(),
        status: match result {
            Ok(Some(Change::Applied)) => Status::Applied,
            Ok(Some(Change::AlreadyApplied)) => Status::AlreadyApplied,
            Ok(None) => Status::Unsupported,
            Err(error) => Status::Failed(error),
        },
    }
}

/// Call before Tauri/WebView or capture creates graphics devices. This is a
/// persistent application preference, not a per-stream lease. Unsupported systems
/// and driver failures leave the normal capture/encoder fallback path available.
pub fn configure() -> Report {
    #[cfg(windows)]
    let backend = nvidia::Nvidia;
    #[cfg(not(windows))]
    let backend = Unsupported;
    let executable = std::env::current_exe().map_err(|error| error.to_string());
    apply(&backend, executable.as_deref().map_err(Clone::clone))
}

#[cfg(any(not(windows), test))]
struct Unsupported;

#[cfg(any(not(windows), test))]
impl Backend for Unsupported {
    fn name(&self) -> Option<&'static str> {
        None
    }
    fn prefer_maximum_performance(&self, _: &Path) -> Result<Option<Change>> {
        Ok(None)
    }
}
