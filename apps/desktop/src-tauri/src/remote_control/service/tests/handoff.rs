use super::*;

fn connected(rig: &Rig) {
    rig.service
        .owner(&rig.owner)
        .unwrap()
        .host
        .lock()
        .unwrap()
        .peers
        .get_mut("media")
        .unwrap()
        .connection_generation = Some("connection".into());
}

fn second(rig: &Rig, client: &str, generation: &str) -> (Arc<Endpoint>, Arc<TestSender>, Target) {
    let mut target = target(&rig.owner, "capture-2", "media-2");
    target.binding.client_id = client.into();
    target.binding.peer_generation = "peer-2".into();
    target.binding.target.source_id = "screen-2".into();
    let wire = target.binding.target.clone();
    let endpoint = rig
        .service
        .owner(&rig.owner)
        .unwrap()
        .host
        .lock()
        .unwrap()
        .register(rig.source.clone(), target, Some(generation.into()))
        .unwrap();
    let sender = Arc::new(TestSender {
        state: rig.state.clone(),
        sent: Mutex::default(),
        closed: Mutex::default(),
    });
    endpoint.opened(sender.clone());
    rig.tick();
    (endpoint, sender, wire)
}

fn send(rig: &Rig, endpoint: &Endpoint, value: Value) {
    endpoint.message(false, &serde_json::to_vec(&value).unwrap());
    rig.tick();
}

#[test]
fn rejected_native_handoff_keeps_automation_and_held_inputs() {
    let rig = Rig::new();
    let (next, sender, target) = second(&rig, "human", "connection");
    let request = json!({"type":"request","requestId":"cancelled","target":target});
    // This request was handled by the native authority before handoff began.
    send(&rig, &next, request.clone());
    send(
        &rig,
        &next,
        json!({"type":"cancel","requestId":"cancelled"}),
    );
    assert!(rig.service.status(&rig.owner).unwrap().pending.is_empty());
    let old = rig.acquire_automation();
    let key = ScanCode::new(30, false).unwrap();
    rig.service
        .automation_input("client", &old, vec![Event::Key { key, down: true }])
        .unwrap();
    let submitted = rig.submitted();
    send(&rig, &next, request);
    let consent = rig.service.status(&rig.owner).unwrap().pending[0]
        .consent_id
        .clone();
    assert!(rig.service.approve(&rig.owner, &consent, true).is_err());
    assert!(rig.service.automation_matches("client", &old));
    assert_eq!(rig.submitted(), submitted);
    assert!(!sender
        .sent
        .lock()
        .unwrap()
        .iter()
        .any(|signal| signal["type"] == "grant"));
    rig.service
        .automation_input("client", &old, vec![Event::Key { key, down: false }])
        .unwrap();
    rig.released();
}

#[test]
fn cross_screen_handoff_keeps_old_control_until_approval_and_ignores_stale_cleanup() {
    let rig = Rig::new();
    connected(&rig);
    let old = rig.approve();
    rig.activate_and_hold(&old, 1);
    let (next, sender, target) = second(&rig, "client", "connection");
    send(
        &rig,
        &next,
        json!({"type":"request", "requestId":"switch", "target":target}),
    );
    let status = rig.service.status(&rig.owner).unwrap();
    assert_eq!(status.grant_id.as_deref(), Some(old.as_str()));
    assert_eq!(status.pending.len(), 1);
    rig.service
        .approve(&rig.owner, &status.pending[0].consent_id, true)
        .unwrap();
    rig.released();
    let status = rig.service.status(&rig.owner).unwrap();
    assert_eq!(status.source_id.as_deref(), Some("screen-2"));
    assert_ne!(status.grant_id.as_deref(), Some(old.as_str()));
    assert!(sender
        .sent
        .lock()
        .unwrap()
        .iter()
        .any(|s| s["type"] == "grant"));
    assert!(rig
        .sender
        .sent
        .lock()
        .unwrap()
        .iter()
        .any(|s| s["type"] == "revoke"));
    rig.send(json!({"type":"revoke", "grantId":old, "reason":"local"}));
    rig.service.stop_capture("capture");
    assert_eq!(
        rig.service.status(&rig.owner).unwrap().grant_id,
        status.grant_id
    );
}

#[test]
fn declined_cancelled_expired_and_disconnected_handoffs_preserve_the_old_grant() {
    for action in ["decline", "cancel", "expire", "disconnect"] {
        let rig = Rig::new();
        connected(&rig);
        let old = rig.approve();
        let (next, _, target) = second(&rig, "client", "connection");
        send(
            &rig,
            &next,
            json!({"type":"request", "requestId":"switch", "target":target}),
        );
        let consent = rig.service.status(&rig.owner).unwrap().pending[0]
            .consent_id
            .clone();
        match action {
            "decline" => rig.service.approve(&rig.owner, &consent, false).unwrap(),
            "cancel" => send(&rig, &next, json!({"type":"cancel", "requestId":"switch"})),
            "expire" => {
                rig.service
                    .owner(&rig.owner)
                    .unwrap()
                    .host
                    .lock()
                    .unwrap()
                    .pending[0]
                    .requested = Instant::now() - Duration::from_secs(61);
                rig.tick();
            }
            _ => {
                next.closed();
                rig.tick();
            }
        }
        let status = rig.service.status(&rig.owner).unwrap();
        assert!(status.pending.is_empty(), "{action}");
        assert_eq!(status.grant_id.as_deref(), Some(old.as_str()), "{action}");
        assert!(rig.service.approve(&rig.owner, &consent, true).is_err());
    }
}

#[test]
fn different_device_or_connection_cannot_replace_an_existing_manual_grant() {
    for (client, generation) in [("other", "connection"), ("client", "new-connection")] {
        let rig = Rig::new();
        connected(&rig);
        let old = rig.approve();
        let (next, sender, target) = second(&rig, client, generation);
        send(
            &rig,
            &next,
            json!({"type":"request", "requestId":"switch", "target":target}),
        );
        assert!(rig.service.status(&rig.owner).unwrap().pending.is_empty());
        assert!(sender
            .sent
            .lock()
            .unwrap()
            .iter()
            .any(|s| s["type"] == "deny" && s["reason"] == "busy"));
        assert_eq!(
            rig.service.status(&rig.owner).unwrap().grant_id.as_deref(),
            Some(old.as_str())
        );
    }
}

#[test]
fn manual_approval_preempts_automation_and_stale_lease_cannot_release_the_new_grant() {
    let rig = Rig::new();
    let old = rig.acquire_automation();
    rig.service
        .automation_input(
            "client",
            &old,
            vec![Event::Key {
                key: ScanCode::new(30, false).unwrap(),
                down: true,
            }],
        )
        .unwrap();
    let (next, _, target) = second(&rig, "human", "human-connection");
    send(
        &rig,
        &next,
        json!({"type":"request", "requestId":"takeover", "target":target}),
    );
    assert!(rig.service.automation_matches("client", &old));
    let consent = rig.service.status(&rig.owner).unwrap().pending[0]
        .consent_id
        .clone();
    rig.service.approve(&rig.owner, &consent, true).unwrap();
    rig.released();
    assert!(!rig.service.automation_matches("client", &old));
    assert!(!rig.service.automation_revoke_lease("client", &old));
    assert_eq!(
        rig.service.status(&rig.owner).unwrap().client_id.as_deref(),
        Some("human")
    );
    assert!(rig
        .service
        .automation_input("client", &old, vec![Event::Text("stale".into())])
        .is_err());
}

#[test]
fn stale_handoff_cannot_replace_a_newer_automation_grant() {
    let rig = Rig::new();
    rig.acquire_automation();
    let (next, _, target) = second(&rig, "human", "connection");
    send(
        &rig,
        &next,
        json!({"type":"request", "requestId":"takeover", "target":target}),
    );
    let consent = rig.service.status(&rig.owner).unwrap().pending[0]
        .consent_id
        .clone();
    rig.service.revoke(&rig.owner).unwrap();
    let new = rig.acquire_automation();
    assert!(rig.service.approve(&rig.owner, &consent, true).is_err());
    assert!(rig.service.automation_matches("client", &new));
}

#[test]
fn automation_owner_can_explicitly_switch_screens_with_a_fresh_lease() {
    let rig = Rig::new();
    let old = rig.acquire_automation();
    rig.service
        .automation_input(
            "client",
            &old,
            vec![Event::Key {
                key: ScanCode::new(30, false).unwrap(),
                down: true,
            }],
        )
        .unwrap();
    let owner = rig.service.owner(&rig.owner).unwrap();
    let mut host = owner.host.lock().unwrap();
    let mut target = target(&rig.owner, "capture-2", "automation-2");
    target.binding.target.source_id = "screen-2".into();
    let mut foreign = target.clone();
    foreign.binding.client_id = "other".into();
    assert_eq!(
        host.acquire_automation(rig.source.clone(), foreign, false),
        Err("BUSY".into())
    );
    assert!(!host
        .acquire_automation(rig.source.clone(), target, false)
        .unwrap());
    let new = host.active.as_ref().unwrap().grant.id.clone();
    assert_ne!(old, new);
    drop(host);
    rig.released();
    assert!(!rig.service.automation_revoke_lease("client", &old));
    assert!(rig.service.automation_matches("client", &new));
}

#[test]
fn failed_automation_screen_switch_preserves_the_existing_lease() {
    let rig = Rig::new();
    let old = rig.acquire_automation();
    let mut next = target(&rig.owner, "capture-2", "automation-2");
    next.binding.target.source_id = "screen-2".into();
    next.geometry.display.width = 0;
    let owner = rig.service.owner(&rig.owner).unwrap();
    let result = owner
        .host
        .lock()
        .unwrap()
        .acquire_automation(rig.source.clone(), next, false);
    assert!(result.is_err());
    assert!(rig.service.automation_matches("client", &old));
}

#[test]
fn failed_handoff_denial_does_not_revoke_the_existing_controller() {
    struct DenyFails;
    impl Sender for DenyFails {
        fn send(&self, data: &[u8]) -> SendResult {
            if serde_json::from_slice::<Value>(data).unwrap()["type"] == "deny" {
                SendResult::Closed
            } else {
                SendResult::Sent
            }
        }
        fn close(&self) {}
    }
    let rig = Rig::new();
    connected(&rig);
    let old = rig.approve();
    let (next, _, target) = second(&rig, "client", "connection");
    next.opened(Arc::new(DenyFails));
    send(
        &rig,
        &next,
        json!({"type":"request", "requestId":"switch", "target":target}),
    );
    let consent = rig.service.status(&rig.owner).unwrap().pending[0]
        .consent_id
        .clone();
    assert!(rig.service.approve(&rig.owner, &consent, false).is_err());
    rig.tick();
    assert_eq!(
        rig.service.status(&rig.owner).unwrap().grant_id.as_deref(),
        Some(old.as_str())
    );
}

#[test]
fn failed_grant_delivery_ends_the_committed_handoff_without_restoring_automation() {
    struct GrantFails;
    impl Sender for GrantFails {
        fn send(&self, data: &[u8]) -> SendResult {
            if serde_json::from_slice::<Value>(data).unwrap()["type"] == "grant" {
                SendResult::Closed
            } else {
                SendResult::Sent
            }
        }
        fn close(&self) {}
    }
    let rig = Rig::new();
    let old = rig.acquire_automation();
    let key = ScanCode::new(30, false).unwrap();
    rig.service
        .automation_input("client", &old, vec![Event::Key { key, down: true }])
        .unwrap();
    let (next, _, target) = second(&rig, "human", "connection");
    next.opened(Arc::new(GrantFails));
    send(
        &rig,
        &next,
        json!({"type":"request","requestId":"takeover","target":target}),
    );
    let consent = rig.service.status(&rig.owner).unwrap().pending[0]
        .consent_id
        .clone();
    assert_eq!(
        rig.service.approve(&rig.owner, &consent, true),
        Err("Control channel ended".into())
    );
    rig.released();
    assert!(rig.service.status(&rig.owner).unwrap().grant_id.is_none());
    assert!(!rig.service.automation_matches("client", &old));
    assert!(rig
        .service
        .automation_input("client", &old, vec![Event::Key { key, down: true }])
        .is_err());
}

#[test]
fn cancelled_handoff_cannot_be_replayed_after_old_control_ends() {
    let rig = Rig::new();
    connected(&rig);
    rig.approve();
    let (next, _, target) = second(&rig, "client", "connection");
    let request = json!({"type":"request", "requestId":"switch", "target":target});
    send(&rig, &next, request.clone());
    send(&rig, &next, json!({"type":"cancel", "requestId":"switch"}));
    rig.service.revoke(&rig.owner).unwrap();
    send(&rig, &next, request);
    assert!(rig.service.status(&rig.owner).unwrap().pending.is_empty());
    send(
        &rig,
        &next,
        json!({"type":"request", "requestId":"fresh", "target":target}),
    );
    assert_eq!(rig.service.status(&rig.owner).unwrap().pending.len(), 1);
}
