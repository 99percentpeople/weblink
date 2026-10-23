use super::*;
fn call() -> Call {
    Call {
        source: None,
        name: "diagnostics.snapshot".into(),
        arguments: json!({"target":"local"}),
    }
}
#[tokio::test]
async fn modern_http_carries_principal_structured_images_and_disconnect_cancellation() {
    let (service, p) = fixture();
    let (sent, mut events) = tokio::sync::mpsc::unbounded_channel::<Value>();
    {
        let mut s = service.state.lock().unwrap();
        s.channel = Some(Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(body) = body else {
                panic!("expected JSON")
            };
            let _ = sent.send(serde_json::from_str(&body).unwrap());
            Ok(())
        }));
    }
    http::start(service.clone(), "epoch".into()).await.unwrap();
    let url = service.state.lock().unwrap().endpoint.clone();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let meta = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{},
        "io.modelcontextprotocol/clientInfo":{"name":"review","version":"1"}});
    let list: Value = client
        .post(&url)
        .bearer_auth("test-token")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2026-07-28")
        .header("Mcp-Method", "tools/list")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":meta}}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        list["result"]["tools"]
            .as_array()
            .unwrap_or_else(|| panic!("Unexpected MCP response: {list}"))
            .len(),
        catalog::tools().len()
    );
    let request = json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
        "params":{"name":"control.screenshot","arguments":{"target":"local","sourceId":"screen"},"_meta":meta}});
    let response = tokio::spawn(
        client
            .post(&url)
            .bearer_auth("test-token")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2026-07-28")
            .header("Mcp-Method", "tools/call")
            .header("Mcp-Name", "control.screenshot")
            .json(&request)
            .send(),
    );
    let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event["principal"]["id"], p.id);
    let payload =
        json!({"ok":true,"data":{"mimeType":"image/png","data":"aW1hZ2U=","width":1,"height":1}});
    service
        .state
        .lock()
        .unwrap()
        .tickets
        .remove(event["id"].as_str().unwrap())
        .unwrap()
        .answer
        .send(payload.clone())
        .unwrap();
    let result: Value = response.await.unwrap().unwrap().json().await.unwrap();
    assert_eq!(result["result"]["structuredContent"], payload);
    assert_eq!(result["result"]["content"][0]["type"], "text");
    assert_eq!(result["result"]["content"][1]["type"], "image");
    let disconnected = tokio::spawn(
        client
            .post(&url)
            .bearer_auth("test-token")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2026-07-28")
            .header("Mcp-Method", "tools/call")
            .header("Mcp-Name", "control.screenshot")
            .json(&request)
            .send(),
    );
    let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event["kind"], "call");
    disconnected.abort();
    let _ = disconnected.await;
    until(|| service.state.lock().unwrap().tickets.is_empty()).await;
    let cancelled = tokio::time::timeout(Duration::from_secs(3), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cancelled, json!({"kind":"cancel","id":event["id"]}));
    service.shutdown();
}
fn grant(p: &Principal) -> Grant {
    Grant {
        id: "grant".into(),
        target: "local".into(),
        principal: p.clone(),
        scopes: vec!["diagnostics.read".into()],
        expires_at: Some(now() + 60000),
    }
}
#[tokio::test]
async fn duplicate_requests_cannot_clear_pending_approval_or_executing_ticket() {
    let (service, p) = peer_fixture();
    let first = tokio::spawn(service.clone().invoke(p.clone(), "same".into(), call()));
    until(|| service.state.lock().unwrap().pending.contains_key("same")).await;
    assert_eq!(
        service
            .clone()
            .invoke(p.clone(), "same".into(), call())
            .await["error"]["code"],
        "DUPLICATE_REQUEST"
    );
    assert!(service.state.lock().unwrap().pending.contains_key("same"));
    service.decide("epoch", "same", 5).unwrap();
    until(|| service.state.lock().unwrap().tickets.contains_key("same")).await;
    assert_eq!(
        service.clone().invoke(p, "same".into(), call()).await["error"]["code"],
        "DUPLICATE_REQUEST"
    );
    assert!(service.state.lock().unwrap().tickets.contains_key("same"));
    Service::cancel_request(&mut service.state.lock().unwrap(), "same");
    assert_eq!(first.await.unwrap()["error"]["code"], "CANCELLED");
    assert!(service.state.lock().unwrap().requests.is_empty());
}
#[test]
fn stale_cleanup_never_removes_a_reused_id() {
    let (service, _) = fixture();
    service.state.lock().unwrap().requests.insert(
        "same".into(),
        Invocation {
            generation: "new".into(),
            mcp: true,
            local: true,
        },
    );
    drop(RequestCleanup {
        service: service.clone(),
        id: "same".into(),
        generation: "old".into(),
    });
    assert_eq!(
        service
            .state
            .lock()
            .unwrap()
            .requests
            .get("same")
            .unwrap()
            .generation,
        "new"
    );
}
#[tokio::test]
async fn cancelled_pending_approval_is_audited_as_cancelled_and_does_not_touch_a_reused_id() {
    let (service, p) = peer_fixture();
    let first = tokio::spawn(service.clone().invoke(p.clone(), "same".into(), call()));
    until(|| service.state.lock().unwrap().pending.contains_key("same")).await;
    Service::cancel_request(&mut service.state.lock().unwrap(), "same");
    let second = tokio::spawn(service.clone().invoke(p, "same".into(), call()));
    until(|| service.state.lock().unwrap().pending.contains_key("same")).await;
    assert_eq!(first.await.unwrap()["error"]["code"], "CANCELLED");
    {
        let s = service.state.lock().unwrap();
        assert!(s.pending.contains_key("same"));
        assert!(s.tickets.is_empty());
        assert_eq!(s.audit.last().unwrap()["status"], "CANCELLED");
    }
    // A deliberate denial still has its own result and audit status.
    service.decide("epoch", "same", 0).unwrap();
    assert_eq!(second.await.unwrap()["error"]["code"], "PERMISSION_DENIED");
    let s = service.state.lock().unwrap();
    assert_eq!(s.audit.last().unwrap()["status"], "PERMISSION_DENIED");
    assert!(s.requests.is_empty());
    assert!(s.pending.is_empty());
}
#[tokio::test]
async fn cancelling_between_approval_and_dispatch_cannot_resume_using_a_new_grant() {
    let (service, p) = peer_fixture();
    let first = tokio::spawn(service.clone().invoke(p.clone(), "request".into(), call()));
    until(|| {
        service
            .state
            .lock()
            .unwrap()
            .pending
            .contains_key("request")
    })
    .await;
    service.decide("epoch", "request", 5).unwrap();
    // No await between approval and cancellation: the waiting future hasn't dispatched.
    {
        let mut s = service.state.lock().unwrap();
        Service::cancel_all(&mut s);
        s.grants.clear();
        s.grants.insert("grant".into(), grant(&p));
    }
    assert_eq!(first.await.unwrap()["error"]["code"], "CANCELLED");
    assert!(service.state.lock().unwrap().tickets.is_empty());
}
#[tokio::test]
async fn revocation_and_dropped_invocations_immediately_cancel_ui_work() {
    let (service, p) = peer_fixture();
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sent = events.clone();
    {
        let mut s = service.state.lock().unwrap();
        s.channel = Some(Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(body) = body else {
                panic!("expected JSON")
            };
            sent.lock()
                .unwrap()
                .push(serde_json::from_str(&body).unwrap());
            Ok(())
        }));
        s.grants.insert("grant".into(), grant(&p));
    }
    let task = tokio::spawn(service.clone().invoke(p.clone(), "request".into(), call()));
    until(|| {
        service
            .state
            .lock()
            .unwrap()
            .tickets
            .contains_key("request")
    })
    .await;
    assert_eq!(events.lock().unwrap()[0]["kind"], "call");
    assert!(Service::check_call(&service.state.lock().unwrap(), "epoch", "request").is_ok());
    service.revoke_locked(&mut service.state.lock().unwrap(), "grant");
    assert_eq!(
        events.lock().unwrap()[1],
        json!({"kind":"cancel","id":"request"})
    );
    assert!(Service::check_call(&service.state.lock().unwrap(), "epoch", "request").is_err());
    assert_eq!(task.await.unwrap()["error"]["code"], "CANCELLED");
    service
        .state
        .lock()
        .unwrap()
        .grants
        .insert("grant".into(), grant(&p));
    let task = tokio::spawn(service.clone().invoke(p, "dropped".into(), call()));
    until(|| {
        service
            .state
            .lock()
            .unwrap()
            .tickets
            .contains_key("dropped")
    })
    .await;
    task.abort();
    assert!(task.await.is_err());
    assert_eq!(
        events.lock().unwrap().last().unwrap(),
        &json!({"kind":"cancel","id":"dropped"})
    );
    assert!(service.state.lock().unwrap().tickets.is_empty());
    assert!(service.state.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn reconnect_between_approval_and_dispatch_cannot_reuse_the_new_channels_authority() {
    let (service, _) = fixture();
    let old = peers::Identity {
        id: "device".into(),
        generation: "connection-1".into(),
    };
    service
        .connect_peer("epoch", old.clone(), "Device".into())
        .unwrap();
    let principal = Service::peer_principal(&service.state.lock().unwrap(), &old).unwrap();
    let task = tokio::spawn(service.clone().invoke(principal, "request".into(), call()));
    until(|| {
        service
            .state
            .lock()
            .unwrap()
            .pending
            .contains_key("request")
    })
    .await;
    service.decide("epoch", "request", 5).unwrap();
    // Complete a reconnect before the approved future can dispatch.
    let replacement = peers::Identity {
        generation: "connection-2".into(),
        ..old
    };
    service
        .connect_peer("epoch", replacement.clone(), "Device".into())
        .unwrap();
    service
        .set_peer_policy(
            "epoch",
            &replacement,
            HashMap::from([("diagnostics.read".into(), policy::Decision::Allow)]),
        )
        .unwrap();
    {
        let mut s = service.state.lock().unwrap();
        let principal = Service::peer_principal(&s, &replacement).unwrap();
        Service::policy_grant(&mut s, &principal, "diagnostics.read");
    }
    assert_eq!(task.await.unwrap()["error"]["code"], "SESSION_CLOSED");
    assert!(service.state.lock().unwrap().tickets.is_empty());
}
pub(super) fn fixture() -> (Shared, Principal) {
    let service = Arc::new(Service::default());
    let p = Principal {
        id: "client".into(),
        label: "Test".into(),
        kind: "mcp".into(),
        generation: None,
    };
    {
        let mut s = service.state.lock().unwrap();
        s.enabled = true;
        s.mcp_enabled = true;
        s.registry.port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        s.epoch = "epoch".into();
        s.channel = Some(Channel::new(|_| Ok(())));
        s.registry.clients.insert(
            p.id.clone(),
            registry::Client {
                id: p.id.clone(),
                label: p.label.clone(),
                token_hash: registry::digest("test-token"),
                prefix: "test".into(),
                created_at: now(),
                expires_at: None,
            },
        );
    }
    (service, p)
}
fn peer_fixture() -> (Shared, Principal) {
    let (service, mut principal) = fixture();
    principal.kind = "peer".into();
    service
        .state
        .lock()
        .unwrap()
        .peers
        .insert(principal.id.clone(), principal.clone());
    (service, principal)
}
async fn until(test: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !test() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn grants_are_bound_to_target_and_revocation_drops_tickets() {
    let (service, p) = peer_fixture();
    service.state.lock().unwrap().grants.insert(
        "remote".into(),
        Grant {
            target: "other-device".into(),
            id: "remote".into(),
            principal: p.clone(),
            scopes: vec!["diagnostics.read".into()],
            expires_at: Some(now() + 60000),
        },
    );
    let task = tokio::spawn(service.clone().invoke(
        p,
        "request".into(),
        Call {
            source: None,
            name: "diagnostics.snapshot".into(),
            arguments: json!({"target":"local"}),
        },
    ));
    until(|| {
        service
            .state
            .lock()
            .unwrap()
            .pending
            .contains_key("request")
    })
    .await;
    {
        let mut s = service.state.lock().unwrap();
        let pending = s.pending.remove("request").unwrap();
        s.grants.insert(
            "local".into(),
            Grant {
                target: "local".into(),
                id: "local".into(),
                principal: pending.principal,
                scopes: vec![pending.scope],
                expires_at: Some(now() + 60000),
            },
        );
        pending.answer.send(true).unwrap();
    }
    until(|| {
        service
            .state
            .lock()
            .unwrap()
            .tickets
            .contains_key("request")
    })
    .await;
    {
        let mut s = service.state.lock().unwrap();
        service.revoke_locked(&mut s, "local");
    }
    assert_eq!(task.await.unwrap()["error"]["code"], "CANCELLED");
    service.shutdown();
}
#[tokio::test]
async fn old_principal_and_closed_page_cannot_execute() {
    let (service, mut p) = fixture();
    p.id = "forged".into();
    assert_eq!(
        service
            .clone()
            .invoke(
                p,
                "request".into(),
                Call {
                    source: None,
                    name: "diagnostics.snapshot".into(),
                    arguments: json!({"target":"local"})
                }
            )
            .await["error"]["code"],
        "SESSION_CLOSED"
    );
    service.close_page();
    assert!(service.authenticate("test-token").is_none());
    service.expire();
    assert!(service.authenticate("test-token").is_none());
    assert!(!service.state.lock().unwrap().enabled);
}
#[tokio::test]
async fn real_http_requires_credentials_origin_and_host_and_serves_catalog() {
    let (service, _) = fixture();
    http::start(service.clone(), "epoch".into()).await.unwrap();
    let url = service.state.lock().unwrap().endpoint.clone();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let request = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}});
    assert_eq!(
        client
            .post(&url)
            .json(&request)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        client
            .post(&url)
            .bearer_auth("test-token")
            .header("Origin", "https://evil.test")
            .json(&request)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        client
            .post(&url)
            .bearer_auth("test-token")
            .header("Host", "evil.test")
            .json(&request)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let response = client
        .post(&url)
        .bearer_auth("test-token")
        .header("Accept", "application/json, text/event-stream")
        .json(&request)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let list = json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}});
    let response = client
        .post(&url)
        .bearer_auth("test-token")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", "2025-11-25")
        .json(&list)
        .send()
        .await
        .unwrap();
    let result: Value = response.json().await.unwrap();
    assert_eq!(
        result["result"]["tools"].as_array().unwrap().len(),
        catalog::tools().len()
    );
    // HTTP authentication is re-evaluated on every request, even when the
    // client reuses a keep-alive connection and the catalog was already read.
    service
        .state
        .lock()
        .unwrap()
        .registry
        .clients
        .get_mut("client")
        .unwrap()
        .expires_at = Some(now() - 1);
    assert_eq!(
        client
            .post(&url)
            .bearer_auth("test-token")
            .json(&list)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    service
        .update_client("epoch", "client", "Test".into(), None)
        .unwrap();
    service.remove_client("epoch", "client").unwrap();
    assert_eq!(
        client
            .post(&url)
            .bearer_auth("test-token")
            .json(&list)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    service.shutdown();
}
