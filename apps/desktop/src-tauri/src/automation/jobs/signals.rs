//! One source of truth for capability discovery and accepted job signals.
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Signal {
    Interrupt,
    Terminate,
    Kill,
}

impl Signal {
    fn supported() -> &'static [Self] {
        #[cfg(windows)]
        return &[Self::Terminate, Self::Kill];
        #[cfg(unix)]
        return &[Self::Interrupt, Self::Terminate, Self::Kill];
    }

    pub(super) fn parse(name: &str) -> Result<Self, &'static str> {
        let signal = match name {
            "SIGINT" => Self::Interrupt,
            "SIGTERM" => Self::Terminate,
            "SIGKILL" => Self::Kill,
            _ => return Err("INVALID_ARGUMENTS"),
        };
        if Self::supported().contains(&signal) {
            Ok(signal)
        } else {
            Err("UNSUPPORTED_SIGNAL")
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Interrupt => "SIGINT",
            Self::Terminate => "SIGTERM",
            Self::Kill => "SIGKILL",
        }
    }

    fn semantics(self) -> &'static str {
        match self {
            Self::Kill => "terminate-process-tree",
            _ if cfg!(windows) => "terminate-process-tree",
            Self::Interrupt => "interrupt-process-group",
            Self::Terminate => "terminate-process-group",
        }
    }
}

pub fn capabilities() -> Value {
    let signals = Signal::supported();
    let semantics: serde_json::Map<String, Value> = signals
        .iter()
        .map(|signal| (signal.name().into(), json!(signal.semantics())))
        .collect();
    json!({
        "supported": true,
        "transport": "pipe",
        "stdin": true,
        "eof": true,
        "pty": false,
        "supportedSignals": signals.iter().map(|signal| signal.name()).collect::<Vec<_>>(),
        "signalSemantics": semantics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_match_platform_delivery_and_shared_tool_contract() {
        let result = capabilities();
        assert!(jsonschema::is_valid(
            &crate::automation::catalog::find("commands.capabilities").unwrap()["outputSchema"],
            &json!({"ok":true,"data":result}),
        ));
        assert_eq!(result["transport"], "pipe");
        assert_eq!(result["pty"], false);
        assert_eq!(result["stdin"], true);
        assert_eq!(result["eof"], true);
        #[cfg(windows)]
        assert_eq!(result["supportedSignals"], json!(["SIGTERM", "SIGKILL"]));
        #[cfg(unix)]
        assert_eq!(
            result["supportedSignals"],
            json!(["SIGINT", "SIGTERM", "SIGKILL"])
        );
        for name in ["SIGINT", "SIGTERM", "SIGKILL"] {
            let advertised = result["supportedSignals"]
                .as_array()
                .unwrap()
                .contains(&json!(name));
            assert_eq!(Signal::parse(name).is_ok(), advertised);
            assert_eq!(result["signalSemantics"].get(name).is_some(), advertised);
            if advertised {
                assert!(crate::automation::catalog::validate(
                    "commands.send",
                    &json!({"target":"local","jobId":"job","signal":name})
                )
                .is_ok());
            }
        }
        assert_eq!(
            result["signalSemantics"]["SIGKILL"],
            "terminate-process-tree"
        );
        assert_eq!(
            result["signalSemantics"]["SIGTERM"],
            if cfg!(windows) {
                "terminate-process-tree"
            } else {
                "terminate-process-group"
            }
        );
        #[cfg(unix)]
        assert_eq!(
            result["signalSemantics"]["SIGINT"],
            "interrupt-process-group"
        );
        assert_eq!(Signal::parse("SIGSTOP"), Err("INVALID_ARGUMENTS"));
    }
}
