use super::*;
use std::cell::RefCell;
use std::path::PathBuf;

struct FakeBackend {
    result: Result<Option<Change>>,
    paths: RefCell<Vec<PathBuf>>,
}

impl Backend for FakeBackend {
    fn name(&self) -> Option<&'static str> {
        Some("test backend")
    }
    fn prefer_maximum_performance(&self, executable: &Path) -> Result<Option<Change>> {
        self.paths.borrow_mut().push(executable.into());
        self.result.clone()
    }
}

#[test]
fn reports_applied_existing_unsupported_and_failed_requests_distinctly() {
    let executable = std::env::temp_dir().join("weblink-desktop.exe");
    for (result, status) in [
        (Ok(Some(Change::Applied)), Status::Applied),
        (Ok(Some(Change::AlreadyApplied)), Status::AlreadyApplied),
        (Ok(None), Status::Unsupported),
        (
            Err("driver refused preference".into()),
            Status::Failed("driver refused preference".into()),
        ),
    ] {
        let backend = FakeBackend {
            result,
            paths: RefCell::default(),
        };
        assert_eq!(
            apply(&backend, Ok(&executable)),
            Report {
                backend: Some("test backend"),
                status,
            }
        );
        assert_eq!(*backend.paths.borrow(), [executable.clone()]);
    }
}

#[test]
fn invalid_or_unavailable_executable_never_reaches_the_driver() {
    let backend = FakeBackend {
        result: Ok(Some(Change::Applied)),
        paths: RefCell::default(),
    };
    for executable in [
        Ok(Path::new("weblink-desktop.exe")),
        Err("executable path unavailable".into()),
    ] {
        assert!(matches!(
            apply(&backend, executable).status,
            Status::Failed(_)
        ));
    }
    assert!(backend.paths.borrow().is_empty());
}

#[test]
fn fallback_explicitly_reports_no_power_policy_support() {
    let executable = std::env::temp_dir().join("weblink-desktop.exe");
    assert_eq!(
        apply(&Unsupported, Ok(&executable)),
        Report {
            backend: None,
            status: Status::Unsupported,
        }
    );
}
