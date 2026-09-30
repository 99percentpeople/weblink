use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};
use weblink_desktop_input::{
    authorization::{Binding, Grant, RequestResult},
    engine::{Device, Engine, TrustedTarget},
    input::*,
    protocol::{Signal, Target},
};
#[derive(Default)]
struct State {
    actions: Vec<Action>,
    local: Vec<Held>,
    fail: bool,
    unavailable: bool,
    not_ready: bool,
    panic: bool,
}
#[derive(Clone, Default)]
struct Fake(Rc<RefCell<State>>);
impl Device for Fake {
    fn available(&self) -> bool {
        !self.0.borrow().unavailable
    }
    fn geometry_current(&self, _: Geometry) -> bool {
        self.available()
    }
    fn ready_to_approve(&self) -> bool {
        !self.0.borrow().not_ready
    }
    fn physically_held(&self, held: Held) -> bool {
        self.0.borrow().local.contains(&held)
    }
    fn submit(&mut self, actions: &[Action]) -> Result<(), Error> {
        let mut s = self.0.borrow_mut();
        s.actions.extend(actions);
        if s.panic {
            s.panic = false;
            panic!("device failure")
        }
        if s.fail {
            Err(Error::Injection)
        } else {
            Ok(())
        }
    }
}
fn geometry() -> Geometry {
    Geometry {
        display: Rect {
            left: -1920,
            top: 240,
            width: 1920,
            height: 1080,
        },
        desktop: Rect {
            left: -1920,
            top: 0,
            width: 4480,
            height: 1440,
        },
    }
}
fn target() -> TrustedTarget {
    TrustedTarget {
        geometry: geometry(),
        binding: Binding {
            room_generation: "room".into(),
            peer_generation: "peer".into(),
            client_id: "viewer".into(),
            capture_session_id: "capture".into(),
            target: Target {
                source_id: "screen".into(),
                media_id: "media".into(),
                geometry_revision: "layout".into(),
            },
        },
    }
}
fn pending(e: &mut Engine<Fake>, request: &str, now: Instant) -> String {
    match e
        .request(
            "media",
            &Signal::Request {
                request_id: request.into(),
                target: target().binding.target,
            },
            now,
        )
        .unwrap()
    {
        RequestResult::Pending { consent_id } => consent_id,
        _ => panic!("not pending"),
    }
}
fn setup() -> (Engine<Fake>, Fake, Grant, Instant) {
    let fake = Fake::default();
    let mut engine = Engine::new(fake.clone());
    let now = Instant::now();
    assert!(engine.register(target()));
    let token = pending(&mut engine, "request", now);
    assert!(engine.approve(&token, now).is_some());
    let grant = engine.status().grant.unwrap();
    (engine, fake, grant, now)
}
fn key(down: bool) -> Event {
    Event::Key {
        key: ScanCode::new(0x1e, false).unwrap(),
        down,
    }
}
fn key_held() -> Held {
    Held::Key(ScanCode::new(0x1e, false).unwrap())
}
#[test]
fn maps_physical_pixels_with_negative_origins_and_rejects_bad_geometry() {
    let g = geometry();
    for p in [
        Position { x: 0., y: 0. },
        Position { x: 1., y: 1. },
        Position { x: 0.5, y: 0.5 },
    ] {
        let (x, y) = g.absolute(p).unwrap();
        let actual_x =
            i64::from(g.desktop.left) + i64::from(x) * i64::from(g.desktop.width) / 65536;
        let actual_y =
            i64::from(g.desktop.top) + i64::from(y) * i64::from(g.desktop.height) / 65536;
        assert_eq!(
            actual_x,
            i64::from(g.display.left) + (p.x * f64::from(g.display.width - 1)).round() as i64
        );
        assert_eq!(
            actual_y,
            i64::from(g.display.top) + (p.y * f64::from(g.display.height - 1)).round() as i64
        );
    }
    for x in [f64::NAN, f64::INFINITY, -0.01, 1.001] {
        assert!(g.absolute(Position { x, y: 0.5 }).is_none());
    }
    let bad = Geometry {
        display: Rect {
            left: i32::MAX,
            ..g.display
        },
        ..g
    };
    assert!(!bad.valid());
    let outside = Geometry {
        display: Rect {
            left: -1921,
            ..g.display
        },
        ..g
    };
    assert!(!outside.valid());
    assert!(ScanCode::new(0x37, true).is_none());
    assert!(ScanCode::new(0xff, false).is_none());
    assert_ne!(ScanCode::new(0x1d, false), ScanCode::new(0x1d, true));
}
#[test]
fn exact_grant_and_live_binding_are_required_before_injection() {
    let (mut e, f, g, now) = setup();
    let mut wrong = g.clone();
    wrong.binding.peer_generation = "old".into();
    assert_eq!(e.input(&wrong, key(true), now), Err(Error::Unauthorized));
    assert!(f.0.borrow().actions.is_empty());
    e.invalidate(&g.binding);
    assert_eq!(e.input(&g, key(true), now), Err(Error::Unauthorized));
}
#[test]
fn lease_expiry_releases_buttons_and_modifiers_once_and_cannot_be_renewed() {
    let (mut e, f, g, now) = setup();
    let ctrl = ScanCode::new(0x1d, true).unwrap();
    e.input(
        &g,
        Event::Key {
            key: ctrl,
            down: true,
        },
        now,
    )
    .unwrap();
    e.input(&g, key(true), now).unwrap();
    e.input(
        &g,
        Event::Button {
            position: Position { x: 0.5, y: 0.5 },
            button: Button::Left,
            down: true,
        },
        now,
    )
    .unwrap();
    f.0.borrow_mut().actions.clear();
    e.tick(now + Duration::from_millis(2000));
    assert_eq!(
        f.0.borrow().actions,
        vec![
            Held::Button(Button::Left).up(),
            key_held().up(),
            Held::Key(ctrl).up()
        ]
    );
    assert!(!e.renew(&g, now + Duration::from_millis(2001)));
    drop(e);
    assert_eq!(f.0.borrow().actions.len(), 3);
}
#[test]
fn repeated_key_down_has_one_owned_release_and_unmatched_up_does_not_release_local_input() {
    let (mut e, f, g, now) = setup();
    e.input(&g, key(false), now).unwrap();
    assert!(f.0.borrow().actions.is_empty());
    e.input(&g, key(true), now).unwrap();
    e.input(&g, key(true), now).unwrap();
    e.revoke();
    assert_eq!(f.0.borrow().actions.len(), 3);
    assert_eq!(f.0.borrow().actions[2], key_held().up());
}
#[test]
fn local_overlap_keeps_physical_key_down_and_releases_other_owned_input() {
    let (mut e, f, g, now) = setup();
    e.input(&g, key(true), now).unwrap();
    e.input(
        &g,
        Event::Button {
            position: Position { x: 0.5, y: 0.5 },
            button: Button::Left,
            down: true,
        },
        now,
    )
    .unwrap();
    f.0.borrow_mut().local.push(key_held());
    f.0.borrow_mut().actions.clear();
    e.revoke();
    assert_eq!(f.0.borrow().actions, vec![Held::Button(Button::Left).up()]);
    assert!(e.status().grant.is_none());
}
#[test]
fn held_local_key_blocks_approval_and_cancels_that_pending_consent() {
    let (mut e, f, _, now) = setup();
    e.revoke();
    let consent = pending(&mut e, "next", now);
    f.0.borrow_mut().not_ready = true;
    assert!(e.approve(&consent, now).is_none());
    f.0.borrow_mut().not_ready = false;
    assert!(e.approve(&consent, now).is_none());
}
#[test]
fn invalid_pointer_or_scroll_terminates_and_releases_instead_of_clamping() {
    for event in [
        Event::Move(Position { x: 1.1, y: 0. }),
        Event::Wheel {
            position: Position { x: 0.5, y: 0.5 },
            horizontal: 1201,
            vertical: 0,
        },
    ] {
        let (mut e, f, g, now) = setup();
        e.input(&g, key(true), now).unwrap();
        assert_eq!(e.input(&g, event, now), Err(Error::Invalid));
        assert!(e.status().closed);
        assert_eq!(f.0.borrow().actions.last(), Some(&key_held().up()));
    }
}
#[test]
fn partial_injection_and_failed_release_permanently_close_authority() {
    let (mut e, f, g, now) = setup();
    f.0.borrow_mut().fail = true;
    assert_eq!(e.input(&g, key(true), now), Err(Error::Injection));
    assert_eq!(f.0.borrow().actions.last(), Some(&key_held().up()));
    assert_eq!(e.status().failure, Some(Error::Release));
    f.0.borrow_mut().fail = false;
    assert!(!e.register(target()));
    assert!(!e.renew(&g, now));
    assert!(e.status().closed);
}
#[test]
fn device_panic_unwinds_through_release_without_replaying_input() {
    let (mut e, f, g, now) = setup();
    let observed = f.clone();
    f.0.borrow_mut().panic = true;
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _ = e.input(&g, key(true), now);
    }));
    assert!(r.is_err());
    assert_eq!(observed.0.borrow().actions.last(), Some(&key_held().up()));
}
#[test]
fn availability_loss_drop_and_explicit_failure_all_release() {
    for kind in 0..3 {
        let (mut e, f, g, now) = setup();
        e.input(&g, key(true), now).unwrap();
        match kind {
            0 => {
                f.0.borrow_mut().unavailable = true;
                e.tick(now);
            }
            1 => e.fail(Error::QueueFull),
            _ => {}
        }
        drop(e);
        assert_eq!(f.0.borrow().actions.last(), Some(&key_held().up()));
    }
}
#[test]
fn text_preserves_surrogate_pairs_and_rejects_controls_or_held_modifiers() {
    let (mut e, f, g, now) = setup();
    e.input(&g, Event::Text("中😀".into()), now).unwrap();
    let expected: Vec<_> = "中😀"
        .encode_utf16()
        .flat_map(|unit| {
            [
                Action::Unicode { unit, down: true },
                Action::Unicode { unit, down: false },
            ]
        })
        .collect();
    assert_eq!(f.0.borrow().actions, expected);
    e.input(&g, key(true), now).unwrap();
    assert_eq!(
        e.input(&g, Event::Text("A".into()), now),
        Err(Error::Invalid)
    );
    let (mut e, _, g, now) = setup();
    assert_eq!(
        e.input(&g, Event::Text("\n".into()), now),
        Err(Error::Invalid)
    );
}
#[test]
fn reapproval_never_replays_queued_input_from_revoked_grant() {
    let (mut e, f, g, now) = setup();
    e.input(&g, key(true), now).unwrap();
    e.revoke();
    let token = pending(&mut e, "second", now);
    e.approve(&token, now).unwrap();
    let next = e.status().grant.unwrap();
    assert_ne!(g.id, next.id);
    f.0.borrow_mut().actions.clear();
    assert_eq!(e.input(&g, key(true), now), Err(Error::Unauthorized));
    assert!(f.0.borrow().actions.is_empty());
    e.input(&next, key(true), now).unwrap();
    e.shutdown();
    assert_eq!(f.0.borrow().actions.last(), Some(&key_held().up()));
}

#[test]
fn stale_local_approval_cannot_revoke_a_current_grant_with_held_keys() {
    let (mut e, f, g, now) = setup();
    e.input(&g, key(true), now).unwrap();
    f.0.borrow_mut().not_ready = true;
    assert!(e.approve("stale-consent", now).is_none());
    assert_eq!(e.status().grant, Some(g));
    assert_eq!(f.0.borrow().actions.len(), 1);
}

#[test]
fn cleanup_panic_closes_authority_and_still_releases_remaining_keys() {
    let (mut e, f, g, now) = setup();
    e.input(&g, key(true), now).unwrap();
    e.input(
        &g,
        Event::Key {
            key: ScanCode::new(0x30, false).unwrap(),
            down: true,
        },
        now,
    )
    .unwrap();
    f.0.borrow_mut().panic = true;
    e.revoke();
    assert!(e.status().closed);
    assert_eq!(e.status().failure, Some(Error::Release));
    assert_eq!(f.0.borrow().actions.last(), Some(&key_held().up()));
}

#[test]
fn stale_authorized_input_releases_but_stale_foreign_input_cannot_close_a_new_grant() {
    let (mut e, f, g, now) = setup();
    e.input(&g, key(true), now).unwrap();
    let mut old = g.clone();
    old.id = "old-grant".into();
    let later = now + Duration::from_millis(101);
    assert_eq!(
        e.queued_input(&old, key(false), now, later),
        Err(Error::Unauthorized)
    );
    assert_eq!(e.status().grant, Some(g.clone()));
    assert!(!e.status().closed);
    assert_eq!(
        e.queued_input(&g, key(false), now, later),
        Err(Error::Stale)
    );
    assert!(e.status().closed);
    assert_eq!(f.0.borrow().actions.last(), Some(&key_held().up()));
}
