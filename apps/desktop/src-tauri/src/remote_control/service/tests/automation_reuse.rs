use super::*;
use weblink_desktop_input::input::{Button, Held, Position};

pub(crate) fn with_bound_borrowed_input(test: impl FnOnce(&Service, &str, &dyn Fn(bool))) {
    let (rig, _) = manual();
    let lease = borrow(&rig);
    let window = Arc::new(Window(AtomicBool::new(true)));
    rig.service
        .automation_bind_window("client", &lease, window.clone())
        .unwrap();
    test(&rig.service, &lease, &|focused| {
        window.0.store(focused, Ordering::Release);
    });
}

fn manual() -> (Rig, String) {
    let rig = Rig::new();
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
    let grant = rig.approve();
    rig.input(&grant, 1, 1, json!({"type":"activate"}));
    (rig, grant)
}
fn borrow(rig: &Rig) -> String {
    let owner = rig.service.owner(&rig.owner).unwrap();
    let mut host = owner.host.lock().unwrap();
    let mut request = target(&rig.owner, "capture", "unused-automation-media");
    request.binding.peer_generation = "connection".into();
    assert!(host
        .acquire_automation(rig.source.clone(), request, true)
        .unwrap());
    host.automation_grant("client", None).unwrap().1.to_owned()
}
fn key(key: ScanCode, down: bool) -> Event {
    Event::Key { key, down }
}

#[test]
fn same_verified_device_borrows_without_replacing_manual_grant_or_media() {
    let (rig, grant) = manual();
    assert!(rig.service.automation_lease("client").is_err());
    let lease = borrow(&rig);
    assert_ne!(lease, grant);
    assert_eq!(
        borrow(&rig),
        lease,
        "Repeated acquisition must be idempotent"
    );
    assert!(!rig.service.automation_matches("other", &lease));
    assert!(!rig.service.automation_matches("client", &grant));
    rig.service
        .automation_input("client", &lease, vec![Event::Text("中文".into())])
        .unwrap();
    assert!(rig
        .state
        .observations
        .lock()
        .unwrap()
        .contains(&Observation::Input(Action::Unicode {
            unit: '中' as u16,
            down: true,
        })));
    rig.service.automation_release("other");
    assert!(rig.service.automation_matches("client", &lease));
    rig.service.automation_release("client");
    assert!(!rig.service.automation_active("client"));
    let status = rig.service.status(&rig.owner).unwrap();
    assert_eq!(status.grant_id.as_deref(), Some(grant.as_str()));
    assert_eq!(status.controller_kind, Some(ControllerKind::Remote));
    assert!(!rig.endpoint.is_closed());
    assert_eq!(rig.source.2.lock().unwrap().len(), 1);
    let before = rig.submitted();
    rig.input(
        &grant,
        1,
        2,
        json!({"type":"key","scanCode":30,"extended":false,"down":true}),
    );
    rig.input(
        &grant,
        1,
        3,
        json!({"type":"key","scanCode":30,"extended":false,"down":false}),
    );
    assert!(
        rig.submitted() > before,
        "The manual channel remains usable"
    );
}

#[test]
fn borrowing_requires_exact_device_connection_capture_and_native_authority() {
    for mismatch in 0..9 {
        let (rig, grant) = manual();
        let owner = rig.service.owner(&rig.owner).unwrap();
        let mut host = owner.host.lock().unwrap();
        let mut request = target(&rig.owner, "capture", "unused");
        request.binding.peer_generation = "connection".into();
        match mismatch {
            0 => request.binding.client_id = "other-client".into(),
            1 => request.binding.peer_generation = "old-connection".into(),
            2 => request.binding.capture_session_id = "other-capture".into(),
            3 => request.binding.target.source_id = "other-source".into(),
            4 => request.binding.target.geometry_revision = "old-layout".into(),
            5 => request.binding.room_generation = "old-room".into(),
            6 => host.peers.get_mut("media").unwrap().connection_generation = None,
            7 => {
                host.worker.interrupt().unwrap();
            }
            _ => {}
        }
        assert_eq!(
            host.acquire_automation(rig.source.clone(), request, mismatch != 8),
            Err("BUSY".into())
        );
        assert_eq!(host.active.as_ref().unwrap().grant.id, grant);
        assert!(host.active.as_ref().unwrap().reuse.is_none());
        assert!(!rig.endpoint.is_closed());
    }
}

#[test]
fn borrowed_cleanup_releases_only_automation_holds_and_ignores_stale_cleanup() {
    let (rig, grant) = manual();
    let first = borrow(&rig);
    rig.service.automation_release("client");
    let second = borrow(&rig);
    assert_ne!(first, second);
    let automated = ScanCode::new(30, false).unwrap();
    let human = ScanCode::new(0x2a, false).unwrap();
    rig.service
        .automation_input("client", &second, vec![key(automated, true)])
        .unwrap();
    let owner = rig.service.owner(&rig.owner).unwrap();
    {
        let host = owner.host.lock().unwrap();
        // A second owner of pressed state is never released by borrowed cleanup.
        host.worker
            .input(
                host.active.as_ref().unwrap().grant.clone(),
                key(human, true),
            )
            .unwrap();
        host.worker.flush().unwrap();
    }
    assert!(!rig.service.automation_revoke_lease("client", &first));
    assert!(rig.service.automation_matches("client", &second));
    assert!(rig.service.automation_revoke_lease("client", &second));
    let host = owner.host.lock().unwrap();
    assert_eq!(host.worker.status().held, vec![Held::Key(human)]);
    assert_eq!(host.active.as_ref().unwrap().grant.id, grant);
    assert!(!rig.endpoint.is_closed());
    assert!(rig
        .state
        .observations
        .lock()
        .unwrap()
        .contains(&Observation::Input(Action::Key {
            key: automated,
            down: false,
        })));
}

#[test]
fn human_held_inputs_block_automation_without_revoking_manual_control() {
    let (rig, grant) = manual();
    let human = ScanCode::new(0x2a, false).unwrap();
    rig.input(
        &grant,
        1,
        2,
        json!({"type":"key","scanCode":0x2a,"extended":false,"down":true}),
    );
    let lease = borrow(&rig);
    assert_eq!(
        rig.service
            .automation_input("client", &lease, vec![Event::Text("中文".into())]),
        Err("INPUT_HELD".into())
    );
    rig.service.automation_revoke_lease("client", &lease);
    let owner = rig.service.owner(&rig.owner).unwrap();
    assert_eq!(
        owner.host.lock().unwrap().worker.status().held,
        vec![Held::Key(human)]
    );
    rig.input(
        &grant,
        1,
        3,
        json!({"type":"key","scanCode":0x2a,"extended":false,"down":false}),
    );
    assert!(owner.host.lock().unwrap().worker.status().held.is_empty());
    assert_eq!(
        rig.service.status(&rig.owner).unwrap().grant_id,
        Some(grant)
    );
}

#[test]
fn interrupted_or_replaced_manual_grants_cannot_revive_borrowed_leases() {
    let (rig, grant) = manual();
    let old = borrow(&rig);
    let owner = rig.service.owner(&rig.owner).unwrap();
    owner.host.lock().unwrap().worker.interrupt().unwrap();
    rig.tick();
    assert!(!rig.service.automation_matches("client", &old));
    rig.input(&grant, 2, 1, json!({"type":"activate"}));
    assert!(!rig.service.automation_matches("client", &old));
    let replacement = borrow(&rig);
    assert_ne!(old, replacement);
    rig.service.automation_revoke_lease("client", &old);
    assert!(rig.service.automation_matches("client", &replacement));
    rig.service.revoke(&rig.owner).unwrap();
    assert!(!rig.service.automation_active("client"));
}

struct Window(AtomicBool);
impl weblink_desktop_input::window::WindowGuard for Window {
    fn activate(&self) -> Result<(), Error> {
        self.check(None)
    }
    fn check(&self, _: Option<(i32, i32)>) -> Result<(), Error> {
        self.0
            .load(Ordering::Acquire)
            .then_some(())
            .ok_or(Error::WindowFocusLost)
    }
}
#[test]
fn borrowed_window_binding_confines_only_automation_and_does_not_end_manual_input() {
    let (rig, grant) = manual();
    let lease = borrow(&rig);
    let window = Arc::new(Window(AtomicBool::new(true)));
    rig.service
        .automation_bind_window("client", &lease, window.clone())
        .unwrap();
    assert!(rig
        .service
        .automation_window_bound("client", &lease)
        .unwrap());
    let owner = rig.service.owner(&rig.owner).unwrap();
    assert!(!owner.host.lock().unwrap().worker.status().window_bound);
    window.0.store(false, Ordering::Release);
    // The heartbeat uses this query to detect emergency revocation and pause
    // all automatic permissions. A stale/blurred window only rejects this
    // borrowed input scope; the underlying authority still exists.
    assert!(rig.service.automation_active("client"));
    assert_eq!(
        rig.service.automation_lease("client"),
        Err("WINDOW_FOCUS_LOST".into())
    );
    assert_eq!(
        rig.service.automation_input(
            "client",
            &lease,
            vec![Event::Move(Position { x: 0.5, y: 0.5 })]
        ),
        Err("WINDOW_FOCUS_LOST".into())
    );
    rig.service.automation_revoke_lease("client", &lease);
    let before = rig.submitted();
    rig.input(
        &grant,
        1,
        2,
        json!({"type":"key","scanCode":30,"extended":false,"down":true}),
    );
    rig.input(
        &grant,
        1,
        3,
        json!({"type":"key","scanCode":30,"extended":false,"down":false}),
    );
    assert!(rig.submitted() > before);
    assert_eq!(
        rig.service.status(&rig.owner).unwrap().grant_id,
        Some(grant)
    );
    assert!(!rig.endpoint.is_closed());
}

#[test]
fn blurred_borrowed_window_is_retired_and_rebound_without_emergency_reauthorization() {
    let (rig, grant) = manual();
    let first = borrow(&rig);
    let window = Arc::new(Window(AtomicBool::new(true)));
    rig.service
        .automation_bind_window("client", &first, window.clone())
        .unwrap();
    window.0.store(false, Ordering::Release);
    rig.service.automation_sync(&["client".into()]);
    assert!(rig.service.automation_active("client"));
    assert_eq!(
        rig.service.automation_take_window_interruption("other"),
        None
    );
    assert_eq!(
        rig.service.automation_take_window_interruption("client"),
        Some(first.clone())
    );
    assert!(!rig.service.automation_active("client"));
    let second = borrow(&rig);
    assert_ne!(first, second);
    rig.service
        .automation_bind_window("client", &second, Arc::new(Window(AtomicBool::new(true))))
        .unwrap();
    rig.service
        .automation_input("client", &second, vec![Event::Text("继续输入".into())])
        .unwrap();
    assert_eq!(
        rig.service.status(&rig.owner).unwrap().grant_id,
        Some(grant)
    );
    assert!(!rig.endpoint.is_closed());
}

#[test]
fn borrowed_window_blur_releases_owned_keys_and_buttons_and_cannot_resume_on_refocus() {
    for check_on_input in [false, true] {
        let (rig, grant) = manual();
        let lease = borrow(&rig);
        let window = Arc::new(Window(AtomicBool::new(true)));
        rig.service
            .automation_bind_window("client", &lease, window.clone())
            .unwrap();
        let ctrl = ScanCode::new(0x1d, false).unwrap();
        let human = ScanCode::new(0x2a, false).unwrap();
        rig.service
            .automation_input(
                "client",
                &lease,
                vec![
                    key(ctrl, true),
                    Event::Button {
                        button: Button::Left,
                        down: true,
                        position: Position { x: 0.5, y: 0.5 },
                    },
                ],
            )
            .unwrap();
        let owner = rig.service.owner(&rig.owner).unwrap();
        {
            let host = owner.host.lock().unwrap();
            host.worker
                .input(
                    host.active.as_ref().unwrap().grant.clone(),
                    key(human, true),
                )
                .unwrap();
        }
        window.0.store(false, Ordering::Release);
        if check_on_input {
            assert_eq!(
                rig.service.automation_lease("client"),
                Err("WINDOW_FOCUS_LOST".into())
            );
        } else {
            rig.tick();
        }
        assert_eq!(
            owner.host.lock().unwrap().worker.status().held,
            vec![Held::Key(human)]
        );
        let observations = rig.state.observations.lock().unwrap();
        assert!(observations.contains(&Observation::Input(Action::Key {
            key: ctrl,
            down: false
        })));
        assert!(observations.contains(&Observation::Input(Action::Button {
            button: Button::Left,
            down: false
        })));
        drop(observations);
        window.0.store(true, Ordering::Release);
        assert_eq!(
            rig.service
                .automation_input("client", &lease, vec![Event::Text("stale".into())]),
            Err("WINDOW_FOCUS_LOST".into())
        );
        // Reacquisition before the authority heartbeat also gets a fresh lease.
        let replacement = borrow(&rig);
        assert_ne!(lease, replacement);
        rig.service.automation_revoke_lease("client", &lease);
        assert!(rig.service.automation_matches("client", &replacement));
        assert_eq!(
            rig.service.automation_take_window_interruption("client"),
            None
        );
        assert_eq!(
            rig.service.status(&rig.owner).unwrap().grant_id,
            Some(grant)
        );
        assert!(!rig.endpoint.is_closed());
    }
}

#[test]
fn idle_borrowed_window_monitor_releases_a_hold_without_more_input_or_heartbeats() {
    let (rig, _) = manual();
    let lease = borrow(&rig);
    let window = Arc::new(Window(AtomicBool::new(true)));
    rig.service
        .automation_bind_window("client", &lease, window.clone())
        .unwrap();
    let ctrl = ScanCode::new(0x1d, false).unwrap();
    rig.service
        .automation_input("client", &lease, vec![key(ctrl, true)])
        .unwrap();
    window.0.store(false, Ordering::Release);
    let deadline = Instant::now() + Duration::from_secs(2);
    while !rig
        .state
        .observations
        .lock()
        .unwrap()
        .contains(&Observation::Input(Action::Key {
            key: ctrl,
            down: false,
        }))
    {
        assert!(
            Instant::now() < deadline,
            "Idle monitor did not release Ctrl"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    window.0.store(true, Ordering::Release);
    assert!(!rig.service.automation_matches("client", &lease));
}
