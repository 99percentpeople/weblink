//! Event-only waits. No timer periodically inspects the UI and no polling fallback exists.
use crate::*;
use serde_json::{json, Value};
use std::{
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

#[derive(Default)]
struct SignalState {
    changed: bool,
    cancelled: bool,
}

/// Content-free, coalesced notifications. UIA callbacks never inspect elements or take
/// application permission locks. Cancellation uses the same wakeup, not a polling timer.
#[derive(Default)]
pub struct WaitSignal {
    state: Mutex<SignalState>,
    changed: Condvar,
}
impl WaitSignal {
    pub fn notify(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state.cancelled {
            state.changed = true;
            self.changed.notify_one();
        }
    }
    pub fn cancel(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.cancelled = true;
        self.changed.notify_all();
    }
    pub fn is_cancelled(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .cancelled
    }
    fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
    /// Consume before inspecting, so a notification arriving during inspection is retained.
    fn consume(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.cancelled {
            return Err(Error::Cancelled);
        }
        state.changed = false;
        Ok(())
    }
    fn wait_until(&self, deadline: Instant) -> Result<bool> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if state.cancelled {
                return Err(Error::Cancelled);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            if state.changed {
                state.changed = false;
                return Ok(true);
            }
            // Spurious condvar wakes only recheck this in-memory flag, never the UI.
            state = self
                .changed
                .wait_timeout(state, deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
    }
}

/// The caller must subscribe before entering this function. Registration, initial read
/// and subsequent event-triggered reads share one deadline. Timeout never does a final scan.
pub(crate) fn run(
    request: &WaitRequest,
    access: &Access,
    signal: &WaitSignal,
    start: Instant,
    mut inspect: impl FnMut(Duration) -> Result<Value>,
) -> Result<Value> {
    request.validate()?;
    let deadline = start + Duration::from_millis(request.timeout_ms);
    let result = |node: Option<Value>| {
        json!({
            "matched":node.is_some(),"timedOut":node.is_none(),
            "elapsedMs":start.elapsed().as_millis() as u64,"node":node,
        })
    };
    signal.consume()?;
    loop {
        signal.check()?;
        (access.check)()?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(result(None));
        }
        let node = inspect(remaining)?;
        signal.check()?;
        (access.check)()?;
        if Instant::now() >= deadline {
            return Ok(result(None));
        }
        if request.condition.matches(&node) {
            return Ok(result(Some(node)));
        }
        if !signal.wait_until(deadline)? {
            (access.check)()?;
            return Ok(result(None));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };

    fn access() -> Access {
        Access {
            owner: "wait-test".into(),
            check: Arc::new(|| Ok(())),
            lease: Arc::new(|| Ok(())),
        }
    }
    fn request() -> WaitRequest {
        WaitRequest {
            element_id: "original-id".into(),
            condition: WaitCondition {
                selected: Some(true),
                ..Default::default()
            },
            timeout_ms: 1000,
        }
    }
    fn node(selected: bool) -> Value {
        json!({"elementId":"fresh","protected":false,"selected":selected,"enabled":true})
    }
    #[test]
    fn already_matching_state_needs_no_event() {
        let signal = WaitSignal::default();
        let mut reads = 0;
        let result = run(&request(), &access(), &signal, Instant::now(), |_| {
            reads += 1;
            Ok(node(true))
        })
        .unwrap();
        assert_eq!(reads, 1);
        assert_eq!(result["matched"], true);
    }
    #[test]
    fn silent_provider_times_out_without_polling_or_final_scan() {
        let mut request = request();
        request.timeout_ms = 40;
        let mut reads = 0;
        let result = run(
            &request,
            &access(),
            &WaitSignal::default(),
            Instant::now(),
            |_| {
                reads += 1;
                Ok(node(false))
            },
        )
        .unwrap();
        assert_eq!(reads, 1);
        assert_eq!(result["timedOut"], true);
        assert!(result["node"].is_null());
    }
    #[test]
    fn event_during_inspection_is_not_lost_and_bursts_are_coalesced() {
        let signal = WaitSignal::default();
        let mut reads = 0;
        let result = run(&request(), &access(), &signal, Instant::now(), |_| {
            reads += 1;
            if reads == 1 {
                for _ in 0..1000 {
                    signal.notify();
                }
            }
            Ok(node(reads == 2))
        })
        .unwrap();
        assert_eq!(reads, 2);
        assert_eq!(result["matched"], true);
    }
    #[test]
    fn notifications_are_hints_and_all_conditions_must_match() {
        let signal = WaitSignal::default();
        let mut request = request();
        request.condition.enabled = Some(true);
        let mut reads = 0;
        let result = run(&request, &access(), &signal, Instant::now(), |_| {
            reads += 1;
            if reads < 3 {
                signal.notify();
            }
            Ok(json!({"protected":false,"selected":reads > 1,"enabled":reads == 3}))
        })
        .unwrap();
        assert_eq!(reads, 3);
        assert_eq!(result["matched"], true);
    }
    #[test]
    fn cancellation_wakes_an_idle_wait_without_a_provider_event() {
        let signal = Arc::new(WaitSignal::default());
        let (ready, first_read) = mpsc::channel();
        let (done, result) = mpsc::channel();
        let waiting = signal.clone();
        let worker = std::thread::spawn(move || {
            let outcome = run(&request(), &access(), &waiting, Instant::now(), |_| {
                ready.send(()).unwrap();
                Ok(node(false))
            });
            done.send(outcome).unwrap();
        });
        first_read.recv_timeout(Duration::from_secs(2)).unwrap();
        signal.cancel();
        assert_eq!(
            result.recv_timeout(Duration::from_millis(500)).unwrap(),
            Err(Error::Cancelled)
        );
        worker.join().unwrap();
        signal.notify();
        assert!(signal.is_cancelled());
    }
    #[test]
    fn authority_change_notification_prevents_another_inspection() {
        let valid = Arc::new(AtomicBool::new(true));
        let copy = valid.clone();
        let mut access = access();
        access.check = Arc::new(move || {
            if copy.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(Error::PermissionDenied)
            }
        });
        let signal = WaitSignal::default();
        let mut reads = 0;
        let result = run(&request(), &access, &signal, Instant::now(), |_| {
            reads += 1;
            valid.store(false, Ordering::SeqCst);
            signal.notify();
            Ok(node(false))
        });
        assert_eq!(reads, 1);
        assert_eq!(result, Err(Error::PermissionDenied));
    }
    #[test]
    fn provider_errors_are_not_hidden_as_condition_timeouts_or_retried() {
        for error in [
            Error::Timeout,
            Error::Unsupported,
            Error::StaleElement,
            Error::ProviderUnavailable,
        ] {
            let mut reads = 0;
            let result = run(
                &request(),
                &access(),
                &WaitSignal::default(),
                Instant::now(),
                |_| {
                    reads += 1;
                    Err(error)
                },
            );
            assert_eq!(reads, 1);
            assert_eq!(result, Err(error));
        }
    }
    #[test]
    fn registration_time_is_included_and_deadline_does_not_trigger_a_scan() {
        let result = run(
            &request(),
            &access(),
            &WaitSignal::default(),
            Instant::now() - Duration::from_secs(2),
            |_| panic!("deadline must not scan"),
        )
        .unwrap();
        assert_eq!(result["timedOut"], true);
    }
    #[test]
    fn truncated_values_and_protected_nodes_never_match() {
        let condition = WaitCondition {
            value: Some("prefix".into()),
            ..Default::default()
        };
        assert!(
            !condition.matches(&json!({"protected":false,"value":"prefix","valueTruncated":true}))
        );
        assert!(
            condition.matches(&json!({"protected":false,"value":"prefix","valueTruncated":false}))
        );
        assert!(!condition.matches(&json!({"protected":true,"value":"prefix"})));
        let condition = WaitCondition {
            text_contains: Some("visible".into()),
            ..Default::default()
        };
        assert!(condition
            .matches(&json!({"protected":false,"text":"visible prefix","textTruncated":true})));
    }
    #[test]
    fn invalid_requests_never_inspect() {
        for timeout_ms in [0, 30001] {
            let mut request = request();
            request.timeout_ms = timeout_ms;
            assert_eq!(
                run(
                    &request,
                    &access(),
                    &WaitSignal::default(),
                    Instant::now(),
                    |_| panic!()
                ),
                Err(Error::InvalidArguments)
            );
        }
        assert!(WaitCondition::default().validate().is_err());
        assert!(WaitCondition {
            name: Some("界".repeat(512)),
            ..Default::default()
        }
        .validate()
        .is_ok());
        assert_eq!(
            WaitCondition {
                name: Some("界".repeat(513)),
                ..Default::default()
            }
            .validate(),
            Err(Error::InvalidArguments)
        );
    }
}
