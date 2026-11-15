//! Scoped scheduling hints for native senders. No capture cadence or GPU power policy.
//! Share one Manager between captures; leases belong to remote publication lifetimes.
mod diagnostics;
mod leases;
#[cfg(windows)]
#[path = "performance/platform/windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "performance/platform/linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "performance/platform/macos.rs"]
mod platform;
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
#[path = "performance/platform/unsupported.rs"]
mod platform;
mod session;

pub use diagnostics::{Snapshot, Status, ThreadReport};
pub use session::{Manager, Session, StreamLease};

#[derive(Clone, Copy, Debug)]
pub enum ThreadRole {
    Capture,
    Encode,
}

struct Setting<T> {
    status: Status,
    _guard: Option<T>,
}
impl<T> Setting<T> {
    fn from_result(result: Result<Option<T>, String>) -> Self {
        match result {
            Ok(Some(guard)) => Self {
                status: Status::Applied,
                _guard: Some(guard),
            },
            Ok(None) => Self {
                status: Status::AlreadyApplied,
                _guard: None,
            },
            Err(error) => Self {
                status: Status::Failed(error),
                _guard: None,
            },
        }
    }
    #[cfg(not(windows))]
    fn unsupported() -> Self {
        Self {
            status: Status::Unsupported,
            _guard: None,
        }
    }
}

fn restore_error(component: &str, error: impl std::fmt::Display) {
    eprintln!("Could not restore Weblink {component}: {error}");
}
