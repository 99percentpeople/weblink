use super::*;
use std::sync::mpsc;

#[test]
fn screenshot_catalog_and_native_options_accept_bounded_desktop_crops() {
    let args = json!({"target":"local", "sourceId":"window", "maxWidth":2048, "maxHeight":1200,
        "rect":{"left":-1800,"top":-100,"width":600,"height":400}});
    catalog::validate("control.screenshot", &args).unwrap();
    let options = screenshot_options(&args).unwrap();
    assert_eq!((options.max_width, options.max_height), (2048, 1200));
    assert_eq!(options.rect.unwrap().left, -1800);
    let defaults = screenshot_options(&json!({"target":"local","sourceId":"monitor"})).unwrap();
    assert_eq!((defaults.max_width, defaults.max_height), (1024, 1024));
    let properties = &catalog::find("control.screenshot").unwrap()["inputSchema"]["properties"];
    assert_eq!(properties["maxWidth"]["default"], defaults.max_width);
    assert_eq!(properties["maxHeight"]["default"], defaults.max_height);
    let partial = screenshot_options(&json!({"maxWidth":2048})).unwrap();
    assert_eq!((partial.max_width, partial.max_height), (2048, 1024));
    for extra in [
        json!({"maxWidth":0}),
        json!({"maxWidth":2049}),
        json!({"maxHeight":2049}),
        json!({"maxWidth":1.5}),
        json!({"rect":{"left":0,"top":0,"width":0,"height":1}}),
        json!({"rect":{"left":0,"top":0,"width":1,"height":1,"x":0}}),
        json!({"rect":{"left":0.5,"top":0,"width":1,"height":1}}),
    ] {
        let mut args = json!({"target":"local", "sourceId":"monitor"});
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(catalog::validate("control.screenshot", &args).is_err());
        assert!(screenshot_options(&args).is_err());
    }
    assert!(
        screenshot_options(&json!({"rect":{"left":2147483647,"top":0,"width":1,"height":1}}))
            .is_err()
    );
}

fn fixture(name: &str) -> Shared {
    let service = Arc::new(Service::default());
    let principal = Principal {
        id: "caller".into(),
        label: "Test".into(),
        kind: "mcp".into(),
        generation: None,
    };
    let mut s = service.state.lock().unwrap();
    s.epoch = "epoch".into();
    s.enabled = true;
    s.mcp_enabled = true;
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
            scopes: vec!["screen.read".into()],
            expires_at: Some(now() + 60000),
        },
    );
    s.requests.insert(
        "ticket".into(),
        Invocation {
            generation: "generation".into(),
            mcp: true,
            local: true,
        },
    );
    s.tickets.insert(
        "ticket".into(),
        Ticket {
            principal,
            call: Call {
                source: None,
                name: name.into(),
                arguments: json!({"target":"local","sourceId":"monitor"}),
            },
            grant: "grant".into(),
            deadline: Instant::now() + Duration::from_secs(60),
            answer: oneshot::channel().0,
            used: false,
        },
    );
    drop(s);
    service
}

#[test]
fn discovery_and_screenshots_leave_heartbeat_and_revocation_responsive() {
    for name in ["screen.sources", "control.screenshot"] {
        let service = fixture(name);
        let worker_service = service.clone();
        let (started, ready) = mpsc::channel();
        let (resume, waiting) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            read(&worker_service, "epoch", "ticket", |_| {
                started.send(()).unwrap();
                waiting.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok(json!({"private":"native result"}))
            })
        });
        ready.recv_timeout(Duration::from_secs(3)).unwrap();
        // Fail without deadlocking the test if native work keeps authority locked.
        let responsive = if let Ok(mut s) = service.state.try_lock() {
            service.revoke_locked(&mut s, "grant");
            true
        } else {
            false
        };
        resume.send(()).unwrap();
        let result = worker.join().unwrap();
        assert!(responsive, "{name} blocked heartbeat/revocation");
        assert_eq!(result.unwrap_err(), "CANCELLED");
    }
}

#[test]
fn results_are_discarded_when_authority_changes_during_native_work() {
    let changes: [fn(&mut State); 7] = [
        |s| s.enabled = false,
        |s| s.epoch = "replacement".into(),
        |s| s.epoch.clear(),
        |s| s.registry.clients.get_mut("caller").unwrap().expires_at = Some(now() - 1),
        |s| s.grants.get_mut("grant").unwrap().expires_at = Some(now() - 1),
        |s| s.grants.get_mut("grant").unwrap().scopes = vec!["shell.execute".into()],
        |s| s.tickets.get_mut("ticket").unwrap().deadline = Instant::now(),
    ];
    for name in ["screen.sources", "control.screenshot"] {
        for change in changes {
            let service = fixture(name);
            let result = read(&service, "epoch", "ticket", |_| {
                change(
                    &mut service
                        .state
                        .try_lock()
                        .expect("authority held during read"),
                );
                Ok(json!({"private":"native result"}))
            });
            assert!(
                result.is_err(),
                "{name} returned data after authority ended"
            );
        }
    }
}

#[test]
fn read_requires_exact_local_authority_before_access_and_is_not_replayable() {
    let changes: [fn(&mut State); 5] = [
        |s| s.grants.get_mut("grant").unwrap().target = "peer".into(),
        |s| s.grants.get_mut("grant").unwrap().principal.id = "other".into(),
        |s| s.grants.get_mut("grant").unwrap().scopes = vec!["shell.execute".into()],
        |s| {
            s.grants.get_mut("grant").unwrap().target = "peer".into();
            s.tickets.get_mut("ticket").unwrap().call.arguments["target"] = json!("peer");
        },
        |s| {
            s.requests.clear();
        },
    ];
    for change in changes {
        let service = fixture("screen.sources");
        change(&mut service.state.lock().unwrap());
        assert!(read(&service, "epoch", "ticket", |_| panic!(
            "unauthorized access"
        ))
        .is_err());
    }
    let service = fixture("screen.sources");
    assert_eq!(
        read(&service, "epoch", "ticket", |_| Ok(json!({"sources":[]}))).unwrap(),
        json!({"sources":[]})
    );
    assert_eq!(
        read(&service, "epoch", "ticket", |_| panic!("replayed access")).unwrap_err(),
        "CANCELLED"
    );
}

#[test]
fn cancellation_does_not_release_the_worker_slot_or_validate_a_reused_request_id() {
    let service = fixture("control.screenshot");
    let result = read(&service, "epoch", "ticket", |_| {
        {
            let mut s = service.state.try_lock().unwrap();
            // Reuse the ID with an otherwise identical live ticket and grant.
            s.requests.insert(
                "ticket".into(),
                Invocation {
                    generation: "replacement".into(),
                    mcp: true,
                    local: true,
                },
            );
            s.tickets.get_mut("ticket").unwrap().used = false;
        }
        assert_eq!(
            read(&service, "epoch", "ticket", |_| panic!(
                "second native worker"
            ))
            .unwrap_err(),
            "BUSY"
        );
        Ok(json!({"private":"old caller's image"}))
    });
    assert_eq!(result.unwrap_err(), "CANCELLED");
    assert!(read(&service, "epoch", "ticket", |_| Ok(json!({"fresh":true}))).is_ok());
}

#[test]
fn native_errors_release_the_worker_slot() {
    let service = fixture("screen.sources");
    assert_eq!(
        read(&service, "epoch", "ticket", |_| Err(
            "SOURCE_UNAVAILABLE".into()
        ))
        .unwrap_err(),
        "SOURCE_UNAVAILABLE"
    );
    assert!(service.native_read.try_lock().is_ok());
}
