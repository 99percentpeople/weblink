//! Adapt authenticated native tickets to the platform-neutral accessibility API.
use super::*;
use tauri::Manager;
use weblink_desktop_accessibility::{Access, Check, Error, ReadOptions, Request, WaitRequest};

fn request(call: &Call) -> Result<Request, String> {
    let args = &call.arguments;
    let element_id = || args["elementId"].as_str().unwrap_or_default().to_string();
    match call.name.as_str() {
        "accessibility.capabilities" => Ok(Request::Capabilities),
        "accessibility.windows" => Ok(Request::Windows {
            limit: args["limit"].as_u64().unwrap_or(64) as usize,
        }),
        "accessibility.snapshot" => Ok(Request::Snapshot {
            element_id: element_id(),
            max_depth: args["maxDepth"].as_u64().unwrap_or(4) as usize,
            max_nodes: args["maxNodes"].as_u64().unwrap_or(128) as usize,
            options: ReadOptions {
                include_values: args["includeValues"].as_bool().unwrap_or(false),
                max_text_length: args["maxTextLength"].as_u64().unwrap_or(1024) as usize,
            },
        }),
        "accessibility.wait" => Ok(Request::Wait(WaitRequest {
            element_id: element_id(),
            condition: serde_json::from_value(args["condition"].clone())
                .map_err(|_| "INVALID_ARGUMENTS")?,
            timeout_ms: args["timeoutMs"].as_u64().unwrap_or(5000),
            poll_interval_ms: args["pollIntervalMs"].as_u64().unwrap_or(100),
        })),
        "accessibility.action" => Ok(Request::Action {
            element_id: element_id(),
            action: serde_json::from_value(args["action"].clone())
                .map_err(|_| "INVALID_ARGUMENTS")?,
            value: args
                .get("value")
                .map(|v| v.as_str().unwrap_or_default().into()),
            observe_after: args
                .get("observeAfter")
                .map(|v| serde_json::from_value(v.clone()).map_err(|_| "INVALID_ARGUMENTS"))
                .transpose()?,
        }),
        _ => Err("UNSUPPORTED".into()),
    }
}
fn lease(service: &Shared, epoch: String, principal: String, grant: String) -> Check {
    let service = Arc::downgrade(service);
    Arc::new(move || {
        let service = service.upgrade().ok_or(Error::Cancelled)?;
        let s = service.state.lock().unwrap();
        if Service::check(&s, &epoch).is_err()
            || !s.enabled
            || !Service::current(&s)
            || !s.grants.get(&grant).is_some_and(|g| {
                Service::grant_live(&s, g)
                    && g.principal.id == principal
                    && g.target == "local"
                    && g.scopes.iter().any(|scope| scope == "accessibility.read")
            })
        {
            return Err(Error::PermissionDenied);
        }
        Ok(())
    })
}
fn check_ticket(s: &State, epoch: &str, id: &str) -> Result<(), Error> {
    Service::check(s, epoch).map_err(|_| Error::Cancelled)?;
    let ticket = s.tickets.get(id).ok_or(Error::Cancelled)?;
    if ticket.deadline <= Instant::now() {
        return Err(Error::Timeout);
    }
    if !Service::current(s)
        || !Service::call_enabled(s, &ticket.principal, &ticket.call)
        || ticket.call.arguments["target"] != "local"
        || !s.grants.get(&ticket.grant).is_some_and(|g| {
            Service::grant_live(&s, g)
                && g.target == "local"
                && g.principal.id == ticket.principal.id
                && catalog::find(&ticket.call.name)
                    .is_ok_and(|t| g.scopes.iter().any(|v| t["scope"] == *v))
        })
    {
        return Err(Error::PermissionDenied);
    }
    if matches!(
        ticket.call.name.as_str(),
        "accessibility.action" | "control.bindWindow"
    ) && !s.pending.is_empty()
    {
        return Err(Error::ApprovalPending);
    }
    Ok(())
}
pub async fn action(
    app: tauri::AppHandle,
    service: Shared,
    epoch: String,
    id: String,
    turn: Option<super::input_sequence::Turn>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = turn;
        let expected_lease = _turn.as_ref().and_then(|t| t.lease.clone());
        let (call, principal, grant) = {
            let mut s = service.state.lock().unwrap();
            check_ticket(&s, &epoch, &id).map_err(|e| e.code())?;
            let ticket = s.tickets.get_mut(&id).ok_or("CANCELLED")?;
            if ticket.used
                || _turn
                    .as_ref()
                    .is_some_and(|turn| turn.principal != ticket.principal.id)
            {
                return Err("CANCELLED".into());
            }
            ticket.used = true;
            (
                ticket.call.clone(),
                ticket.principal.id.clone(),
                ticket.grant.clone(),
            )
        };
        let window_id = if call.name == "control.bindWindow" {
            Some(
                call.arguments["windowId"]
                    .as_str()
                    .ok_or("INVALID_ARGUMENTS")?
                    .to_string(),
            )
        } else {
            None
        };
        let request = if window_id.is_none() {
            Some(request(&call)?)
        } else {
            None
        };
        let read_lease = lease(&service, epoch.clone(), principal.clone(), grant);
        let weak = Arc::downgrade(&service);
        let owner = format!("{epoch}:{principal}");
        let native_app = app.clone();
        let bind_epoch = epoch.clone();
        let bind_id = id.clone();
        let bind_principal = principal.clone();
        let bind_lease = expected_lease.clone();
        let check: Check = Arc::new(move || {
            let service = weak.upgrade().ok_or(Error::Cancelled)?;
            let s = service.state.lock().unwrap();
            check_ticket(&s, &epoch, &id)?;
            if matches!(
                call.name.as_str(),
                "accessibility.action" | "control.bindWindow"
            ) && (!s.input_owners.contains(&principal)
                || !expected_lease.as_ref().is_some_and(|lease| {
                    app.state::<crate::remote_control::Shared>()
                        .automation_matches(&principal, lease)
                }))
            {
                return Err(Error::ControlRequired);
            }
            Ok(())
        });
        let access = Access {
            owner,
            check,
            lease: read_lease,
        };
        if let Some(window_id) = window_id {
            let window = service
                .accessibility
                .bind_window(window_id.clone(), access)
                .map_err(|e| e.code())?;
            let s = service.state.lock().unwrap();
            super::input_sequence::check(&s, &bind_epoch, &bind_id)?;
            let lease = bind_lease.ok_or("CONTROL_REQUIRED")?;
            if service.input_holds.lock().unwrap().any(&lease) {
                return Err("INPUT_HELD".into());
            }
            native_app
                .state::<crate::remote_control::Shared>()
                .automation_bind_window(&bind_principal, &lease, window)?;
            Ok(json!({"bound":true,"windowId":window_id,"focusPolicy":"stopOnBlur"}))
        } else {
            service
                .accessibility
                .call(request.ok_or("INVALID_ARGUMENTS")?, access)
                .map_err(|e| e.code().to_string())
        }
    })
    .await
    .map_err(|_| "EXECUTION_FAILED".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_adapter_preserves_content_wait_and_follow_up_options() {
        let call = |name: &str, arguments: Value| Call {
            source: None,
            name: name.into(),
            arguments,
        };
        let Request::Snapshot { options, .. } = request(&call(
            "accessibility.snapshot",
            json!({
                "elementId":"root","includeValues":true,"maxTextLength":123,
            }),
        ))
        .unwrap() else {
            panic!()
        };
        assert!(options.include_values);
        assert_eq!(options.max_text_length, 123);
        let Request::Wait(wait) = request(&call(
            "accessibility.wait",
            json!({
                "elementId":"root","condition":{"toggleState":"on","enabled":true},
                "timeoutMs":15000,"pollIntervalMs":250,
            }),
        ))
        .unwrap() else {
            panic!()
        };
        assert_eq!(wait.timeout_ms, 15000);
        assert_eq!(wait.poll_interval_ms, 250);
        wait.validate().unwrap();
        let Request::Action { observe_after, .. } = request(&call("accessibility.action", json!({
            "elementId":"button","action":"invoke","observeAfter":{"elementId":"root","includeValues":true},
        }))).unwrap() else { panic!() };
        let observation = observe_after.unwrap();
        assert_eq!(observation.element_id.as_deref(), Some("root"));
        assert!(observation.include_values);
        assert!(request(&call(
            "accessibility.wait",
            json!({"condition":{"unexpected":true}})
        ))
        .is_err());
    }
    #[test]
    fn native_ticket_checks_scope_target_revocation_and_pending_review() {
        let principal = Principal {
            id: "caller".into(),
            label: "Test".into(),
            kind: "mcp".into(),
            generation: None,
        };
        let mut s = State {
            enabled: true,
            mcp_enabled: true,
            epoch: "epoch".into(),
            ..Default::default()
        };
        s.registry.clients.insert(
            principal.id.clone(),
            registry::Client {
                id: principal.id.clone(),
                label: principal.label.clone(),
                token_hash: registry::digest("test"),
                prefix: "test".into(),
                created_at: now(),
                expires_at: None,
            },
        );
        s.grants.insert(
            "grant".into(),
            Grant {
                id: "grant".into(),
                target: "local".into(),
                principal: principal.clone(),
                scopes: vec!["accessibility.read".into()],
                expires_at: Some(now() + 60000),
                source: GrantSource::Token,
            },
        );
        s.tickets.insert(
            "ticket".into(),
            Ticket {
                principal: principal.clone(),
                call: Call {
                    source: None,
                    name: "accessibility.action".into(),
                    arguments: json!({"target":"local","elementId":"opaque","action":"invoke"}),
                },
                grant: "grant".into(),
                used: true,
                deadline: Instant::now() + Duration::from_secs(30),
                answer: oneshot::channel().0,
            },
        );
        assert_eq!(
            check_ticket(&s, "epoch", "ticket"),
            Err(Error::PermissionDenied)
        );
        s.grants.get_mut("grant").unwrap().scopes = vec!["input.control".into()];
        assert!(check_ticket(&s, "epoch", "ticket").is_ok());
        s.grants.get_mut("grant").unwrap().target = "peer".into();
        assert_eq!(
            check_ticket(&s, "epoch", "ticket"),
            Err(Error::PermissionDenied)
        );
        s.grants.get_mut("grant").unwrap().target = "local".into();
        s.pending.insert(
            "review".into(),
            Pending {
                principal,
                call: s.tickets["ticket"].call.clone(),
                scope: "input.control".into(),
                deadline: Instant::now() + Duration::from_secs(30),
                answer: oneshot::channel().0,
            },
        );
        assert_eq!(
            check_ticket(&s, "epoch", "ticket"),
            Err(Error::ApprovalPending)
        );
        s.pending.clear();
        s.grants.clear();
        assert_eq!(
            check_ticket(&s, "epoch", "ticket"),
            Err(Error::PermissionDenied)
        );
    }
}
