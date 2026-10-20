use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Fake {
    actions: Arc<AtomicUsize>,
    cancel_before_effect: Option<Arc<AtomicBool>>,
}
impl Backend for Fake {
    type Element = usize;
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
    fn name(&self) -> &'static str {
        "test"
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
    fn inspect(&mut self, e: &usize, _: &Check) -> Result<ElementInfo> {
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
        })
    }
    fn perform(&mut self, _: &usize, _: Action, _: Option<&str>, check: &Check) -> Result<()> {
        if let Some(flag) = &self.cancel_before_effect {
            flag.store(false, Ordering::SeqCst);
        }
        check()?;
        self.actions.fetch_add(1, Ordering::SeqCst);
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
            actions: count.clone(),
            cancel_before_effect: None,
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
    }
}
fn invoke(id: String) -> Request {
    Request::Action {
        element_id: id,
        action: Action::Invoke,
        value: None,
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
        },
        Request::Action {
            element_id: "id".into(),
            action: Action::Invoke,
            value: Some("ignored?".into()),
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
