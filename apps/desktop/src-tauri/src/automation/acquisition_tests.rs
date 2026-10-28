use super::*;

fn fixture() -> (Shared, Principal) {
    let service = Arc::new(Service::default());
    let principal = Principal {
        id: "paired-device".into(),
        label: "Device".into(),
        kind: "peer".into(),
        generation: Some("connection-1".into()),
    };
    {
        let mut s = service.state.lock().unwrap();
        s.enabled = true;
        s.epoch = "epoch".into();
        s.channel = Some(Channel::new(|_| Ok(())));
        s.peers.insert(principal.id.clone(), principal.clone());
    }
    (service, principal)
}
fn call() -> Call {
    Call {
        source: None,
        name: "control.acquire".into(),
        arguments: json!({"target":"local","sourceId":"monitor"}),
    }
}
fn policy(service: &Service, p: &Principal, input: policy::Decision, screen: policy::Decision) {
    service
        .set_peer_policy(
            "epoch",
            &peers::Identity::from(p),
            HashMap::from([
                ("input.control".into(), input),
                ("screen.manage".into(), screen),
            ]),
        )
        .unwrap();
}
async fn until(check: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !check() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
fn finish(service: &Service) {
    let mut s = service.state.lock().unwrap();
    Service::check_call(&s, "epoch", "acquire").unwrap();
    assert!(s.pending.is_empty());
    let ticket = s.tickets.remove("acquire").unwrap();
    ticket.answer.send(json!({"ok":true,"data":{}})).unwrap();
}

#[test]
fn exactly_one_source_or_track_is_required_and_only_source_adds_capture_permission() {
    for args in [
        json!({"target":"local","sourceId":"monitor"}),
        json!({"target":"local","trackId":"track"}),
    ] {
        let tool = catalog::validate("control.acquire", &args).unwrap();
        assert_eq!(
            catalog::required_scopes(tool, &args).len(),
            if args.get("sourceId").is_some() { 2 } else { 1 }
        );
    }
    for args in [
        json!({"target":"local"}),
        json!({"target":"local","sourceId":"monitor","trackId":"track"}),
        json!({"target":"local","sourceId":""}),
        json!({"target":"local","sourceId":1}),
    ] {
        assert!(catalog::validate("control.acquire", &args).is_err());
    }
}

#[tokio::test]
async fn allowed_capture_and_input_dispatch_without_pending_consent() {
    let (service, p) = fixture();
    policy(
        &service,
        &p,
        policy::Decision::Allow,
        policy::Decision::Allow,
    );
    let task = tokio::spawn(service.clone().invoke(p, "acquire".into(), call()));
    until(|| {
        service
            .state
            .lock()
            .unwrap()
            .tickets
            .contains_key("acquire")
    })
    .await;
    {
        let s = service.state.lock().unwrap();
        let t = &s.tickets["acquire"];
        assert!(s.grants[t.screen_grant.as_ref().unwrap()]
            .scopes
            .contains(&"screen.manage".into()));
    }
    finish(&service);
    assert_eq!(task.await.unwrap()["ok"], true);
}

#[tokio::test]
async fn either_missing_permission_needs_only_one_group_review() {
    for missing in ["input.control", "screen.manage", "both"] {
        let (service, p) = fixture();
        policy(
            &service,
            &p,
            if missing == "screen.manage" {
                policy::Decision::Allow
            } else {
                policy::Decision::Ask
            },
            if missing == "input.control" {
                policy::Decision::Allow
            } else {
                policy::Decision::Ask
            },
        );
        let task = tokio::spawn(service.clone().invoke(p, "acquire".into(), call()));
        until(|| {
            service
                .state
                .lock()
                .unwrap()
                .pending
                .contains_key("acquire")
        })
        .await;
        {
            let s = service.state.lock().unwrap();
            assert!(s.tickets.is_empty());
            assert_eq!(s.pending.len(), 1);
        }
        service.decide("epoch", "acquire", true).unwrap();
        until(|| {
            service
                .state
                .lock()
                .unwrap()
                .tickets
                .contains_key("acquire")
        })
        .await;
        finish(&service);
        assert_eq!(task.await.unwrap()["ok"], true);
    }
}

#[tokio::test]
async fn denial_of_either_permission_prevents_capture_without_prompting() {
    for scope in ["input.control", "screen.manage"] {
        let (service, p) = fixture();
        policy(
            &service,
            &p,
            if scope == "input.control" {
                policy::Decision::Deny
            } else {
                policy::Decision::Ask
            },
            if scope == "screen.manage" {
                policy::Decision::Deny
            } else {
                policy::Decision::Ask
            },
        );
        assert_eq!(
            service.clone().invoke(p, "acquire".into(), call()).await["error"]["code"],
            "PERMISSION_DENIED"
        );
        let s = service.state.lock().unwrap();
        assert!(s.pending.is_empty());
        assert!(s.tickets.is_empty());
    }
}

#[tokio::test]
async fn separately_approved_grants_are_reused_and_revoking_either_cancels_preparation() {
    for revoked in ["input", "screen"] {
        let (service, p) = fixture();
        {
            let mut s = service.state.lock().unwrap();
            for (id, scope) in [("input", "input.control"), ("screen", "screen.manage")] {
                s.grants.insert(
                    id.into(),
                    Grant {
                        id: id.into(),
                        target: "local".into(),
                        principal: p.clone(),
                        scopes: vec![scope.into()],
                        expires_at: None,
                        source: GrantSource::Consent,
                    },
                );
            }
        }
        let task = tokio::spawn(service.clone().invoke(p, "acquire".into(), call()));
        until(|| {
            service
                .state
                .lock()
                .unwrap()
                .tickets
                .contains_key("acquire")
        })
        .await;
        {
            let mut s = service.state.lock().unwrap();
            assert!(s.pending.is_empty());
            assert_eq!(s.tickets["acquire"].grant, "input");
            assert_eq!(s.tickets["acquire"].screen_grant.as_deref(), Some("screen"));
            Service::check_call(&s, "epoch", "acquire").unwrap();
            s.grants.get_mut("screen").unwrap().scopes.clear();
            assert_eq!(
                Service::check_call(&s, "epoch", "acquire"),
                Err("GRANT_EXPIRED".into())
            );
            service.revoke_locked(&mut s, revoked);
        }
        assert_eq!(task.await.unwrap()["error"]["code"], "CANCELLED");
    }
}

#[tokio::test]
async fn editing_one_scope_keeps_review_for_the_other_and_denial_cancels_it() {
    for allow in [false, true] {
        let (service, p) = fixture();
        let task = tokio::spawn(service.clone().invoke(p.clone(), "acquire".into(), call()));
        until(|| {
            service
                .state
                .lock()
                .unwrap()
                .pending
                .contains_key("acquire")
        })
        .await;
        policy(&service, &p, policy::Decision::Allow, policy::Decision::Ask);
        {
            let s = service.state.lock().unwrap();
            assert!(s.pending.contains_key("acquire"));
            assert!(s.tickets.is_empty());
        }
        policy(
            &service,
            &p,
            if allow {
                policy::Decision::Allow
            } else {
                policy::Decision::Deny
            },
            policy::Decision::Allow,
        );
        if allow {
            until(|| {
                service
                    .state
                    .lock()
                    .unwrap()
                    .tickets
                    .contains_key("acquire")
            })
            .await;
            finish(&service);
            assert_eq!(task.await.unwrap()["ok"], true);
        } else {
            assert_eq!(task.await.unwrap()["error"]["code"], "PERMISSION_DENIED");
        }
    }
}

#[tokio::test]
async fn existing_track_does_not_require_capture_permission() {
    let (service, p) = fixture();
    policy(
        &service,
        &p,
        policy::Decision::Allow,
        policy::Decision::Deny,
    );
    let mut existing = call();
    existing.arguments = json!({"target":"local","trackId":"live-track"});
    let task = tokio::spawn(service.clone().invoke(p, "acquire".into(), existing));
    until(|| {
        service
            .state
            .lock()
            .unwrap()
            .tickets
            .contains_key("acquire")
    })
    .await;
    assert!(service.state.lock().unwrap().tickets["acquire"]
        .screen_grant
        .is_none());
    finish(&service);
    assert_eq!(task.await.unwrap()["ok"], true);
}
