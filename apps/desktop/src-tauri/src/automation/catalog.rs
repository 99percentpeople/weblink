use serde_json::Value;
use std::sync::OnceLock;
pub fn diagnostic(name: &str) -> bool {
    matches!(
        name,
        "diagnostics.snapshot"
            | "diagnostics.history"
            | "diagnostics.export"
            | "diagnostics.start"
            | "diagnostics.stop"
    )
}
pub fn permission_scopes(scope: &str) -> &'static [String] {
    static GROUPS: OnceLock<std::collections::BTreeMap<String, Vec<String>>> = OnceLock::new();
    GROUPS
        .get_or_init(|| {
            serde_json::from_str(include_str!(
                "../../../../../packages/automation/src/permission-groups.json"
            ))
            .expect("automation permission groups")
        })
        .values()
        .find(|scopes| scopes.iter().any(|member| member == scope))
        .map(Vec::as_slice)
        .unwrap_or_default()
}
pub fn tools() -> &'static Vec<Value> {
    static TOOLS: OnceLock<Vec<Value>> = OnceLock::new();
    TOOLS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../../packages/automation/src/catalog.json"
        ))
        .expect("automation catalog")
    })
}
pub fn find(name: &str) -> Result<&'static Value, String> {
    tools()
        .iter()
        .find(|t| t["name"] == name)
        .ok_or_else(|| "UNSUPPORTED".into())
}
pub fn validate(name: &str, args: &Value) -> Result<&'static Value, String> {
    let tool = find(name)?;
    if !jsonschema::is_valid(&tool["inputSchema"], args) {
        return Err("INVALID_ARGUMENTS".into());
    }
    Ok(tool)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permission_groups_cover_the_catalog_and_keep_terminal_separate() {
        for tool in tools() {
            let scope = tool["scope"].as_str().unwrap();
            assert!(permission_scopes(scope)
                .iter()
                .any(|member| member == scope));
        }
        assert_eq!(permission_scopes("shell.execute"), &["shell.execute"]);
        assert_eq!(
            permission_scopes("screen.read"),
            permission_scopes("accessibility.read")
        );
        assert!(!permission_scopes("screen.read").contains(&"input.control".into()));
        assert!(permission_scopes("pty.future").is_empty());
    }
    #[test]
    fn accessibility_catalog_matches_native_actions_and_limits() {
        assert_eq!(
            find("accessibility.action").unwrap()["inputSchema"]["properties"]["action"]["enum"],
            serde_json::to_value(weblink_desktop_accessibility::ACTIONS).unwrap()
        );
        assert_eq!(
            find("accessibility.snapshot").unwrap()["scope"],
            "accessibility.read"
        );
        assert_eq!(
            find("accessibility.action").unwrap()["scope"],
            "input.control"
        );
        assert!(validate(
            "accessibility.snapshot",
            &serde_json::json!({"target":"local","elementId":"opaque","maxDepth":9})
        )
        .is_err());
        assert!(validate(
            "accessibility.snapshot",
            &serde_json::json!({"target":"local","elementId":"opaque","maxNodes":257})
        )
        .is_err());
    }
    #[test]
    fn physical_coordinates_and_run_wait_are_validated_by_shared_schema() {
        use serde_json::json;
        assert!(validate("control.pointer", &json!({"target":"local","x":0.5,"y":1})).is_err());
        let args = json!({"target":"local","action":"move","coordinateSpace":"desktopPhysicalPixels","sourceId":"monitor","geometryRevision":"rev","x":-100,"y":0});
        assert!(validate("control.pointer", &args).is_ok());
        for field in ["coordinateSpace", "sourceId", "geometryRevision"] {
            let mut missing = args.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(validate("control.pointer", &missing).is_err());
        }
        for space in ["sourceNormalized", "cssPixels"] {
            let mut unsupported = args.clone();
            unsupported["coordinateSpace"] = json!(space);
            assert!(validate("control.pointer", &unsupported).is_err());
        }
        assert!(validate(
            "commands.run",
            &json!({"target":"local","script":"echo ok","waitMs":60000,"timeoutMs":600000})
        )
        .is_ok());
        for wait in [0, 60001] {
            assert!(validate(
                "commands.run",
                &json!({"target":"local","script":"echo ok","waitMs":wait})
            )
            .is_err());
        }
        assert!(validate(
            "commands.start",
            &json!({"target":"local","script":"echo ok","waitMs":1})
        )
        .is_err());
        assert_eq!(
            find("commands.run").unwrap()["scope"],
            find("commands.start").unwrap()["scope"]
        );
    }
    #[test]
    fn job_reads_select_one_bounded_mode_and_use_absolute_cursors() {
        use serde_json::json;
        for selector in [
            json!({}),
            json!({"cursor":4194305u64}),
            json!({"cursor":9007199254740991u64}),
            json!({"tailBytes":16384}),
            json!({"tailLines":1000}),
        ] {
            let mut args = json!({"target":"local","jobId":"job"});
            args.as_object_mut()
                .unwrap()
                .extend(selector.as_object().unwrap().clone());
            assert!(validate("commands.read", &args).is_ok(), "{args}");
        }
        for selector in [
            json!({"cursor":0,"tailBytes":1}),
            json!({"cursor":0,"tailLines":1}),
            json!({"tailBytes":1,"tailLines":1}),
            json!({"tailBytes":0}),
            json!({"tailBytes":16385}),
            json!({"tailLines":0}),
            json!({"tailLines":1001}),
            json!({"cursor":-1}),
            json!({"cursor":null}),
            json!({"cursor":0.5}),
            json!({"cursor":9007199254740992u64}),
        ] {
            let mut args = json!({"target":"local","jobId":"job"});
            args.as_object_mut()
                .unwrap()
                .extend(selector.as_object().unwrap().clone());
            assert!(validate("commands.read", &args).is_err(), "{args}");
        }
    }
    #[test]
    fn rejects_unbounded_and_unknown_arguments() {
        assert!(validate(
            "commands.start",
            &serde_json::json!({"target":"local","script":"echo ok","timeoutMs":600001})
        )
        .is_err());
        assert!(validate(
            "commands.start",
            &serde_json::json!({"target":"local","script":"echo ok","approved":true})
        )
        .is_err());
        assert!(validate(
            "commands.start",
            &serde_json::json!({"target":"local","script":"echo ok"})
        )
        .is_ok());
    }

    #[test]
    fn command_capabilities_are_read_only_discovery_without_job_or_shell_authority() {
        use serde_json::json;
        for target in ["local", "remote-device"] {
            let tool = validate("commands.capabilities", &json!({"target":target})).unwrap();
            assert_eq!(tool["scope"], "diagnostics.read");
            assert_eq!(tool["readOnly"], true);
            assert_eq!(tool["native"], true);
        }
        for args in [
            json!({}),
            json!({"target":""}),
            json!({"target":"local","jobId":"job"}),
            json!({"target":"local","signal":"SIGKILL"}),
        ] {
            assert!(validate("commands.capabilities", &args).is_err());
        }
    }
    #[test]
    fn job_send_accepts_bounded_input_eof_or_signal_but_never_ambiguous_actions() {
        use serde_json::json;
        for action in [
            json!({"input":"中文🙂\n"}),
            json!({"input":"x".repeat(16384),"eof":true}),
            json!({"eof":true}),
            json!({"signal":"SIGINT"}),
            json!({"signal":"SIGTERM"}),
            json!({"signal":"SIGKILL"}),
        ] {
            let mut args = json!({"target":"local","jobId":"job"});
            args.as_object_mut()
                .unwrap()
                .extend(action.as_object().unwrap().clone());
            let tool = validate("commands.send", &args).unwrap();
            assert_eq!(tool["scope"], "shell.execute");
            assert_eq!(tool["readOnly"], false);
        }
        for action in [
            json!({}),
            json!({"input":""}),
            json!({"input":"🙂".repeat(16385)}),
            json!({"eof":false}),
            json!({"eof":null}),
            json!({"input":"text","signal":"SIGKILL"}),
            json!({"eof":true,"signal":"SIGTERM"}),
            json!({"signal":"STOP"}),
            json!({"signal":9}),
            json!({"input":"text","extra":true}),
        ] {
            let mut args = json!({"target":"local","jobId":"job"});
            args.as_object_mut()
                .unwrap()
                .extend(action.as_object().unwrap().clone());
            assert!(validate("commands.send", &args).is_err());
        }
        assert!(find("commands.cancel").is_err());
    }
}
