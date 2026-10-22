use super::*;
use crate::remote_control::with_bound_borrowed_input;
use weblink_desktop_input::input::{Event, ScanCode};

fn authority(timed: bool) -> Service {
    let principal = Principal {
        id: "client".into(),
        label: "Peer".into(),
        kind: "peer".into(),
        generation: Some("connection".into()),
    };
    let service = Service::default();
    {
        let mut s = service.state.lock().unwrap();
        s.enabled = true;
        s.epoch = "epoch".into();
        s.heartbeat = Some(Instant::now());
        s.peers.insert(principal.id.clone(), principal.clone());
        s.peer_policies.insert(
            principal.id.clone(),
            HashMap::from([
                ("input.control".into(), policy::Decision::Allow),
                ("diagnostics.read".into(), policy::Decision::Allow),
            ]),
        );
        for scope in ["input.control", "diagnostics.read"] {
            s.grants.insert(
                scope.into(),
                Grant {
                    id: scope.into(),
                    principal: principal.clone(),
                    target: "local".into(),
                    scopes: vec![scope.into()],
                    expires_at: (timed && scope == "input.control").then(|| now() + 60_000),
                },
            );
        }
        s.input_owners.push(principal.id.clone());
    }
    service
}

#[test]
fn borrowed_blur_heartbeat_clears_lease_and_holds_but_preserves_all_permissions() {
    for timed in [false, true] {
        with_bound_borrowed_input(|control, lease, focus| {
            let service = authority(timed);
            let events = [Event::Key {
                key: ScanCode::new(0x1d, false).unwrap(),
                down: true,
            }];
            service
                .input_holds
                .lock()
                .unwrap()
                .update("client", lease, &events, Instant::now());
            control
                .automation_input("client", lease, events.to_vec())
                .unwrap();
            sync_input_control(&service, control);
            assert_eq!(service.state.lock().unwrap().input_owners, vec!["client"]);
            let grants = serde_json::to_value(&service.state.lock().unwrap().grants).unwrap();

            focus(false);
            sync_input_control(&service, control);
            assert!(!control.automation_active("client"));
            assert!(!service.input_holds.lock().unwrap().any(lease));
            assert_eq!(
                service.input_holds.lock().unwrap().result(lease)["holdExpiresInMs"],
                Value::Null
            );
            focus(true);
            assert_eq!(
                control.automation_input("client", lease, vec![Event::Text("stale".into())]),
                Err("CONTROL_REQUIRED".into())
            );
            // A later heartbeat must not mistake the retired scope for an emergency stop.
            sync_input_control(&service, control);
            let s = service.state.lock().unwrap();
            assert!(s.input_owners.is_empty());
            assert!(!s.policies_suspended);
            assert_eq!(serde_json::to_value(&s.grants).unwrap(), grants);
            assert!(s
                .grants
                .values()
                .all(|grant| Service::grant_live(&s, grant)));
            for scope in ["input.control", "diagnostics.read"] {
                assert!(
                    Service::peer_decision(&s, &s.peers["client"], scope)
                        == policy::Decision::Allow
                );
            }
        });
    }
}

#[test]
fn actual_revocation_still_suspends_permissions_even_when_the_borrowed_window_blurs() {
    with_bound_borrowed_input(|control, _, focus| {
        let service = authority(false);
        focus(false);
        control.automation_release("client");
        sync_input_control(&service, control);
        let s = service.state.lock().unwrap();
        assert!(s.input_owners.is_empty());
        assert!(s.policies_suspended);
        assert!(s.grants.is_empty());
    });
}
