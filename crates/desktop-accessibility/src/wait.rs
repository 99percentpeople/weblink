//! Poll short inspections without sleeping on the UIA worker or holding permission locks.
use crate::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub(crate) fn run(
    request: &WaitRequest,
    access: &Access,
    mut inspect: impl FnMut(Duration) -> Result<Value>,
) -> Result<Value> {
    request.validate()?;
    let start = Instant::now();
    let timeout = Duration::from_millis(request.timeout_ms);
    let result = |node: Option<Value>| {
        json!({
            "matched":node.is_some(),"timedOut":node.is_none(),
            "elapsedMs":start.elapsed().as_millis() as u64,"node":node,
        })
    };
    loop {
        (access.check)()?;
        let remaining = timeout.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            return Ok(result(None));
        }
        match inspect(remaining) {
            Ok(node) => {
                (access.check)()?;
                if request.condition.matches(&node) {
                    return Ok(result(Some(node)));
                }
            }
            Err(Error::Timeout) if start.elapsed() >= timeout => {
                (access.check)()?;
                return Ok(result(None));
            }
            Err(error) => return Err(error),
        }
        let until =
            (start.elapsed() + Duration::from_millis(request.poll_interval_ms)).min(timeout);
        while start.elapsed() < until {
            (access.check)()?;
            std::thread::sleep(
                until
                    .saturating_sub(start.elapsed())
                    .min(Duration::from_millis(20)),
            );
        }
        // A timeout returns no cached UI node: its original read grant may have expired
        // during the pause, and the deadline leaves no time for another native validation.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    fn access(flag: &Arc<AtomicBool>) -> Access {
        let flag = flag.clone();
        let check: Check = Arc::new(move || {
            if flag.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(Error::Cancelled)
            }
        });
        Access {
            owner: "wait-test".into(),
            check: check.clone(),
            lease: check,
        }
    }
    fn request() -> WaitRequest {
        WaitRequest {
            element_id: "original-id".into(),
            condition: WaitCondition {
                selected: Some(true),
                ..Default::default()
            },
            timeout_ms: 500,
            poll_interval_ms: 50,
        }
    }
    #[test]
    fn repeated_inspections_match_only_when_all_conditions_hold() {
        let flag = Arc::new(AtomicBool::new(true));
        let mut count = 0;
        let mut request = request();
        request.condition.enabled = Some(true);
        let result = run(&request, &access(&flag), |_| {
            count += 1;
            Ok(json!({"elementId":"fresh","protected":false,"selected":true,"enabled":count == 2}))
        })
        .unwrap();
        assert_eq!(count, 2);
        assert_eq!(result["matched"], true);
        assert_eq!(result["node"]["elementId"], "fresh");
    }
    #[test]
    fn timeouts_return_no_stale_snapshot_and_bound_each_provider_wait() {
        let flag = Arc::new(AtomicBool::new(true));
        let mut request = request();
        request.timeout_ms = 1;
        let result = run(&request, &access(&flag), |remaining| {
            assert!(remaining <= Duration::from_millis(1));
            Ok(json!({"protected":false,"selected":false}))
        })
        .unwrap();
        assert_eq!(result["matched"], false);
        assert_eq!(result["timedOut"], true);
        assert!(result["node"].is_null());
    }
    #[test]
    fn cancellation_between_polls_prevents_another_provider_request() {
        let flag = Arc::new(AtomicBool::new(true));
        let count = AtomicUsize::new(0);
        let result = run(&request(), &access(&flag), |_| {
            count.fetch_add(1, Ordering::SeqCst);
            flag.store(false, Ordering::SeqCst);
            Ok(json!({"protected":false,"selected":false}))
        });
        assert_eq!(result, Err(Error::Cancelled));
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn truncated_values_never_satisfy_exact_equality_and_protected_nodes_never_match() {
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
        assert!(WaitCondition::default().validate().is_err());
    }
    #[test]
    fn invalid_wait_bounds_and_predicates_are_rejected_before_inspection() {
        let flag = Arc::new(AtomicBool::new(true));
        for (timeout_ms, poll_interval_ms) in [(0, 100), (30001, 100), (1000, 49), (1000, 1001)] {
            let mut request = request();
            request.timeout_ms = timeout_ms;
            request.poll_interval_ms = poll_interval_ms;
            assert_eq!(
                run(&request, &access(&flag), |_| panic!("must not inspect")),
                Err(Error::InvalidArguments)
            );
        }
        let mut request = request();
        request.condition = WaitCondition::default();
        assert_eq!(
            run(&request, &access(&flag), |_| panic!("must not inspect")),
            Err(Error::InvalidArguments)
        );
        let valid_name = WaitCondition {
            name: Some("界".repeat(512)),
            ..Default::default()
        };
        assert!(valid_name.validate().is_ok());
        let invalid_name = WaitCondition {
            name: Some("界".repeat(513)),
            ..Default::default()
        };
        assert_eq!(invalid_name.validate(), Err(Error::InvalidArguments));
    }
}
