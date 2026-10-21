use super::*;
use crate::automation::tests::fixture;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

fn connected() -> (Shared, Principal, UnboundedReceiver<Value>) {
    let (service, principal) = fixture();
    let (send, receive) = unbounded_channel();
    service.state.lock().unwrap().channel = Some(Channel::new(move |body| {
        let tauri::ipc::InvokeResponseBody::Json(body) = body else {
            panic!("expected JSON");
        };
        send.send(serde_json::from_str(&body).unwrap()).unwrap();
        Ok(())
    }));
    (service, principal, receive)
}

fn call(target: &str) -> Call {
    Call {
        source: None,
        name: "diagnostics.snapshot".into(),
        arguments: json!({"target":target}),
    }
}

async fn next_call(receive: &mut UnboundedReceiver<Value>) -> Value {
    let event = tokio::time::timeout(Duration::from_secs(3), receive.recv())
        .await
        .expect("a valid token must dispatch without asking for consent")
        .unwrap();
    assert_eq!(event["kind"], "call");
    event
}

#[tokio::test]
async fn token_dispatches_local_and_multiple_remote_targets_without_consent() {
    let (service, principal, mut receive) = connected();
    for target in ["local", "first-device", "second-device", "local"] {
        let task = tokio::spawn(service.clone().invoke(
            principal.clone(),
            "request".into(),
            call(target),
        ));
        let event = next_call(&mut receive).await;
        assert_eq!(event["call"]["arguments"]["target"], target);
        assert_eq!(event["call"]["source"]["kind"], "mcp");
        {
            let mut s = service.state.lock().unwrap();
            assert!(s.pending.is_empty());
            assert!(Service::check_call(&s, "epoch", "request").is_ok());
            s.tickets
                .remove("request")
                .unwrap()
                .answer
                .send(json!({"ok":true,"data":{}}))
                .unwrap();
        }
        assert_eq!(task.await.unwrap()["ok"], true);
    }
    let s = service.state.lock().unwrap();
    assert_eq!(s.grants.len(), 2);
    let forwarding = s.grants.values().find(|g| g.target == "*").unwrap();
    assert!(!forwarding.covers_target(&json!("local")));
    assert!(s.grants.values().all(|g| g.expires_at.is_none()));
}

#[tokio::test]
async fn token_reuses_authority_for_local_commands_and_output_reads() {
    let (service, principal, mut receive) = connected();
    let mut grant = None;
    for (name, arguments) in [
        (
            "commands.start",
            json!({"target":"local","script":"echo ok"}),
        ),
        ("commands.read", json!({"target":"local","jobId":"job"})),
        (
            "control.screenshot",
            json!({"target":"local","sourceId":"screen"}),
        ),
    ] {
        let task = tokio::spawn(service.clone().invoke(
            principal.clone(),
            "request".into(),
            Call {
                source: None,
                name: name.into(),
                arguments,
            },
        ));
        next_call(&mut receive).await;
        {
            let mut s = service.state.lock().unwrap();
            assert!(s.pending.is_empty());
            assert!(Service::check_call(&s, "epoch", "request").is_ok());
            let ticket = s.tickets.remove("request").unwrap();
            assert_eq!(
                grant.get_or_insert_with(|| ticket.grant.clone()),
                &ticket.grant
            );
            ticket.answer.send(json!({"ok":true,"data":{}})).unwrap();
        }
        assert_eq!(task.await.unwrap()["ok"], true);
    }
    assert_eq!(service.state.lock().unwrap().grants.len(), 1);
}

#[tokio::test]
async fn token_expiry_revocation_and_emergency_stop_invalidate_dispatched_calls() {
    for reason in ["expired", "revoked", "stopped"] {
        let (service, principal, mut receive) = connected();
        let task = tokio::spawn(service.clone().invoke(
            principal.clone(),
            "request".into(),
            call("remote"),
        ));
        next_call(&mut receive).await;
        match reason {
            "expired" => {
                let mut s = service.state.lock().unwrap();
                s.registry
                    .clients
                    .get_mut(&principal.id)
                    .unwrap()
                    .expires_at = Some(now() - 1);
                // A final effect check rejects expiry before the cleanup tick.
                assert!(Service::check_call(&s, "epoch", "request").is_err());
                drop(s);
                service.expire();
            }
            "revoked" => service.remove_client("epoch", &principal.id).unwrap(),
            _ => service.pause_policies(&mut service.state.lock().unwrap()),
        }
        assert_eq!(
            task.await.unwrap()["error"]["code"],
            "CANCELLED",
            "{reason}"
        );
        let result = service
            .clone()
            .invoke(principal, "next".into(), call("local"))
            .await;
        assert_eq!(
            result["error"]["code"],
            if reason == "stopped" {
                "PERMISSION_DENIED"
            } else {
                "SESSION_CLOSED"
            }
        );
        let s = service.state.lock().unwrap();
        assert!(s.pending.is_empty());
        assert!(s.grants.is_empty());
    }
}

#[tokio::test]
async fn renewing_expired_token_cancels_old_calls_but_admits_new_calls_without_consent() {
    let (service, principal, mut receive) = connected();
    let task = tokio::spawn(
        service
            .clone()
            .invoke(principal.clone(), "old".into(), call("local")),
    );
    next_call(&mut receive).await;
    let old_grant = {
        let mut s = service.state.lock().unwrap();
        s.registry
            .clients
            .get_mut(&principal.id)
            .unwrap()
            .expires_at = Some(now() - 1);
        s.tickets["old"].grant.clone()
    };
    service
        .update_client("epoch", &principal.id, "Renewed".into(), None)
        .unwrap();
    assert_eq!(task.await.unwrap()["error"]["code"], "CANCELLED");
    assert_eq!(receive.recv().await.unwrap()["kind"], "cancel");
    let task = tokio::spawn(
        service
            .clone()
            .invoke(principal, "new".into(), call("local")),
    );
    next_call(&mut receive).await;
    {
        let mut s = service.state.lock().unwrap();
        assert_ne!(s.tickets["new"].grant, old_grant);
        assert!(s.pending.is_empty());
        Service::cancel_request(&mut s, "new");
    }
    assert_eq!(task.await.unwrap()["error"]["code"], "CANCELLED");
}

#[tokio::test]
async fn reported_mcp_source_does_not_bypass_destination_peer_permissions() {
    let (service, token, _receive) = connected();
    let peer = Principal {
        kind: "peer".into(),
        generation: Some("connection-1".into()),
        ..token.clone()
    };
    {
        let mut s = service.state.lock().unwrap();
        Service::token_grant(&mut s, &token, &json!("local")).unwrap();
        Service::token_grant(&mut s, &token, &json!("remote")).unwrap();
        s.peers.insert(peer.id.clone(), peer.clone());
    }
    let mut request = call("local");
    request.source = Some(Source {
        kind: "mcp".into(),
        label: token.label,
    });
    // An incoming peer with a colliding ID cannot inherit a local token's authority.
    let task = tokio::spawn(service.clone().invoke(
        peer.clone(),
        "request".into(),
        request.clone(),
    ));
    tokio::time::timeout(Duration::from_secs(3), async {
        while !service
            .state
            .lock()
            .unwrap()
            .pending
            .contains_key("request")
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    service.decide("epoch", "request", 0).unwrap();
    assert_eq!(task.await.unwrap()["error"]["code"], "PERMISSION_DENIED");
    service
        .set_peer_policy(
            "epoch",
            &peers::Identity::from(&peer),
            HashMap::from([("diagnostics.read".into(), policy::Decision::Deny)]),
        )
        .unwrap();
    assert_eq!(service.state.lock().unwrap().grants.len(), 2);
    assert_eq!(
        service
            .clone()
            .invoke(peer.clone(), "denied".into(), request)
            .await["error"]["code"],
        "PERMISSION_DENIED"
    );
    assert_eq!(
        service
            .invoke(peer, "forward".into(), call("third-device"))
            .await["error"]["code"],
        "PERMISSION_DENIED"
    );
}
