use serde_json::{json, Value};
use std::sync::OnceLock;

fn policy(code: &str) -> Option<&'static Value> {
    static RULES: OnceLock<Value> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../../packages/automation/src/error-codes.json"
        ))
        .expect("automation error recovery policies")
    });
    rules.get(code)
}

/// Defaults to an uncertain outcome: cancellation/revocation may follow an OS side effect.
pub(super) fn failure(code: &str) -> Value {
    enrich(
        json!({"ok":false,"error":{"code":code,"message":code}}),
        false,
    )
}

pub(super) fn before_dispatch(code: &str) -> Value {
    enrich(
        json!({"ok":false,"error":{"code":code,"message":code,"outcome":"not_applied"}}),
        false,
    )
}

/// Do not disclose UI data after revocation, but retain an already acknowledged action outcome.
pub(super) fn after_revocation(name: &str, result: &Value) -> Value {
    let mut denied = failure("GRANT_EXPIRED");
    if name == "accessibility.action"
        && ((result["ok"] == true && result["data"]["applied"] == true)
            || (result["ok"] == false && result["error"]["outcome"] == "applied"))
    {
        denied["error"]["outcome"] = json!("applied");
    }
    denied
}

/// Read-only calls can be retried after transient failures; mutations require evidence first.
pub(super) fn enrich(mut result: Value, read_only: bool) -> Value {
    if result["ok"] != false {
        return result;
    }
    let Some(error) = result.get_mut("error").and_then(Value::as_object_mut) else {
        return result;
    };
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("EXECUTION_FAILED")
        .to_owned();
    let known = policy(&code);
    let rule = known.unwrap_or_else(|| policy("EXECUTION_FAILED").expect("default error policy"));
    let outcome = if read_only {
        "not_applied"
    } else {
        error
            .get("outcome")
            .and_then(Value::as_str)
            .filter(|value| ["not_applied", "applied", "unknown"].contains(value))
            .unwrap_or("unknown")
    }
    .to_owned();
    let keep_no_retry = !read_only && error.get("retryable") == Some(&Value::Bool(false));
    let retryable = outcome == "not_applied" && rule["transient"] == true && !keep_no_retry;
    let action = rule["nextAction"].as_str().unwrap_or("observe");
    let action = if action == "retry" && !retryable {
        "observe"
    } else {
        action
    };
    if known.is_some() && error.get("message").and_then(Value::as_str) == Some(code.as_str()) {
        error.insert("message".into(), rule["message"].clone());
    }
    error.insert("retryable".into(), json!(retryable));
    error.insert("outcome".into(), json!(outcome));
    error.insert("nextAction".into(), json!(action));
    error.remove("retryAfterMs");
    if retryable && rule["retryAfterMs"].is_number() {
        error.insert("retryAfterMs".into(), rule["retryAfterMs"].clone());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lost_mutation_results_never_request_blind_retry() {
        for code in [
            "TIMEOUT",
            "CANCELLED",
            "GRANT_EXPIRED",
            "TARGET_DISCONNECTED",
            "INPUT_TIMEOUT",
        ] {
            let result = failure(code);
            assert_eq!(result["error"]["outcome"], "unknown");
            assert_eq!(result["error"]["retryable"], false);
            assert_ne!(result["error"]["nextAction"], "retry");
        }
    }

    #[test]
    fn readonly_transient_failures_can_retry_but_cancellation_cannot() {
        let busy = enrich(failure("BUSY"), true);
        assert_eq!(busy["error"]["outcome"], "not_applied");
        assert_eq!(busy["error"]["retryable"], true);
        assert_eq!(busy["error"]["retryAfterMs"], 250);
        let cancelled = enrich(failure("CANCELLED"), true);
        assert_eq!(cancelled["error"]["retryable"], false);
        assert_eq!(cancelled["error"]["nextAction"], "stop");
    }

    #[test]
    fn validation_failures_are_known_not_to_have_started_and_legacy_errors_are_enriched() {
        let invalid = before_dispatch("INVALID_ARGUMENTS");
        assert_eq!(invalid["error"]["outcome"], "not_applied");
        assert_eq!(invalid["error"]["nextAction"], "fix_arguments");
        let legacy = enrich(
            json!({"ok":false,"error":{"code":"BUSY","message":"queue is full"}}),
            true,
        );
        assert_eq!(legacy["error"]["message"], "queue is full");
        assert_eq!(legacy["error"]["retryable"], true);
        let success = json!({"ok":true,"data":{"applied":true}});
        assert_eq!(enrich(success.clone(), false), success);
    }

    #[test]
    fn revoked_observations_discard_ui_data_without_erasing_confirmed_actions() {
        let observed =
            json!({"ok":true,"data":{"applied":true,"observation":{"private":"content"}}});
        let denied = after_revocation("accessibility.action", &observed);
        assert_eq!(denied["ok"], false);
        assert_eq!(denied["error"]["code"], "GRANT_EXPIRED");
        assert_eq!(denied["error"]["outcome"], "applied");
        assert_eq!(denied["error"]["retryable"], false);
        assert!(denied.get("data").is_none());
        assert!(!denied.to_string().contains("private"));
        let cancellation = json!({"ok":false,"error":{"code":"CANCELLED","outcome":"applied"}});
        assert_eq!(
            after_revocation("accessibility.action", &cancellation)["error"]["outcome"],
            "applied"
        );
        assert_eq!(
            after_revocation("accessibility.snapshot", &observed)["error"]["outcome"],
            "unknown"
        );
        assert_eq!(
            after_revocation("accessibility.action", &failure("TIMEOUT"))["error"]["outcome"],
            "unknown"
        );
    }

    #[test]
    fn confirmed_side_effects_remain_applied_on_observation_failure() {
        let result = enrich(
            json!({"ok":false,"error":{"code":"TIMEOUT","message":"TIMEOUT","outcome":"applied"}}),
            false,
        );
        assert_eq!(result["error"]["outcome"], "applied");
        assert_eq!(result["error"]["retryable"], false);
    }
}
