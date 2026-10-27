use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Fake {
    capabilities: Capabilities,
    actions: Arc<AtomicUsize>,
    cancel_before_effect: Option<Arc<AtomicBool>>,
    revoke_after_effect: Option<Arc<AtomicBool>>,
    value_reads: AtomicUsize,
    subscriptions: Arc<AtomicUsize>,
}
struct TestSubscription(Arc<AtomicUsize>);
impl EventSubscription for TestSubscription {}
impl Drop for TestSubscription {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
impl Backend for Fake {
    type Element = usize;
    fn subscribe(
        &mut self,
        e: &usize,
        _: &WaitCondition,
        _: Arc<WaitSignal>,
        check: &Check,
    ) -> Result<Box<dyn EventSubscription>> {
        check()?;
        if *e == 2 {
            return Err(Error::ProtectedElement);
        }
        self.subscriptions.fetch_add(1, Ordering::SeqCst);
        let guard = TestSubscription(self.subscriptions.clone());
        if let Some(flag) = &self.cancel_before_effect {
            flag.store(false, Ordering::SeqCst);
        }
        Ok(Box::new(guard))
    }
    fn bind_window(&mut self, element: &usize, check: &Check) -> Result<BoundWindow> {
        if *element != 0 {
            return Err(Error::InvalidArguments);
        }
        if let Some(flag) = &self.cancel_before_effect {
            flag.store(false, Ordering::SeqCst);
        }
        check()?;
        Ok(Arc::new(TestWindow))
    }
    fn capabilities(&self) -> Capabilities {
        self.capabilities
    }
    fn roots(&mut self, _: usize, _: &Check) -> Result<(Vec<usize>, bool)> {
        Ok((vec![0], false))
    }
    fn children(&mut self, e: &usize, limit: usize, _: &Check) -> Result<(Vec<usize>, bool)> {
        let nodes = match e {
            0 => vec![1, 2, 4],
            2 => vec![3],
            _ => vec![],
        };
        let more = nodes.len() > limit;
        Ok((nodes.into_iter().take(limit).collect(), more))
    }
    fn inspect(&mut self, e: &usize, options: &ReadOptions, _: &Check) -> Result<ElementInfo> {
        let protected = *e == 2;
        let changed = self.actions.load(Ordering::SeqCst) > 0;
        let content = if options.include_values && !protected {
            self.value_reads.fetch_add(1, Ordering::SeqCst);
            Some(
                if changed {
                    "updated✅界"
                } else {
                    "initial✅界"
                }
                .to_string(),
            )
        } else {
            None
        };
        Ok(ElementInfo {
            role: Role::Button,
            name: if *e == 2 {
                "secret".into()
            } else {
                "button".into()
            },
            automation_id: "id".into(),
            process_id: 1,
            bounds: Bounds {
                x: -10,
                y: 0,
                width: 20,
                height: 20,
            },
            enabled: true,
            focused: false,
            offscreen: false,
            protected: *e == 2,
            actions: vec![Action::Invoke, Action::SetValue],
            state: ElementState {
                toggle_state: Some(if changed {
                    ToggleState::On
                } else {
                    ToggleState::Off
                }),
                selected: Some(changed),
                expand_collapse_state: Some(ExpandCollapseState::Collapsed),
                read_only: Some(false),
                value: content.clone(),
                text: content,
                ..Default::default()
            },
        })
    }
    fn perform(&mut self, _: &usize, _: Action, _: Option<&str>, check: &Check) -> Result<()> {
        if let Some(flag) = &self.cancel_before_effect {
            flag.store(false, Ordering::SeqCst);
        }
        check()?;
        self.actions.fetch_add(1, Ordering::SeqCst);
        if let Some(flag) = &self.revoke_after_effect {
            flag.store(false, Ordering::SeqCst);
        }
        Ok(())
    }
}
struct TestWindow;
impl weblink_desktop_input::window::WindowGuard for TestWindow {
    fn check(
        &self,
        _: Option<(i32, i32)>,
    ) -> std::result::Result<(), weblink_desktop_input::input::Error> {
        Ok(())
    }
    fn activate(&self) -> std::result::Result<(), weblink_desktop_input::input::Error> {
        Ok(())
    }
}

#[test]
fn window_resolution_requires_a_live_owned_root_and_rechecks_authority() {
    let (mut s, a, flag, _) = fixture();
    let id = root(&mut s, &a);
    assert!(s.bind_window(&id, a.clone()).is_ok());
    let other = access("bob", &Arc::new(AtomicBool::new(true)));
    assert!(matches!(
        s.bind_window(&id, other),
        Err(Error::PermissionDenied)
    ));
    let nodes = s.execute(tree(id.clone(), 256), a.clone()).unwrap();
    let child = nodes["nodes"][1]["elementId"].as_str().unwrap();
    assert!(matches!(
        s.bind_window(child, a.clone()),
        Err(Error::InvalidArguments)
    ));
    s.references.get_mut(&id).unwrap().expires = Instant::now() - Duration::from_secs(1);
    assert!(matches!(
        s.bind_window(&id, a.clone()),
        Err(Error::StaleElement)
    ));
    let id = root(&mut s, &a);
    s.backend.cancel_before_effect = Some(flag);
    assert!(matches!(
        s.bind_window(&id, a),
        Err(Error::PermissionDenied)
    ));
}
fn access(owner: &str, flag: &Arc<AtomicBool>) -> Access {
    let flag = flag.clone();
    let check: Check = Arc::new(move || {
        if flag.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(Error::PermissionDenied)
        }
    });
    Access {
        owner: owner.into(),
        check: check.clone(),
        lease: check,
    }
}
fn fixture() -> (Session<Fake>, Access, Arc<AtomicBool>, Arc<AtomicUsize>) {
    let flag = Arc::new(AtomicBool::new(true));
    let count = Arc::new(AtomicUsize::new(0));
    (
        Session::new(Fake {
            capabilities: Capabilities {
                supported: true,
                backend: Some("test"),
                actions: &ACTIONS,
                features: Some(Features::new(true, true, true)),
            },
            actions: count.clone(),
            cancel_before_effect: None,
            revoke_after_effect: None,
            value_reads: AtomicUsize::new(0),
            subscriptions: Arc::new(AtomicUsize::new(0)),
        }),
        access("alice", &flag),
        flag,
        count,
    )
}
fn root(s: &mut Session<Fake>, a: &Access) -> String {
    s.execute(Request::Windows { limit: 1 }, a.clone()).unwrap()["windows"][0]["elementId"]
        .as_str()
        .unwrap()
        .into()
}
fn tree(id: String, max_nodes: usize) -> Request {
    Request::Snapshot {
        element_id: id,
        max_depth: 8,
        max_nodes,
        options: ReadOptions::default(),
    }
}
fn invoke(id: String) -> Request {
    Request::Action {
        element_id: id,
        action: Action::Invoke,
        value: None,
        observe_after: None,
    }
}

#[test]
fn snapshots_are_bounded_and_never_descend_into_passwords() {
    let (mut s, a, _, _) = fixture();
    let id = root(&mut s, &a);
    let result = s.execute(tree(id.clone(), 256), a.clone()).unwrap();
    assert_eq!(result["nodes"].as_array().unwrap().len(), 4);
    assert!(!result.to_string().contains("secret"));
    let protected = &result["nodes"][2];
    assert_eq!(protected["protected"], true);
    assert_eq!(protected["name"], "");
    assert_eq!(protected["automationId"], "");
    assert_eq!(protected["actions"], json!([]));
    let protected_id = protected["elementId"].as_str().unwrap().into();
    assert_eq!(
        s.execute(invoke(protected_id), a.clone()),
        Err(Error::ProtectedElement)
    );
    let limited = s.execute(tree(id, 2), a).unwrap();
    assert_eq!(limited["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(limited["truncated"], true);
}
#[test]
fn handles_are_caller_bound_and_expire() {
    let (mut s, a, _, _) = fixture();
    let id = root(&mut s, &a);
    let other = access("bob", &Arc::new(AtomicBool::new(true)));
    assert_eq!(
        s.execute(tree(id.clone(), 10), other),
        Err(Error::PermissionDenied)
    );
    s.references.get_mut(&id).unwrap().expires = Instant::now();
    assert_eq!(s.execute(tree(id, 10), a), Err(Error::StaleElement));
}
#[test]
fn revoked_read_grant_invalidates_references_even_with_fresh_control_permission() {
    let (mut s, a, flag, count) = fixture();
    let id = root(&mut s, &a);
    flag.store(false, Ordering::SeqCst);
    let fresh = access("alice", &Arc::new(AtomicBool::new(true)));
    assert_eq!(s.execute(invoke(id), fresh), Err(Error::StaleElement));
    assert_eq!(count.load(Ordering::SeqCst), 0);
}
#[test]
fn revocation_during_pattern_resolution_prevents_the_side_effect() {
    let (mut s, a, flag, count) = fixture();
    let id = root(&mut s, &a);
    s.backend.cancel_before_effect = Some(flag);
    assert_eq!(s.execute(invoke(id), a), Err(Error::PermissionDenied));
    assert_eq!(count.load(Ordering::SeqCst), 0);
}
#[test]
fn read_revocation_during_action_is_rechecked_separately_from_control_permission() {
    let (mut s, read, flag, count) = fixture();
    let id = root(&mut s, &read);
    let control = access("alice", &Arc::new(AtomicBool::new(true)));
    s.backend.cancel_before_effect = Some(flag);
    assert_eq!(s.execute(invoke(id), control), Err(Error::PermissionDenied));
    assert_eq!(count.load(Ordering::SeqCst), 0);
}
#[test]
fn action_invalidates_previous_snapshots_and_cannot_be_replayed() {
    let (mut s, a, _, count) = fixture();
    let id = root(&mut s, &a);
    assert_eq!(
        s.execute(invoke(id.clone()), a.clone()).unwrap()["refreshRequired"],
        true
    );
    assert_eq!(s.execute(invoke(id), a), Err(Error::StaleElement));
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
#[test]
fn bounds_and_semantic_arguments_are_validated_without_provider_calls() {
    let (mut s, a, _, _) = fixture();
    for request in [
        tree("id".into(), 257),
        Request::Windows { limit: 0 },
        Request::Action {
            element_id: "id".into(),
            action: Action::SetValue,
            value: None,
            observe_after: None,
        },
        Request::Action {
            element_id: "id".into(),
            action: Action::Invoke,
            value: Some("ignored?".into()),
            observe_after: None,
        },
    ] {
        assert_eq!(s.execute(request, a.clone()), Err(Error::InvalidArguments));
    }
}
#[test]
fn reference_storage_is_bounded() {
    let (mut s, a, _, _) = fixture();
    for _ in 0..MAX_REFERENCES + 10 {
        s.remember(0, &a);
    }
    assert_eq!(s.references.len(), MAX_REFERENCES);
}

#[test]
fn semantic_states_are_readable_without_content_and_values_are_opt_in_bounded_and_redacted() {
    let (mut s, a, _, _) = fixture();
    let id = root(&mut s, &a);
    let result = s.execute(tree(id.clone(), 256), a.clone()).unwrap();
    assert_eq!(result["nodes"][0]["toggleState"], "off");
    assert_eq!(result["nodes"][0]["selected"], false);
    assert_eq!(result["nodes"][0]["expandCollapseState"], "collapsed");
    assert!(result["nodes"][0].get("value").is_none());
    assert_eq!(s.backend.value_reads.load(Ordering::SeqCst), 0);
    let result = s
        .execute(
            Request::Snapshot {
                element_id: id,
                max_depth: 8,
                max_nodes: 256,
                options: ReadOptions {
                    include_values: true,
                    max_text_length: 8,
                },
            },
            a,
        )
        .unwrap();
    assert_eq!(result["nodes"][0]["value"], "initial✅");
    assert_eq!(result["nodes"][0]["valueTruncated"], true);
    assert_eq!(result["nodes"][0]["textTruncated"], true);
    assert_eq!(s.backend.value_reads.load(Ordering::SeqCst), 3);
    let password = &result["nodes"][2];
    assert!(password.get("value").is_none());
    assert!(password.get("text").is_none());
    assert!(password.get("toggleState").is_none());
    assert!(!result.to_string().contains("secret"));
}

#[test]
fn observed_actions_return_new_owned_references_and_invalidate_every_old_reference() {
    let (mut s, a, _, count) = fixture();
    let id = root(&mut s, &a);
    let before = s.execute(tree(id.clone(), 256), a.clone()).unwrap();
    let child = before["nodes"][1]["elementId"]
        .as_str()
        .unwrap()
        .to_string();
    let applied = s
        .execute(
            Request::Action {
                element_id: child.clone(),
                action: Action::Invoke,
                value: None,
                observe_after: Some(Observation {
                    element_id: Some(id.clone()),
                    include_values: true,
                    ..Default::default()
                }),
            },
            a.clone(),
        )
        .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let result = crate::observation::complete(applied, |request| s.execute(request, a.clone()));
    assert_eq!(result["applied"], true);
    assert_eq!(result["refreshRequired"], false);
    assert_eq!(result["observation"]["nodes"][0]["value"], "updated✅界");
    assert_eq!(result["observation"]["nodes"][0]["toggleState"], "on");
    assert!(result.get("_observation").is_none());
    assert_eq!(
        s.execute(invoke(child), a.clone()),
        Err(Error::StaleElement)
    );
    assert_eq!(s.execute(tree(id, 4), a.clone()), Err(Error::StaleElement));
    let fresh = result["observation"]["nodes"][0]["elementId"]
        .as_str()
        .unwrap()
        .to_string();
    let other = access("bob", &Arc::new(AtomicBool::new(true)));
    assert_eq!(
        s.execute(tree(fresh.clone(), 4), other),
        Err(Error::PermissionDenied)
    );
    assert!(s.execute(tree(fresh, 4), a).is_ok());
}

#[test]
fn read_revocation_after_an_applied_action_fails_only_the_observation() {
    let (mut s, read, flag, count) = fixture();
    let id = root(&mut s, &read);
    let control = access("alice", &Arc::new(AtomicBool::new(true)));
    s.backend.revoke_after_effect = Some(flag);
    let applied = s
        .execute(
            Request::Action {
                element_id: id,
                action: Action::Invoke,
                value: None,
                observe_after: Some(Observation::default()),
            },
            control.clone(),
        )
        .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let result =
        crate::observation::complete(applied, |request| s.execute(request, control.clone()));
    assert_eq!(result["applied"], true);
    assert_eq!(result["refreshRequired"], true);
    assert_eq!(result["observationError"]["code"], "STALE_ELEMENT");
    assert!(result.get("observation").is_none());
}

#[test]
fn inspecting_for_wait_produces_fresh_refs_without_refreshing_the_original_identity_lifetime() {
    let (mut s, a, _, _) = fixture();
    let id = root(&mut s, &a);
    let initial_expiry = s.references[&id].expires;
    let node = s
        .execute(
            Request::Inspect {
                element_id: id.clone(),
                options: ReadOptions::default(),
                refresh_when: Some(WaitCondition {
                    enabled: Some(true),
                    ..Default::default()
                }),
            },
            a.clone(),
        )
        .unwrap();
    let fresh = node["elementId"].as_str().unwrap();
    assert_ne!(fresh, id);
    assert_eq!(s.references[&id].expires, initial_expiry);
    assert!(s.execute(tree(fresh.into(), 4), a).is_ok());
}

#[test]
fn waiting_does_not_evict_its_original_target_from_a_full_reference_cache() {
    let (mut s, a, _, count) = fixture();
    let id = root(&mut s, &a);
    let original_expiry = s.references[&id].expires;
    for _ in 1..MAX_REFERENCES {
        s.remember(0, &a);
    }
    assert_eq!(s.references.len(), MAX_REFERENCES);
    let inspect = || Request::Inspect {
        element_id: id.clone(),
        options: ReadOptions::default(),
        refresh_when: Some(WaitCondition {
            selected: Some(true),
            ..Default::default()
        }),
    };
    for _ in 0..3 {
        let node = s.execute(inspect(), a.clone()).unwrap();
        assert_eq!(node["elementId"], id);
        assert_eq!(node["selected"], false);
        assert_eq!(s.references.len(), MAX_REFERENCES);
        assert_eq!(s.references[&id].expires, original_expiry);
    }
    // The exact same provider object now matches. Only this observation gets a fresh ID.
    count.store(1, Ordering::SeqCst);
    let node = s.execute(inspect(), a.clone()).unwrap();
    assert_eq!(node["selected"], true);
    let fresh = node["elementId"].as_str().unwrap().to_string();
    assert_ne!(fresh, id);
    assert_eq!(s.references.len(), MAX_REFERENCES);
    let other = access("bob", &Arc::new(AtomicBool::new(true)));
    assert_eq!(
        s.execute(tree(fresh.clone(), 4), other),
        Err(Error::PermissionDenied)
    );
    assert!(s.execute(tree(fresh, 4), a).is_ok());
}

#[test]
fn truncated_names_cannot_satisfy_exact_name_conditions_or_leak_password_length() {
    let (mut s, a, _, _) = fixture();
    let mut info = s
        .backend
        .inspect(&0, &ReadOptions::default(), &a.check)
        .unwrap();
    let prefix = "界".repeat(512);
    info.name = format!("{prefix}suffix");
    info.sanitize(&ReadOptions::default());
    // Native and portable boundaries both sanitize; the second pass preserves truncation.
    info.sanitize(&ReadOptions::default());
    assert_eq!(info.name, prefix);
    assert_eq!(info.state.name_truncated, Some(true));
    let condition = WaitCondition {
        name: Some(prefix),
        ..Default::default()
    };
    assert!(!condition.matches(&json!(&info)));
    info.protected = true;
    info.sanitize(&ReadOptions::default());
    assert_eq!(info.name, "");
    assert!(info.state.name_truncated.is_none());
}

#[test]
fn event_subscription_is_bound_to_the_original_read_grant_and_not_the_registration_deadline() {
    let (mut session, original, read_live, _) = fixture();
    let id = root(&mut session, &original);
    let current = access("alice", &Arc::new(AtomicBool::new(true)));
    let registration_live = Arc::new(AtomicBool::new(true));
    let registration = access("registration", &registration_live).check;
    let signal = Arc::new(WaitSignal::default());
    let condition = WaitCondition {
        selected: Some(true),
        ..Default::default()
    };
    let prepared = session
        .subscribe(&id, &condition, signal.clone(), current, registration)
        .unwrap();
    registration_live.store(false, Ordering::SeqCst);
    assert!((prepared.check)().is_ok());
    read_live.store(false, Ordering::SeqCst);
    signal.notify();
    assert_eq!((prepared.check)(), Err(Error::PermissionDenied));
    signal.cancel();
    session.purge();
    assert_eq!(session.backend.subscriptions.load(Ordering::SeqCst), 0);
}

#[test]
fn event_subscriptions_are_bounded_and_released_on_cancellation_or_registration_revocation() {
    let (mut session, access, flag, _) = fixture();
    let id = root(&mut session, &access);
    let condition = WaitCondition {
        enabled: Some(true),
        ..Default::default()
    };
    let mut signals = Vec::new();
    for _ in 0..MAX_SUBSCRIPTIONS {
        let signal = Arc::new(WaitSignal::default());
        session
            .subscribe(
                &id,
                &condition,
                signal.clone(),
                access.clone(),
                access.check.clone(),
            )
            .unwrap();
        signals.push(signal);
    }
    assert!(matches!(
        session.subscribe(
            &id,
            &condition,
            Arc::new(WaitSignal::default()),
            access.clone(),
            access.check.clone()
        ),
        Err(Error::Busy)
    ));
    for signal in signals {
        signal.cancel();
    }
    session.purge();
    assert_eq!(session.backend.subscriptions.load(Ordering::SeqCst), 0);
    session.backend.cancel_before_effect = Some(flag);
    assert!(matches!(
        session.subscribe(
            &id,
            &condition,
            Arc::new(WaitSignal::default()),
            access.clone(),
            access.check.clone()
        ),
        Err(Error::PermissionDenied)
    ));
    assert!(session.subscriptions.is_empty());
    assert_eq!(session.backend.subscriptions.load(Ordering::SeqCst), 0);
}

#[test]
fn partial_backend_reports_and_enforces_its_own_features_before_side_effects() {
    let (mut s, a, _, count) = fixture();
    s.backend.capabilities.actions = &[Action::Invoke];
    s.backend.capabilities.features = Some(Features::new(false, false, false));
    let report = s.execute(Request::Capabilities, a.clone()).unwrap();
    assert_eq!(report["actions"], json!(["invoke"]));
    assert_eq!(report["supportsWait"], false);
    assert_eq!(report["supportsObservation"], false);
    assert_eq!(report["supportsWindowBinding"], false);
    let id = root(&mut s, &a);
    assert!(matches!(
        s.bind_window(&id, a.clone()),
        Err(Error::Unsupported)
    ));
    assert!(matches!(
        s.subscribe(
            &id,
            &WaitCondition {
                enabled: Some(true),
                ..Default::default()
            },
            Arc::new(WaitSignal::default()),
            a.clone(),
            a.check.clone(),
        ),
        Err(Error::Unsupported)
    ));
    for (action, value, observe_after, expected) in [
        (
            Action::SetValue,
            Some("x".into()),
            None,
            Error::UnsupportedAction,
        ),
        (
            Action::Invoke,
            None,
            Some(Observation::default()),
            Error::Unsupported,
        ),
    ] {
        assert_eq!(
            s.execute(
                Request::Action {
                    element_id: id.clone(),
                    action,
                    value,
                    observe_after,
                },
                a.clone()
            ),
            Err(expected)
        );
    }
    assert_eq!(count.load(Ordering::SeqCst), 0);
    // Rejecting an unsupported feature must not invalidate an otherwise valid reference.
    s.execute(
        Request::Action {
            element_id: id,
            action: Action::Invoke,
            value: None,
            observe_after: None,
        },
        a,
    )
    .unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
