use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};
use weblink_desktop_input::{
    authorization::{Binding, Grant, RequestResult},
    devices::{Availability, Capability, Key, Kind, Manager, State as MountState},
    engine::{Device, Engine, TrustedTarget},
    gamepad::{self, Event as PadEvent},
    input::{Action, Error, Event, Geometry, Position, Rect, ScanCode},
    protocol::{Signal, Target},
};
#[derive(Default)]
struct Calls {
    feedback: Vec<(u8, gamepad::Rumble)>,
    mounts: Vec<Key>,
    unmounts: Vec<Key>,
    reports: Vec<(u8, gamepad::State)>,
    actions: Vec<Action>,
    missing_driver: bool,
    mount_fail: bool,
    submit_fail: bool,
    unmount_fail: Option<Kind>,
    panic_mount: bool,
}
#[derive(Clone, Default)]
struct Fake(Rc<RefCell<Calls>>);
impl Device for Fake {
    fn gamepad_feedback(&mut self) -> Vec<(u8, gamepad::Rumble)> {
        self.0.borrow().feedback.clone()
    }
    fn reset_gamepad_feedback(&mut self, slot: u8) {
        self.0.borrow_mut().feedback.retain(|(s, _)| *s != slot);
    }
    fn available(&self) -> bool {
        true
    }
    fn geometry_current(&self, _: Geometry) -> bool {
        true
    }
    fn submit(&mut self, actions: &[Action]) -> Result<(), Error> {
        self.0.borrow_mut().actions.extend(actions);
        Ok(())
    }
    fn capabilities(&self) -> Vec<Capability> {
        Kind::ALL
            .into_iter()
            .map(|kind| {
                let mut c = Capability::system(kind, true);
                if kind == Kind::Gamepad {
                    c.max_devices = 4;
                    if self.0.borrow().missing_driver {
                        c.availability = Availability::DriverRequired;
                    }
                }
                c
            })
            .collect()
    }
    fn mount(&mut self, key: Key) -> Result<(), Error> {
        let mut calls = self.0.borrow_mut();
        calls.mounts.push(key);
        if calls.panic_mount {
            panic!("partial mount");
        }
        if calls.mount_fail {
            Err(Error::Unavailable)
        } else {
            Ok(())
        }
    }
    fn unmount(&mut self, key: Key) -> Result<(), Error> {
        let mut calls = self.0.borrow_mut();
        calls.unmounts.push(key);
        if calls.unmount_fail == Some(key.kind) {
            Err(Error::Release)
        } else {
            Ok(())
        }
    }
    fn submit_gamepad(&mut self, slot: u8, state: gamepad::State) -> Result<(), Error> {
        let mut calls = self.0.borrow_mut();
        calls.reports.push((slot, state));
        if calls.submit_fail {
            Err(Error::Unavailable)
        } else {
            Ok(())
        }
    }
    fn pan_supported(&self) -> bool {
        true
    }
    fn touch_supported(&self) -> bool {
        true
    }
    fn submit_pan(&mut self, _: weblink_desktop_input::pan::Pan) -> Result<(), Error> {
        Ok(())
    }
    fn submit_touch(&mut self, _: &[weblink_desktop_input::touch::Action]) -> Result<(), Error> {
        Ok(())
    }
    fn cursor_position(&self) -> Result<(i32, i32), Error> {
        Ok((0, 0))
    }
}
fn setup() -> (Engine<Fake>, Fake, Grant, Instant) {
    let fake = Fake::default();
    let mut e = Engine::new(fake.clone());
    let now = Instant::now();
    let target = Target {
        source_id: "screen".into(),
        media_id: "media".into(),
        geometry_revision: "geometry".into(),
    };
    let binding = Binding {
        room_generation: "room".into(),
        peer_generation: "peer".into(),
        client_id: "client".into(),
        capture_session_id: "capture".into(),
        target: target.clone(),
    };
    let display = Rect {
        left: 0,
        top: 0,
        width: 100,
        height: 100,
    };
    assert!(e.register(TrustedTarget {
        binding,
        geometry: Geometry {
            display,
            desktop: display
        }
    }));
    let Some(RequestResult::Pending { consent_id }) = e.request(
        "media",
        &Signal::Request {
            request_id: "request".into(),
            target,
        },
        now,
    ) else {
        panic!()
    };
    e.approve(&consent_id, now).unwrap();
    let grant = e.status().grant.unwrap();
    (e, fake, grant, now)
}
fn pad(action: &str, id: &str) -> Event {
    Event::Gamepad(match action {
        "connect" => PadEvent::Connect {
            slot: 0,
            id: id.into(),
        },
        "disconnect" => PadEvent::Disconnect {
            slot: 0,
            id: id.into(),
        },
        _ => PadEvent::State {
            slot: 0,
            id: id.into(),
            state: gamepad::State {
                buttons: 1,
                axes: [0.5; 4],
                triggers: [1.0; 2],
            },
        },
    })
}

#[test]
fn all_five_devices_share_lazy_grant_ownership_and_unmount_on_every_session_end() {
    for end in 0..5 {
        let (mut e, fake, grant, now) = setup();
        assert!(e.status().devices.mounted.is_empty());
        assert!(fake.0.borrow().mounts.is_empty());
        let key = ScanCode::new(30, false).unwrap();
        for down in [true, false] {
            e.input(&grant, Event::Key { key, down }, now).unwrap();
        }
        e.input(&grant, Event::Move(Position { x: 0.5, y: 0.5 }), now)
            .unwrap();
        for gesture in [
            weblink_desktop_input::pan::Pan::Start,
            weblink_desktop_input::pan::Pan::End,
        ] {
            e.input(
                &grant,
                Event::Trackpad(weblink_desktop_input::trackpad::Event::Pan { gesture }),
                now,
            )
            .unwrap();
        }
        for phase in [
            weblink_desktop_input::touch::Phase::Down,
            weblink_desktop_input::touch::Phase::Up,
        ] {
            e.input(
                &grant,
                Event::Touch(vec![weblink_desktop_input::touch::Contact {
                    id: 1,
                    x: 0.5,
                    y: 0.5,
                    phase,
                    pressure: None,
                    width: None,
                    height: None,
                }]),
                now,
            )
            .unwrap();
        }
        e.input(&grant, pad("connect", "one"), now).unwrap();
        e.input(&grant, pad("state", "one"), now).unwrap();
        e.input(&grant, Event::Key { key, down: true }, now)
            .unwrap();
        assert_eq!(e.status().devices.mounted.len(), 5);
        assert_eq!(fake.0.borrow().mounts.len(), 5);
        match end {
            0 => e.revoke(),
            1 => e.invalidate(&grant.binding),
            2 => e.tick(now + Duration::from_secs(3)),
            3 => e.shutdown(),
            _ => {
                drop(e);
                let calls = fake.0.borrow();
                assert_eq!(calls.unmounts.len(), 5);
                assert_eq!(calls.reports.last().unwrap().1, gamepad::State::default());
                continue;
            }
        }
        assert!(e.status().devices.mounted.is_empty());
        assert_eq!(fake.0.borrow().unmounts.len(), 5);
        assert_eq!(
            fake.0.borrow().reports.last().unwrap().1,
            gamepad::State::default()
        );
        assert_eq!(
            fake.0.borrow().actions.last(),
            Some(&Action::Key { key, down: false })
        );
    }
}

#[test]
fn paused_or_stale_gamepad_is_neutralized_without_revoking_the_grant() {
    let (mut e, fake, grant, now) = setup();
    e.input(&grant, pad("connect", "one"), now).unwrap();
    e.input(&grant, pad("state", "one"), now).unwrap();
    e.tick(now + gamepad::STALE_AFTER);
    assert_eq!(
        fake.0.borrow().reports.last().unwrap().1,
        gamepad::State::default()
    );
    assert_eq!(e.status().devices.mounted[0].state, MountState::Suspended);
    assert_eq!(e.status().grant, Some(grant.clone()));
    e.input(
        &grant,
        pad("state", "one"),
        now + Duration::from_millis(510),
    )
    .unwrap();
    e.interrupt();
    assert!(e.status().devices.mounted.is_empty());
    assert_eq!(
        fake.0.borrow().reports.last().unwrap().1,
        gamepad::State::default()
    );
    assert!(e
        .input(
            &grant,
            pad("state", "one"),
            now + Duration::from_millis(520)
        )
        .is_err());
}

#[test]
fn feedback_requires_a_live_grant_and_current_mounted_identity() {
    let (mut e, fake, grant, now) = setup();
    fake.0.borrow_mut().feedback = vec![
        (
            0,
            gamepad::Rumble {
                strong: 255,
                weak: 64,
            },
        ),
        (3, Default::default()),
    ];
    assert!(e.gamepad_feedback(now).is_empty());
    e.input(&grant, pad("connect", "one"), now).unwrap();
    let feedback = e.gamepad_feedback(now);
    assert_eq!(feedback.len(), 1);
    assert_eq!(feedback[0].grant, grant);
    assert_eq!(feedback[0].id, "one");
    assert_eq!(feedback[0].rumble.strong, 255);
    assert!(e.gamepad_feedback(now + gamepad::STALE_AFTER).is_empty());
    e.tick(now + gamepad::STALE_AFTER);
    e.input(
        &grant,
        pad("state", "one"),
        now + Duration::from_millis(510),
    )
    .unwrap();
    assert!(
        e.gamepad_feedback(now + Duration::from_millis(510))
            .is_empty(),
        "stale rumble must not resume with input"
    );
    fake.0.borrow_mut().feedback = vec![(
        0,
        gamepad::Rumble {
            strong: 10,
            weak: 20,
        },
    )];
    e.interrupt();
    assert!(e.gamepad_feedback(now).is_empty());
    e.input(&grant, Event::ReleaseAll, now).unwrap();
    e.input(&grant, pad("connect", "two"), now).unwrap();
    fake.0.borrow_mut().feedback = vec![(
        0,
        gamepad::Rumble {
            strong: 10,
            weak: 20,
        },
    )];
    assert_eq!(e.gamepad_feedback(now)[0].id, "two");
    e.revoke();
    assert!(e.gamepad_feedback(now).is_empty());
}

#[test]
fn duplicate_connect_and_late_updates_cannot_unplug_or_drive_a_replacement() {
    let (mut e, fake, grant, now) = setup();
    for id in ["one", "one", "two"] {
        e.input(&grant, pad("connect", id), now).unwrap();
    }
    assert_eq!(fake.0.borrow().mounts.len(), 2);
    let reports = fake.0.borrow().reports.len();
    e.input(&grant, pad("disconnect", "one"), now).unwrap();
    e.input(&grant, pad("state", "one"), now).unwrap();
    assert_eq!(fake.0.borrow().reports.len(), reports);
    assert_eq!(fake.0.borrow().unmounts.len(), 1);
    assert_eq!(e.status().devices.mounted.len(), 1);
}

#[test]
fn optional_driver_and_device_failures_leave_keyboard_and_mouse_usable() {
    for failure in 0..3 {
        let (mut e, fake, grant, now) = setup();
        fake.0.borrow_mut().missing_driver = failure == 0;
        fake.0.borrow_mut().mount_fail = failure == 1;
        let result = e.input(&grant, pad("connect", "one"), now);
        if failure == 2 {
            result.unwrap();
            fake.0.borrow_mut().submit_fail = true;
            assert_eq!(
                e.input(&grant, pad("state", "one"), now),
                Err(Error::Unavailable)
            );
        } else {
            assert_eq!(result, Err(Error::Unavailable));
        }
        fake.0.borrow_mut().mount_fail = false;
        assert!(!e.status().closed);
        assert!(e.status().devices.mounted.is_empty());
        e.input(&grant, Event::Move(Position { x: 0.2, y: 0.2 }), now)
            .unwrap();
        e.input(
            &grant,
            Event::Key {
                key: ScanCode::new(30, false).unwrap(),
                down: true,
            },
            now,
        )
        .unwrap();
    }
}

#[test]
fn failed_cleanup_still_attempts_every_device_and_closes_authority() {
    let (mut e, fake, grant, now) = setup();
    e.input(
        &grant,
        Event::Key {
            key: ScanCode::new(30, false).unwrap(),
            down: true,
        },
        now,
    )
    .unwrap();
    e.input(&grant, pad("connect", "one"), now).unwrap();
    fake.0.borrow_mut().unmount_fail = Some(Kind::Keyboard);
    e.revoke();
    assert!(e.status().closed);
    assert!(fake
        .0
        .borrow()
        .unmounts
        .iter()
        .any(|key| key.kind == Kind::Gamepad));
    assert_eq!(e.status().devices.mounted[0].state, MountState::Failed);
}

#[test]
fn partial_mount_panic_remains_owned_for_drop_cleanup() {
    let fake = Fake::default();
    fake.0.borrow_mut().panic_mount = true;
    let mut manager = Manager::new(fake.clone());
    let key = Key::single(Kind::Mouse);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| manager.ensure(key))).is_err()
    );
    drop(manager);
    assert_eq!(fake.0.borrow().unmounts, [key]);
}

#[test]
fn gamepad_wire_validates_ranges_slots_identity_and_action_before_injection() {
    let mut value = serde_json::json!({ "type":"input", "grantId":"grant", "generation":"media", "geometryRevision":"geometry", "inputEpoch":"epoch", "activationSequence":1, "sequence":2,
        "event": { "type":"gamepad", "action":"state", "id":"pad", "slot":0, "state": { "buttons":1, "axes":[0,0,0,0], "triggers":[0,1] } } });
    assert!(weblink_desktop_input::wire::parse(value.to_string().as_bytes()).is_some());
    for bad in [
        serde_json::json!(4),
        serde_json::json!(-1),
        serde_json::json!(0.5),
    ] {
        value["event"]["slot"] = bad;
        assert!(weblink_desktop_input::wire::parse(value.to_string().as_bytes()).is_none());
    }
    value["event"]["slot"] = serde_json::json!(0);
    value["event"]["state"]["axes"] = serde_json::json!([0, 0, 0, 1.1]);
    assert!(weblink_desktop_input::wire::parse(value.to_string().as_bytes()).is_none());
    value["event"] =
        serde_json::json!({ "type":"gamepad", "action":"connect", "id":"pad", "slot":0 });
    assert!(weblink_desktop_input::wire::parse(value.to_string().as_bytes()).is_some());
}
