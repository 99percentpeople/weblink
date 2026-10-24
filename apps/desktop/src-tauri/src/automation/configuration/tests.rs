use super::*;
use crate::automation::tests::fixture;

fn peer() -> Principal {
    Principal {
        id: "peer".into(),
        label: "Peer".into(),
        kind: "peer".into(),
        generation: Some("connection".into()),
    }
}
fn call(name: &str, target: &str) -> Call {
    Call {
        source: None,
        name: name.into(),
        arguments: json!({"target":target}),
    }
}
fn install(
    s: &mut State,
    principal: Principal,
    id: &str,
    target: &str,
) -> oneshot::Receiver<Value> {
    let (answer, result) = oneshot::channel();
    s.grants.insert(
        id.into(),
        Grant {
            id: id.into(),
            target: target.into(),
            principal: principal.clone(),
            scopes: vec!["diagnostics.read".into()],
            expires_at: Some(now() + 60_000),
            source: if principal.kind == "mcp" {
                GrantSource::Token
            } else {
                GrantSource::Consent
            },
        },
    );
    s.requests.insert(
        id.into(),
        Invocation {
            generation: id.into(),
            mcp: principal.kind == "mcp",
            local: target == "local",
        },
    );
    s.tickets.insert(
        id.into(),
        Ticket {
            principal,
            call: call("diagnostics.snapshot", target),
            grant: id.into(),
            deadline: Instant::now() + Duration::from_secs(60),
            answer,
            used: false,
        },
    );
    result
}

#[tokio::test]
async fn independent_switches_gate_native_dispatch_and_discovery() {
    for enabled in [false, true] {
        for mcp_enabled in [false, true] {
            let (service, token) = fixture();
            let peer = peer();
            {
                let mut s = service.state.lock().unwrap();
                s.enabled = enabled;
                s.mcp_enabled = mcp_enabled;
                s.peers.insert(peer.id.clone(), peer.clone());
                s.peer_policies.insert(
                    peer.id.clone(),
                    HashMap::from([("diagnostics.read".into(), policy::Decision::Allow)]),
                );
            }
            assert_eq!(service.authenticate("test-token").is_some(), mcp_enabled);
            for (principal, name, target, allowed) in [
                (
                    token.clone(),
                    "diagnostics.snapshot",
                    "local",
                    enabled && mcp_enabled,
                ),
                (token.clone(), "devices.list", "local", mcp_enabled),
                (token.clone(), "diagnostics.snapshot", "remote", mcp_enabled),
                (peer.clone(), "diagnostics.snapshot", "local", enabled),
            ] {
                let task = tokio::spawn(service.clone().invoke(
                    principal,
                    "request".into(),
                    call(name, target),
                ));
                if allowed {
                    tokio::time::timeout(Duration::from_secs(3), async {
                        loop {
                            {
                                let mut s = service.state.lock().unwrap();
                                if s.tickets.contains_key("request") {
                                    assert!(Service::check_call(&s, "epoch", "request").is_ok());
                                    s.tickets
                                        .remove("request")
                                        .unwrap()
                                        .answer
                                        .send(json!({"ok":true}))
                                        .unwrap();
                                    break;
                                }
                            }
                            tokio::task::yield_now().await;
                        }
                    })
                    .await
                    .unwrap();
                }
                let result = tokio::time::timeout(Duration::from_secs(3), task)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    result["ok"], allowed,
                    "{enabled}/{mcp_enabled}: {name} {target}: {result}"
                );
                if !allowed {
                    assert_eq!(result["error"]["code"], "DISABLED");
                }
            }
        }
    }
}

#[test]
fn disabling_local_automation_keeps_mcp_forwarding_and_cancels_only_local_work() {
    let (service, token) = fixture();
    let peer = peer();
    let mut s = service.state.lock().unwrap();
    s.peers.insert(peer.id.clone(), peer.clone());
    let listener = CancellationToken::new();
    s.listener = Some(listener.clone());
    let mut local = install(&mut s, token.clone(), "local", "local");
    let mut remote = install(&mut s, token, "remote", "remote");
    let mut incoming = install(&mut s, peer, "peer", "local");
    s.requests.insert(
        "undispatched".into(),
        Invocation {
            generation: "g".into(),
            mcp: false,
            local: true,
        },
    );
    service.configure_locked(&mut s, false, false);
    assert!(!s.enabled);
    assert!(s.mcp_enabled);
    assert!(!listener.is_cancelled());
    assert!(Service::check_call(&s, "epoch", "remote").is_ok());
    assert!(!s.requests.contains_key("undispatched"));
    assert!(matches!(
        local.try_recv(),
        Err(oneshot::error::TryRecvError::Closed)
    ));
    assert!(matches!(
        incoming.try_recv(),
        Err(oneshot::error::TryRecvError::Closed)
    ));
    assert!(matches!(
        remote.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    service.configure_locked(&mut s, false, true);
    assert!(!s.tickets.contains_key("local"));
    assert!(!s.tickets.contains_key("peer"));
}

#[test]
fn disabling_mcp_preserves_incoming_peer_authority_and_cancels_all_token_work() {
    let (service, token) = fixture();
    let peer = peer();
    let mut s = service.state.lock().unwrap();
    s.peers.insert(peer.id.clone(), peer.clone());
    let listener = CancellationToken::new();
    s.listener = Some(listener.clone());
    let mut local = install(&mut s, token.clone(), "local", "local");
    let mut remote = install(&mut s, token, "remote", "remote");
    let mut incoming = install(&mut s, peer, "peer", "local");
    s.requests.insert(
        "undispatched".into(),
        Invocation {
            generation: "g".into(),
            mcp: true,
            local: false,
        },
    );
    service.configure_locked(&mut s, true, false);
    assert!(s.enabled);
    assert!(!s.mcp_enabled);
    assert!(listener.is_cancelled());
    assert!(!s.requests.contains_key("undispatched"));
    assert!(Service::check_call(&s, "epoch", "peer").is_ok());
    assert!(matches!(
        local.try_recv(),
        Err(oneshot::error::TryRecvError::Closed)
    ));
    assert!(matches!(
        remote.try_recv(),
        Err(oneshot::error::TryRecvError::Closed)
    ));
    assert!(matches!(
        incoming.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
}

#[test]
fn mcp_only_emergency_stop_fences_forwarding_and_switches_resume_their_own_authority() {
    let (service, token) = fixture();
    let stop = service.emergency_observer();
    let mut s = service.state.lock().unwrap();
    s.enabled = false;
    let mut remote = install(&mut s, token, "remote", "remote");
    stop();
    assert!(Service::check_call(&s, "epoch", "remote").is_err());
    service.consume_emergency(&mut s);
    assert!(s.mcp_suspended);
    assert!(matches!(
        remote.try_recv(),
        Err(oneshot::error::TryRecvError::Closed)
    ));
    service.configure_locked(&mut s, false, true);
    assert!(!s.policies_suspended);
    assert!(s.mcp_suspended);
    s.policies_suspended = true;
    service.configure_locked(&mut s, true, false);
    service.configure_locked(&mut s, true, true);
    assert!(!s.mcp_suspended);
    assert!(s.policies_suspended);
}
