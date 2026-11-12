use super::*;

#[tokio::test]
async fn permission_call_cancellation_and_audit_transitions_wake_status_readers() {
    let (service, mut principal) = super::super::tests::fixture();
    principal.kind = "peer".into();
    service
        .state
        .lock()
        .unwrap()
        .peers
        .insert(principal.id.clone(), principal.clone());
    let mut changes = service.changes.subscribe();
    let control = crate::remote_control::Service::default();
    let task = tokio::spawn(service.clone().invoke(
        principal,
        "request".into(),
        Call {
            source: None,
            name: "diagnostics.snapshot".into(),
            arguments: json!({"target":"local"}),
        },
    ));
    tokio::time::timeout(Duration::from_secs(3), changes.changed())
        .await
        .unwrap()
        .unwrap();
    let pending = service.status_snapshot("epoch", &control, false).unwrap();
    assert_eq!(pending["pending"][0]["id"], "request");
    assert!(pending.get("clients").is_none());
    assert!(
        !changes.has_changed().unwrap(),
        "Reading status must not notify again"
    );
    service.decide("epoch", "request", true).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            changes.changed().await.unwrap();
            if service
                .state
                .lock()
                .unwrap()
                .tickets
                .contains_key("request")
            {
                break;
            }
        }
    })
    .await
    .unwrap();
    let running = service.status_snapshot("epoch", &control, false).unwrap();
    assert_eq!(running["pending"], json!([]));
    assert_eq!(running["activeCalls"], json!(["request"]));
    assert_eq!(running["grants"].as_array().unwrap().len(), 1);
    assert!(running["revision"].as_u64().unwrap() > pending["revision"].as_u64().unwrap());
    service.revoke_locked(
        &mut service.state.lock().unwrap(),
        running["grants"][0]["id"].as_str().unwrap(),
    );
    assert!(changes.has_changed().unwrap());
    assert_eq!(task.await.unwrap()["error"]["code"], "CANCELLED");
    changes.borrow_and_update();
    let done = service.status_snapshot("epoch", &control, true).unwrap();
    assert_eq!(done["activeCalls"], json!([]));
    assert_eq!(done["grants"], json!([]));
    assert_eq!(done["audit"][0]["status"], "CANCELLED");
    assert_eq!(done["clients"].as_array().unwrap().len(), 1);
    assert!(!changes.has_changed().unwrap());
}

#[test]
fn status_revisions_coalesce_and_shutdown_closes_the_old_epoch() {
    let (service, _) = super::super::tests::fixture();
    let mut changes = service.changes.subscribe();
    let (send, receive) = std::sync::mpsc::channel();
    service.state.lock().unwrap().channel = Some(Channel::new(move |body| {
        let tauri::ipc::InvokeResponseBody::Json(body) = body else {
            panic!("JSON required")
        };
        send.send(serde_json::from_str::<Value>(&body).unwrap())
            .unwrap();
        Ok(())
    }));
    service.status_observer()();
    service.status_observer()();
    assert_eq!(*changes.borrow_and_update(), 2);
    assert!(!changes.has_changed().unwrap());
    service.shutdown();
    assert_eq!(
        receive.recv().unwrap(),
        json!({"kind":"closed","epoch":"epoch"})
    );
    assert!(changes.has_changed().unwrap());
    assert_eq!(
        service.maintenance_delay("epoch"),
        Err("SESSION_CLOSED".into())
    );
}

#[test]
fn maintenance_sleeps_when_idle_and_wakes_at_authority_deadlines() {
    let (service, principal) = super::super::tests::fixture();
    assert_eq!(service.maintenance_delay("epoch").unwrap(), None);
    {
        let mut state = service.state.lock().unwrap();
        state
            .registry
            .clients
            .get_mut(&principal.id)
            .unwrap()
            .expires_at = Some(now() + 5000);
        Service::token_grant(&mut state, &principal, &json!("local")).unwrap();
    }
    let expiry = service.maintenance_delay("epoch").unwrap().unwrap();
    assert!(expiry > Duration::ZERO && expiry <= Duration::from_secs(5));
    {
        let mut state = service.state.lock().unwrap();
        let (answer, _) = oneshot::channel();
        state.pending.insert(
            "approval".into(),
            Pending {
                principal,
                scope: "diagnostics.read".into(),
                call: Call {
                    source: None,
                    name: "diagnostics.snapshot".into(),
                    arguments: json!({"target":"local"}),
                },
                deadline: Instant::now() + Duration::from_millis(200),
                answer,
            },
        );
    }
    assert!(service.maintenance_delay("epoch").unwrap().unwrap() <= Duration::from_millis(200));
    {
        let mut state = service.state.lock().unwrap();
        state.pending.clear();
        state.grants.clear();
        state.native_error = Some("unavailable".into());
    }
    assert_eq!(
        service.maintenance_delay("epoch").unwrap(),
        Some(Duration::from_secs(1))
    );
    service.state.lock().unwrap().native_error = None;
    assert_eq!(service.maintenance_delay("epoch").unwrap(), None);
}
