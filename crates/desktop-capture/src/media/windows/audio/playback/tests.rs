use super::*;
use std::sync::Arc;

#[derive(Clone, Default)]
struct FakeEndpoint(Arc<Mutex<State>>);
#[derive(Default)]
struct State {
    muted: bool,
    fail: bool,
    fail_read: bool,
    writes: Vec<bool>,
}
impl Endpoint for FakeEndpoint {
    fn muted(&self) -> Result<bool> {
        let state = self.0.lock().unwrap();
        if state.fail_read {
            return Err("status unavailable".into());
        }
        Ok(state.muted)
    }
    fn set_muted(&self, muted: bool) -> Result<()> {
        let mut state = self.0.lock().unwrap();
        if state.fail {
            return Err("endpoint unavailable".into());
        }
        state.muted = muted;
        state.writes.push(muted);
        Ok(())
    }
}
fn acquire<'a>(registry: &'a Registry, endpoint: &FakeEndpoint) -> PlaybackMute<'a, FakeEndpoint> {
    PlaybackMute::acquire(registry, vec![("speakers".into(), endpoint.clone())]).unwrap()
}

#[test]
fn restores_only_after_the_last_overlapping_capture_ends() {
    let registry = Registry::default();
    let output = FakeEndpoint::default();
    let first = acquire(&registry, &output);
    let second = acquire(&registry, &output);
    assert!(output.muted().unwrap());
    drop(first);
    assert!(output.muted().unwrap());
    drop(second);
    assert!(!output.muted().unwrap());
    assert_eq!(output.0.lock().unwrap().writes, [true, false]);
    assert!(registry.lock().unwrap().is_empty());
}

#[test]
fn preserves_an_already_muted_output() {
    let registry = Registry::default();
    let output = FakeEndpoint::default();
    output.0.lock().unwrap().muted = true;
    drop(acquire(&registry, &output));
    assert!(output.muted().unwrap());
    assert!(output.0.lock().unwrap().writes.is_empty());
}

#[test]
fn attempts_restoration_when_the_final_status_read_fails() {
    let registry = Registry::default();
    let output = FakeEndpoint::default();
    let lease = acquire(&registry, &output);
    output.0.lock().unwrap().fail_read = true;
    drop(lease);
    let state = output.0.lock().unwrap();
    assert!(!state.muted);
    assert_eq!(state.writes, [true, false]);
}

#[test]
fn does_not_override_a_manual_unmute_on_stop() {
    let registry = Registry::default();
    let output = FakeEndpoint::default();
    let lease = acquire(&registry, &output);
    output.0.lock().unwrap().muted = false;
    drop(lease);
    assert!(!output.muted().unwrap());
    assert_eq!(output.0.lock().unwrap().writes, [true]);
}

#[test]
fn startup_failure_rolls_back_muted_outputs_without_releasing_other_captures() {
    let registry = Registry::default();
    let existing = FakeEndpoint::default();
    let first = acquire(&registry, &existing);
    let output = FakeEndpoint::default();
    let failing = FakeEndpoint::default();
    failing.0.lock().unwrap().fail = true;
    let result = PlaybackMute::acquire(
        &registry,
        vec![
            ("speakers".into(), existing.clone()),
            ("headphones".into(), output.clone()),
            ("unavailable".into(), failing),
        ],
    );
    assert!(result.is_err());
    assert!(!output.muted().unwrap());
    assert!(existing.muted().unwrap());
    drop(first);
    assert!(!existing.muted().unwrap());
    assert!(registry.lock().unwrap().is_empty());
}
