//! Follow-up reads must never turn an acknowledged side effect into a failed action.
use crate::*;
use serde_json::{json, Value};

pub(crate) fn complete(mut result: Value, read: impl FnOnce(Request) -> Result<Value>) -> Value {
    let Some(options) = result
        .as_object_mut()
        .and_then(|v| v.remove("_observation"))
    else {
        return result;
    };
    let observation = (|| {
        let options: Observation =
            serde_json::from_value(options).map_err(|_| Error::InvalidArguments)?;
        options.validate()?;
        read(Request::Snapshot {
            element_id: options.element_id.clone().ok_or(Error::InvalidArguments)?,
            max_depth: options.max_depth,
            max_nodes: options.max_nodes,
            options: options.read_options(),
        })
    })();
    match observation {
        Ok(snapshot) => {
            result["observation"] = snapshot;
            result["refreshRequired"] = json!(false);
        }
        Err(error) => {
            result["refreshRequired"] = json!(true);
            result["observationError"] = json!({
                "code":error.code(),
                "message":"The action was applied, but its follow-up observation was unavailable. Read the UI before any retry.",
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn applied() -> Value {
        json!({"applied":true,"refreshRequired":true,"_observation":{"elementId":"new-root","includeValues":true}})
    }
    #[test]
    fn observation_failures_preserve_applied_and_remove_internal_request() {
        for error in [
            Error::Timeout,
            Error::PermissionDenied,
            Error::Cancelled,
            Error::StaleElement,
        ] {
            let result = complete(applied(), |_| Err(error));
            assert_eq!(result["applied"], true);
            assert_eq!(result["refreshRequired"], true);
            assert_eq!(result["observationError"]["code"], error.code());
            assert!(result.get("_observation").is_none());
            assert!(result.get("observation").is_none());
        }
    }
    #[test]
    fn successful_observation_supplies_the_new_snapshot_without_another_refresh() {
        let result = complete(applied(), |request| {
            let Request::Snapshot {
                element_id,
                options,
                ..
            } = request
            else {
                panic!()
            };
            assert_eq!(element_id, "new-root");
            assert!(options.include_values);
            Ok(json!({"nodes":[{"elementId":"new-node"}]}))
        });
        assert_eq!(result["applied"], true);
        assert_eq!(result["refreshRequired"], false);
        assert_eq!(result["observation"]["nodes"][0]["elementId"], "new-node");
        assert!(result.get("_observation").is_none());
    }
}
