use super::*;

#[test]
fn successful_authentication_records_usage_and_rejected_requests_leave_it_unchanged() {
    let (service, principal) = super::super::tests::fixture();
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    service.state.lock().unwrap().channel = Some(Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(raw) = body {
            captured
                .lock()
                .unwrap()
                .push(serde_json::from_str::<Value>(&raw).unwrap());
        }
        Ok(())
    }));
    assert!(service.stored_registry().clients[&principal.id]
        .last_used_at
        .is_none());
    assert!(service.authenticate("invalid").is_none());
    assert!(events.lock().unwrap().is_empty());

    let before = now();
    service.authenticate("test-token").unwrap();
    let at = service.stored_registry().clients[&principal.id]
        .last_used_at
        .unwrap();
    assert!((before..=now()).contains(&at));
    assert_eq!(
        events.lock().unwrap().as_slice(),
        &[json!({
            "kind": "token-used", "epoch": "epoch", "id": principal.id, "lastUsedAt": at
        })]
    );

    assert!(service.authenticate(&"x".repeat(257)).is_none());
    service.state.lock().unwrap().mcp_enabled = false;
    assert!(service.authenticate("test-token").is_none());
    {
        let mut s = service.state.lock().unwrap();
        s.mcp_enabled = true;
        s.registry
            .clients
            .get_mut(&principal.id)
            .unwrap()
            .expires_at = Some(0);
    }
    assert!(service.authenticate("test-token").is_none());
    assert_eq!(
        service.stored_registry().clients[&principal.id].last_used_at,
        Some(at)
    );
    assert_eq!(events.lock().unwrap().len(), 1);
}

#[test]
fn editing_a_token_keeps_usage_recorded_after_preparation_and_across_restart() {
    let (service, principal) = super::super::tests::fixture();
    let prepared = service
        .prepare_registry(
            "epoch",
            Change::Update {
                id: principal.id.clone(),
                label: "Renamed".into(),
                expires_at: None,
            },
        )
        .unwrap();
    assert!(prepared.registry.clients[&principal.id]
        .last_used_at
        .is_none());
    service.authenticate("test-token").unwrap();
    let at = service.stored_registry().clients[&principal.id]
        .last_used_at
        .unwrap();
    service
        .apply_registry("epoch", prepared.revision, prepared.registry)
        .unwrap();
    let stored = service.stored_registry();
    assert_eq!(stored.clients[&principal.id].label, "Renamed");
    assert_eq!(stored.clients[&principal.id].summary()["lastUsedAt"], at);
    service.shutdown();
    let restarted = Service::default();
    restarted.load_registry(stored).unwrap();
    assert_eq!(
        restarted.stored_registry().clients[&principal.id].last_used_at,
        Some(at)
    );
}

#[test]
fn legacy_records_default_to_unknown_and_usage_never_moves_backwards() {
    let (service, principal) = super::super::tests::fixture();
    let mut legacy = serde_json::to_value(service.stored_registry()).unwrap();
    legacy["clients"][&principal.id]
        .as_object_mut()
        .unwrap()
        .remove("lastUsedAt");
    service
        .load_registry(serde_json::from_value(legacy).unwrap())
        .unwrap();
    assert_eq!(
        service.stored_registry().clients[&principal.id].summary()["lastUsedAt"],
        Value::Null
    );
    let future = now() + 60_000;
    service
        .state
        .lock()
        .unwrap()
        .registry
        .clients
        .get_mut(&principal.id)
        .unwrap()
        .last_used_at = Some(future);
    service.authenticate("test-token").unwrap();
    assert_eq!(
        service.stored_registry().clients[&principal.id].last_used_at,
        Some(future)
    );

    let mut invalid = service.stored_registry();
    invalid.clients.get_mut(&principal.id).unwrap().last_used_at = Some(253402300800000);
    assert_eq!(
        validate(&invalid),
        Err("INVALID_AUTOMATION_REGISTRY".into())
    );
}
