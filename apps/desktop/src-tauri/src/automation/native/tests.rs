use super::*;
use crate::remote_control::{
    with_bound_borrowed_input, with_bound_owned_input, with_interruptible_input, InputInterruption,
};
use weblink_desktop_input::input::{Event, ScanCode};

fn authority(session_consent: bool) -> Service {
    let principal = Principal {
        id: "client".into(),
        label: "Peer".into(),
        kind: "peer".into(),
        generation: Some("connection".into()),
    };
    let service = Service::default();
    {
        let mut s = service.state.lock().unwrap();
        s.enabled = true;
        s.epoch = "epoch".into();
        s.peers.insert(principal.id.clone(), principal.clone());
        s.peer_policies.insert(
            principal.id.clone(),
            HashMap::from([
                ("input.control".into(), policy::Decision::Allow),
                ("diagnostics.read".into(), policy::Decision::Allow),
                ("shell.execute".into(), policy::Decision::Allow),
            ]),
        );
        for scope in ["input.control", "diagnostics.read"] {
            s.grants.insert(
                scope.into(),
                Grant {
                    id: scope.into(),
                    principal: principal.clone(),
                    target: "local".into(),
                    scopes: vec![scope.into()],
                    expires_at: None,
                    source: if session_consent && scope == "input.control" {
                        GrantSource::Consent
                    } else {
                        GrantSource::Policy
                    },
                },
            );
        }
        s.input_owners.push(principal.id.clone());
    }
    service
}

#[test]
fn owned_window_blur_keeps_mcp_authority_and_releases_the_input_lease() {
    for cleanup_first in [false, true] {
        with_bound_owned_input(|control, lease, focus| {
            let (service, principal) = super::super::tests::fixture();
            {
                let mut s = service.state.lock().unwrap();
                Service::token_grant(&mut s, &principal, &json!("local")).unwrap();
                s.input_owners.push(principal.id.clone());
            }
            let events = [Event::Key {
                key: ScanCode::new(0x1d, false).unwrap(),
                down: true,
            }];
            service
                .input_holds
                .lock()
                .unwrap()
                .update("client", lease, &events, Instant::now());
            control
                .automation_input("client", lease, events.to_vec())
                .unwrap();
            let grants = serde_json::to_value(&service.state.lock().unwrap().grants).unwrap();
            focus(false);
            if cleanup_first {
                super::super::input_action::abort_lease(&service, control, "client", lease);
            }
            sync_input_control(&service, control);
            focus(true);
            sync_input_control(&service, control);
            let mut s = service.state.lock().unwrap();
            assert!(
                !s.mcp_suspended,
                "Window blur must not suspend the MCP token"
            );
            Service::token_grant(&mut s, &principal, &json!("local")).unwrap();
            assert!(!s.policies_suspended);
            assert_eq!(serde_json::to_value(&s.grants).unwrap(), grants);
            assert!(s.input_owners.is_empty());
            assert!(!control.automation_active("client"));
            assert!(!service.input_holds.lock().unwrap().any(lease));
        });
    }
}

#[test]
fn owned_window_blur_cannot_hide_a_real_emergency() {
    for cleanup_first in [false, true] {
        with_bound_owned_input(|control, lease, focus| {
            let service = authority(false);
            control.observe_emergency(service.emergency_observer());
            focus(false);
            if cleanup_first {
                super::super::input_action::abort_lease(&service, control, "client", lease);
            }
            control.emergency_revoke();
            sync_input_control(&service, control);
            let s = service.state.lock().unwrap();
            assert!(s.mcp_suspended);
            assert!(s.policies_suspended);
            assert!(s.grants.is_empty());
            assert!(s.input_owners.is_empty());
        });
    }
}

#[test]
fn native_sampler_keeps_the_same_lease_and_permissions_without_renderer_heartbeats() {
    with_bound_borrowed_input(|control, lease, _| {
        let service = authority(false);
        let grants = serde_json::to_value(&service.state.lock().unwrap().grants).unwrap();
        // Only the native sampler runs. No frontend heartbeat or reacquire is needed.
        for _ in 0..30 {
            sync_input_control(&service, control);
            assert!(control.automation_matches("client", lease));
            let s = service.state.lock().unwrap();
            assert!(Service::check(&s, "epoch").is_ok());
            assert!(Service::current(&s));
            assert_eq!(serde_json::to_value(&s.grants).unwrap(), grants);
            assert_eq!(s.input_owners, vec!["client"]);
        }
        control
            .automation_input("client", lease, vec![Event::Text("background".into())])
            .unwrap();
        control.observe_emergency(service.emergency_observer());
        control.emergency_revoke();
        sync_input_control(&service, control);
        assert!(!control.automation_active("client"));
        let s = service.state.lock().unwrap();
        assert!(s.grants.is_empty());
        assert!(s.policies_suspended);
    });
}

#[test]
fn local_switch_releases_input_and_holds_while_mcp_remains_enabled() {
    with_bound_borrowed_input(|control, lease, _| {
        let service = authority(false);
        let events = [Event::Key {
            key: ScanCode::new(0x1d, false).unwrap(),
            down: true,
        }];
        service
            .input_holds
            .lock()
            .unwrap()
            .update("client", lease, &events, Instant::now());
        control
            .automation_input("client", lease, events.to_vec())
            .unwrap();
        {
            let mut s = service.state.lock().unwrap();
            s.mcp_enabled = true;
            service.configure_locked(&mut s, false, false);
        }
        sync_input_control(&service, control);
        assert!(!control.automation_active("client"));
        assert!(!service.input_holds.lock().unwrap().any(lease));
        let s = service.state.lock().unwrap();
        assert!(s.mcp_enabled);
        assert!(!s.policies_suspended);
        assert!(!s.mcp_suspended);
        assert!(s.input_owners.is_empty());
    });
}

#[test]
fn borrowed_blur_heartbeat_clears_lease_and_holds_but_preserves_all_permissions() {
    for session_consent in [false, true] {
        with_bound_borrowed_input(|control, lease, focus| {
            let service = authority(session_consent);
            let events = [Event::Key {
                key: ScanCode::new(0x1d, false).unwrap(),
                down: true,
            }];
            service
                .input_holds
                .lock()
                .unwrap()
                .update("client", lease, &events, Instant::now());
            control
                .automation_input("client", lease, events.to_vec())
                .unwrap();
            sync_input_control(&service, control);
            assert_eq!(service.state.lock().unwrap().input_owners, vec!["client"]);
            let grants = serde_json::to_value(&service.state.lock().unwrap().grants).unwrap();

            focus(false);
            sync_input_control(&service, control);
            assert!(!control.automation_active("client"));
            assert!(!service.input_holds.lock().unwrap().any(lease));
            assert_eq!(
                service.input_holds.lock().unwrap().result(lease)["holdExpiresInMs"],
                Value::Null
            );
            focus(true);
            assert_eq!(
                control.automation_input("client", lease, vec![Event::Text("stale".into())]),
                Err("CONTROL_REQUIRED".into())
            );
            // A later heartbeat must not mistake the retired scope for an emergency stop.
            sync_input_control(&service, control);
            let s = service.state.lock().unwrap();
            assert!(s.input_owners.is_empty());
            assert!(!s.policies_suspended);
            assert_eq!(serde_json::to_value(&s.grants).unwrap(), grants);
            assert!(s
                .grants
                .values()
                .all(|grant| Service::grant_live(&s, grant)));
            for scope in ["input.control", "diagnostics.read"] {
                assert!(
                    Service::peer_decision(&s, &s.peers["client"], scope)
                        == policy::Decision::Allow
                );
            }
        });
    }
}

#[test]
fn ended_borrowed_lease_preserves_permissions_even_when_the_window_blurs() {
    with_bound_borrowed_input(|control, _, focus| {
        let service = authority(false);
        focus(false);
        control.automation_release("client");
        sync_input_control(&service, control);
        let s = service.state.lock().unwrap();
        assert!(s.input_owners.is_empty());
        assert!(!s.policies_suspended);
        assert!(!s.mcp_suspended);
        assert_eq!(s.grants.len(), 2);
    });
}

#[test]
fn hold_timeout_releases_input_without_suspending_permanent_permissions() {
    with_bound_borrowed_input(|control, lease, _| {
        let service = authority(false);
        control.observe_emergency(service.emergency_observer());
        let events = [Event::Key {
            key: ScanCode::new(0x1d, false).unwrap(),
            down: true,
        }];
        service.input_holds.lock().unwrap().update(
            "client",
            lease,
            &events,
            Instant::now() - input_holds::HOLD_LIMIT,
        );
        control
            .automation_input("client", lease, events.to_vec())
            .unwrap();
        sync_input_control(&service, control);
        assert!(!control.automation_active("client"));
        assert!(!service.input_holds.lock().unwrap().any(lease));
        let s = service.state.lock().unwrap();
        assert!(s.input_owners.is_empty());
        assert!(!s.policies_suspended);
        assert!(!s.mcp_suspended);
        assert_eq!(s.grants.len(), 2);
    });
}

#[test]
fn native_lease_interruptions_preserve_peer_and_mcp_authority() {
    for borrowed in [false, true] {
        for interruption in [
            InputInterruption::CaptureEnded,
            InputInterruption::InputInterrupted,
            InputInterruption::ControlReleased,
        ] {
            for before_sampler in [false, true] {
                with_interruptible_input(borrowed, |control, lease, interrupt| {
                    let service = authority(false);
                    control.observe_emergency(service.emergency_observer());
                    let events = [Event::Key {
                        key: ScanCode::new(0x1d, false).unwrap(),
                        down: true,
                    }];
                    service.input_holds.lock().unwrap().update(
                        "client",
                        lease,
                        &events,
                        Instant::now(),
                    );
                    control
                        .automation_input("client", lease, events.to_vec())
                        .unwrap();
                    let grants =
                        serde_json::to_value(&service.state.lock().unwrap().grants).unwrap();
                    interrupt(interruption);
                    if before_sampler {
                        // control.acquire/control.release can observe the end before the sampler.
                        let mut s = service.state.lock().unwrap();
                        assert!(retire_input_interruption(&service, control, "client"));
                        s.input_owners.clear();
                    }
                    sync_input_control(&service, control);
                    sync_input_control(&service, control);
                    assert!(!control.automation_active("client"));
                    assert!(control
                        .automation_input("client", lease, vec![Event::Text("stale".into())])
                        .is_err());
                    assert!(!service.input_holds.lock().unwrap().any(lease));
                    let mut s = service.state.lock().unwrap();
                    assert!(s.input_owners.is_empty());
                    assert!(
                        !s.policies_suspended,
                        "{interruption:?}, borrowed={borrowed}"
                    );
                    assert!(!s.mcp_suspended);
                    assert_eq!(serde_json::to_value(&s.grants).unwrap(), grants);
                    let peer = s.peers["client"].clone();
                    for scope in ["input.control", "diagnostics.read", "shell.execute"] {
                        assert!(
                            Service::peer_decision(&s, &peer, scope) == policy::Decision::Allow
                        );
                        Service::policy_grant(&mut s, &peer, scope);
                        assert!(s
                            .grants
                            .values()
                            .any(|g| g.scopes.iter().any(|v| v == scope)
                                && Service::grant_live(&s, g)));
                    }
                    assert!(s.pending.is_empty());
                });
                with_interruptible_input(borrowed, |control, lease, interrupt| {
                    let (service, token) = super::super::tests::fixture();
                    control.observe_emergency(service.emergency_observer());
                    {
                        let mut s = service.state.lock().unwrap();
                        Service::token_grant(&mut s, &token, &json!("local")).unwrap();
                        s.input_owners.push(token.id.clone());
                    }
                    interrupt(interruption);
                    if before_sampler {
                        let mut s = service.state.lock().unwrap();
                        assert!(retire_input_interruption(&service, control, "client"));
                        s.input_owners.clear();
                    }
                    sync_input_control(&service, control);
                    let mut s = service.state.lock().unwrap();
                    assert!(!s.mcp_suspended);
                    Service::token_grant(&mut s, &token, &json!("local")).unwrap();
                    assert!(s.input_owners.is_empty());
                    assert!(!control.automation_matches("client", lease));
                });
            }
        }
    }
}

#[tokio::test]
async fn permanent_allow_dispatches_without_a_new_review_after_capture_ends() {
    let service = Arc::new(authority(false));
    let (sent, mut events) = tokio::sync::mpsc::unbounded_channel::<Value>();
    service.state.lock().unwrap().channel = Some(Channel::new(move |body| {
        let tauri::ipc::InvokeResponseBody::Json(body) = body else {
            panic!("expected JSON")
        };
        let _ = sent.send(serde_json::from_str(&body).unwrap());
        Ok(())
    }));
    with_interruptible_input(true, |control, _, interrupt| {
        control.observe_emergency(service.emergency_observer());
        interrupt(InputInterruption::CaptureEnded);
        sync_input_control(&service, control);
    });
    let peer = service.state.lock().unwrap().peers["client"].clone();
    for name in [
        "diagnostics.snapshot",
        "commands.capabilities",
        "control.acquire",
    ] {
        let arguments = if name == "control.acquire" {
            json!({"target":"local", "trackId":"new-capture"})
        } else {
            json!({"target":"local"})
        };
        let call = Call {
            name: name.into(),
            source: None,
            arguments,
        };
        let request = tokio::spawn(service.clone().invoke(peer.clone(), name.into(), call));
        let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["kind"], "call");
        assert_eq!(event["call"]["name"], name);
        let mut s = service.state.lock().unwrap();
        assert!(s.pending.is_empty());
        assert!(Service::check_call(&s, "epoch", name).is_ok());
        // The frontend/native executor still validates the new capture for acquire.
        s.tickets
            .remove(name)
            .unwrap()
            .answer
            .send(json!({"ok": true}))
            .unwrap();
        drop(s);
        assert_eq!(request.await.unwrap(), json!({"ok": true}));
    }
}

#[test]
fn input_cleanup_does_not_hide_an_earlier_external_revoke() {
    with_bound_borrowed_input(|control, lease, _| {
        let service = authority(false);
        control.observe_emergency(service.emergency_observer());
        control.emergency_revoke();
        super::super::input_action::abort_lease(&service, control, "client", lease);
        assert_eq!(service.state.lock().unwrap().input_owners, vec!["client"]);
        sync_input_control(&service, control);
        let s = service.state.lock().unwrap();
        assert!(s.policies_suspended);
        assert!(s.grants.is_empty());
    });
}

#[test]
fn input_cleanup_on_blur_preserves_permissions_before_or_after_heartbeat() {
    for heartbeat_first in [false, true] {
        with_bound_borrowed_input(|control, lease, focus| {
            let service = authority(true);
            focus(false);
            if heartbeat_first {
                sync_input_control(&service, control);
            }
            super::super::input_action::abort_lease(&service, control, "client", lease);
            sync_input_control(&service, control);
            let s = service.state.lock().unwrap();
            assert!(!s.policies_suspended);
            assert_eq!(s.grants.len(), 2);
            assert!(s.input_owners.is_empty());
        });
    }
}

#[test]
fn shared_emergency_survives_cleanup_in_either_order_including_blur() {
    for cleanup_first in [false, true] {
        with_bound_borrowed_input(|control, lease, focus| {
            let service = authority(true);
            control.observe_emergency(service.emergency_observer());
            let events = [Event::Key {
                key: ScanCode::new(0x1d, false).unwrap(),
                down: true,
            }];
            service
                .input_holds
                .lock()
                .unwrap()
                .update("client", lease, &events, Instant::now());
            control
                .automation_input("client", lease, events.to_vec())
                .unwrap();
            focus(false);
            if cleanup_first {
                super::super::input_action::abort_lease(&service, control, "client", lease);
            }
            control.emergency_revoke();
            // The hook signal fences authorization before the asynchronous sampler runs.
            {
                let s = service.state.lock().unwrap();
                assert!(!Service::current(&s));
                assert!(s.grants.values().all(|g| !Service::grant_live(&s, g)));
            }
            if !cleanup_first {
                super::super::input_action::abort_lease(&service, control, "client", lease);
            }
            sync_input_control(&service, control);
            let s = service.state.lock().unwrap();
            assert!(s.policies_suspended);
            assert!(s.grants.is_empty());
            assert!(s.input_owners.is_empty());
            assert!(!service.input_holds.lock().unwrap().any(lease));
        });
    }
}

#[test]
fn shared_emergency_cancels_pending_reviews_and_cannot_reapply_allow_policies() {
    let service = authority(true);
    let principal = service.state.lock().unwrap().peers["client"].clone();
    let (answer, mut response) = oneshot::channel();
    service.state.lock().unwrap().pending.insert(
        "review".into(),
        Pending {
            principal: principal.clone(),
            call: Call {
                name: "diagnostics.snapshot".into(),
                source: None,
                arguments: json!({"target":"local"}),
            },
            scope: "diagnostics.read".into(),
            deadline: Instant::now() + Duration::from_secs(30),
            answer,
        },
    );
    let stop = service.emergency_observer();
    stop();
    service.expire();
    assert!(matches!(
        response.try_recv(),
        Err(oneshot::error::TryRecvError::Closed)
    ));
    let saved = service.state.lock().unwrap().peer_policies["client"].clone();
    service
        .set_peer_policy("epoch", &peers::Identity::from(&principal), saved)
        .unwrap();
    let s = service.state.lock().unwrap();
    assert!(s.grants.is_empty());
    assert!(s.pending.is_empty());
    assert!(Service::peer_decision(&s, &principal, "input.control") == policy::Decision::Ask);
}
