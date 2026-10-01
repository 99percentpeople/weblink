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
    fail: bool,
    unavailable: bool,
    panic: bool,
    touch_supported: bool,
    pan_supported: bool,
    pans: Vec<weblink_desktop_input::pan::Pan>,
    pan_cancels: usize,
    touch_frames: Vec<Vec<weblink_desktop_input::touch::Action>>,
    touch_cancels: usize,
    cursor: Option<(i32, i32)>,
}
#[derive(Clone, Default)]
struct Fake(Rc<RefCell<State>>);
impl Device for Fake {
    fn pan_supported(&self) -> bool {
        self.0.borrow().pan_supported
    }
    fn submit_pan(&mut self, event: weblink_desktop_input::pan::Pan) -> Result<(), Error> {
        let mut s = self.0.borrow_mut();
        s.pans.push(event);
        if s.fail {
            Err(Error::Injection)
        } else {
            Ok(())
        }
    }
    fn cancel_pan(&mut self) -> Result<(), Error> {
        self.0.borrow_mut().pan_cancels += 1;
        Ok(())
    }
    fn cursor_position(&self) -> Result<(i32, i32), Error> {
        self.0.borrow().cursor.ok_or(Error::Unavailable)
    }
    fn touch_supported(&self) -> bool {
        self.0.borrow().touch_supported
    }
    fn submit_touch(
        &mut self,
        actions: &[weblink_desktop_input::touch::Action],
    ) -> Result<(), Error> {
        let mut s = self.0.borrow_mut();
        s.touch_frames.push(actions.to_vec());
        if s.fail {
            Err(Error::Injection)
        } else {
            Ok(())
        }
    }
    fn cancel_touch(&mut self) -> Result<(), Error> {
        self.0.borrow_mut().touch_cancels += 1;
        Ok(())
    }
    fn available(&self) -> bool {
        !self.0.borrow().unavailable
    }
    fn geometry_current(&self, _: Geometry) -> bool {
        self.available()
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
#[test]
fn trackpad_reads_the_current_system_cursor_and_never_replays_a_cached_position() {
    use weblink_desktop_input::trackpad;
    let (mut e, fake, grant, now) = setup();
    let g = geometry();
    let first = Position { x: 0.2, y: 0.3 };
    fake.0.borrow_mut().cursor = g.pixels(first);
    e.input(
        &grant,
        Event::Trackpad(trackpad::Event::Move { x: 0.1, y: 0.1 }),
        now,
    )
    .unwrap();
    let expected = g.absolute(Position { x: 0.3, y: 0.4 }).unwrap();
    assert_eq!(
        fake.0.borrow().actions.last(),
        Some(&Action::Move {
            x: expected.0,
            y: expected.1
        })
    );
    // Simulate the host's own mouse moving between gestures.
    let current = Position { x: 0.7, y: 0.8 };
    fake.0.borrow_mut().cursor = g.pixels(current);
    e.input(
        &grant,
        Event::Trackpad(trackpad::Event::Button {
            button: 0,
            down: true,
        }),
        now,
    )
    .unwrap();
    let expected = g.absolute(current).unwrap();
    assert_eq!(
        &fake.0.borrow().actions[1..],
        &[
            Action::Move {
                x: expected.0,
                y: expected.1
            },
            Action::Button {
                button: Button::Left,
                down: true
            }
        ]
    );
    e.input(
        &grant,
        Event::Trackpad(trackpad::Event::Button {
            button: 0,
            down: false,
        }),
        now,
    )
    .unwrap();
    e.input(
        &grant,
        Event::Trackpad(trackpad::Event::Wheel {
            horizontal: 0,
            vertical: 120,
        }),
        now,
    )
    .unwrap();
    assert_eq!(
        fake.0.borrow().actions.last(),
        Some(&Action::Wheel {
            horizontal: false,
            delta: 120
        })
    );
}
#[test]
fn trackpad_preserves_subpixel_motion_clamps_to_the_shared_display_and_clears_outside_motion() {
    use weblink_desktop_input::trackpad::{Cursor, Event as Pad};
    let g = geometry();
    let mut cursor = Cursor::default();
    let start = g.pixels(Position { x: 0.5, y: 0.5 }).unwrap();
    let mut current = start;
    for _ in 0..10 {
        let Event::Move(next) = cursor
            .resolve(
                Pad::Move {
                    x: 0.1 / f64::from(g.display.width - 1),
                    y: 0.0,
                },
                current,
                g,
            )
            .unwrap()
        else {
            panic!()
        };
        current = g.pixels(next).unwrap();
    }
    assert_eq!(current, (start.0 + 1, start.1));
    let Event::Move(next) = cursor
        .resolve(Pad::Move { x: -1.0, y: 1.0 }, current, g)
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(next, Position { x: 0.0, y: 1.0 });
    let Event::Move(next) = cursor
        .resolve(Pad::Move { x: 0.1, y: 0.0 }, (-5000, -5000), g)
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(g.pixels(next), g.pixels(Position { x: 0.1, y: 0.0 }));
    assert_eq!(
        cursor.resolve(
            Pad::Move {
                x: f64::NAN,
                y: 0.0
            },
            current,
            g
        ),
        Err(Error::Invalid)
    );
}
#[test]
fn cursor_read_failure_releases_owned_buttons_and_invalidates_control() {
    use weblink_desktop_input::trackpad;
    let (mut e, fake, grant, now) = setup();
    e.input(
        &grant,
        Event::Button {
            position: Position { x: 0.5, y: 0.5 },
            button: Button::Left,
            down: true,
        },
        now,
    )
    .unwrap();
    assert_eq!(
        e.input(
            &grant,
            Event::Trackpad(trackpad::Event::Move { x: 0.1, y: 0.0 }),
            now
        ),
        Err(Error::Unavailable)
    );
    assert!(e.status().closed);
    assert_eq!(
        fake.0.borrow().actions.last(),
        Some(&Action::Button {
            button: Button::Left,
            down: false
        })
    );
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
fn heartbeat_gap_releases_input_and_preserves_consent_until_a_fresh_activation() {
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
    assert_eq!(e.status().grant, Some(g.clone()));
    assert!(e.status().input_suspended);
    let later = now + Duration::from_secs(30);
    assert!(e.renew(&g, later));
    assert_eq!(e.input(&g, key(true), later), Err(Error::Unauthorized));
    e.input(&g, Event::ReleaseAll, later).unwrap();
    assert!(!e.status().input_suspended);
    e.input(&g, key(false), later).unwrap();
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
fn revoking_releases_all_inputs_owned_by_the_grant() {
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
    f.0.borrow_mut().actions.clear();
    e.revoke();
    assert_eq!(
        f.0.borrow().actions,
        vec![Held::Button(Button::Left).up(), key_held().up()]
    );
    assert!(e.status().grant.is_none());
}
#[test]
fn unavailable_desktop_blocks_approval_and_cancels_that_pending_consent() {
    let (mut e, f, _, now) = setup();
    e.revoke();
    let consent = pending(&mut e, "next", now);
    f.0.borrow_mut().unavailable = true;
    assert!(e.approve(&consent, now).is_none());
    f.0.borrow_mut().unavailable = false;
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
    assert!(!e.status().closed);
    assert_eq!(e.status().grant, Some(g));
    assert!(e.status().input_suspended);
    assert_eq!(f.0.borrow().actions.last(), Some(&key_held().up()));
}

#[test]
fn media_callback_invalidation_prevents_already_queued_input_and_releases_owned_buttons() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let fake = Fake::default();
    let mut engine = Engine::new(fake.clone());
    let now = Instant::now();
    let ended = Arc::new(AtomicBool::new(false));
    assert!(engine.register_until(target(), ended.clone()));
    let consent = pending(&mut engine, "request", now);
    engine.approve(&consent, now).unwrap();
    let grant = engine.status().grant.unwrap();
    engine
        .input(
            &grant,
            Event::Button {
                position: Position { x: 0.5, y: 0.5 },
                button: Button::Left,
                down: true,
            },
            now,
        )
        .unwrap();
    fake.0.borrow_mut().actions.clear();
    ended.store(true, Ordering::Release);
    assert!(engine
        .queued_input(&grant, Event::Move(Position { x: 0.9, y: 0.9 }), now, now)
        .is_err());
    assert_eq!(
        fake.0.borrow().actions,
        vec![Action::Button {
            button: Button::Left,
            down: false
        }]
    );
    assert!(engine.status().grant.is_none());
    assert!(!engine.renew(&grant, now));
}

fn touch(
    id: u8,
    phase: weblink_desktop_input::touch::Phase,
) -> weblink_desktop_input::touch::Contact {
    weblink_desktop_input::touch::Contact {
        id,
        x: 0.,
        y: 1.,
        phase,
    }
}
#[test]
fn native_touch_frames_map_physical_pixels_and_release_on_pause_expiry_revoke_and_failure() {
    use weblink_desktop_input::touch::{Action as TouchAction, Phase::*};
    for kind in 0..5 {
        let (mut e, f, g, now) = setup();
        f.0.borrow_mut().touch_supported = true;
        assert!(e.status().touch_supported);
        e.input(&g, Event::Touch(vec![touch(1, Down), touch(2, Down)]), now)
            .unwrap();
        assert_eq!(
            f.0.borrow().touch_frames[0][0],
            TouchAction {
                id: 1,
                x: -1920,
                y: 1319,
                phase: Down
            }
        );
        let before = f.0.borrow().touch_cancels;
        match kind {
            0 => e.input(&g, Event::ReleaseAll, now).unwrap(),
            1 => e.tick(now + Duration::from_secs(2)),
            2 => e.revoke(),
            3 => {
                f.0.borrow_mut().fail = true;
                assert_eq!(
                    e.input(
                        &g,
                        Event::Touch(vec![touch(1, Update), touch(2, Update)]),
                        now
                    ),
                    Err(Error::Injection)
                );
            }
            _ => e.invalidate(&g.binding),
        }
        assert!(f.0.borrow().touch_cancels > before);
    }
}
#[test]
fn touch_rejects_invalid_partial_or_duplicate_frames_and_releases_previous_contacts() {
    use weblink_desktop_input::touch::Phase::*;
    for frame in [
        vec![],
        vec![touch(1, Down)],
        vec![touch(1, Update)],
        vec![touch(1, Update), touch(1, Up)],
        vec![touch(1, Update), touch(3, Up)],
        vec![touch(1, Cancel), touch(2, Update)],
        vec![touch(1, Update), touch(11, Down)],
    ] {
        let (mut e, f, g, now) = setup();
        f.0.borrow_mut().touch_supported = true;
        e.input(&g, Event::Touch(vec![touch(1, Down), touch(2, Down)]), now)
            .unwrap();
        let before = f.0.borrow().touch_cancels;
        assert_eq!(e.input(&g, Event::Touch(frame), now), Err(Error::Invalid));
        assert!(e.status().closed);
        assert!(f.0.borrow().touch_cancels > before);
        assert_eq!(f.0.borrow().touch_frames.len(), 1);
    }
}
#[test]
fn contacts_can_be_reused_only_after_release_and_cannot_mix_with_mouse_or_keys() {
    use weblink_desktop_input::touch::Phase::*;
    let (mut e, f, g, now) = setup();
    f.0.borrow_mut().touch_supported = true;
    for phase in [Down, Update, Up, Down, Cancel, Down] {
        e.input(&g, Event::Touch(vec![touch(1, phase)]), now)
            .unwrap();
    }
    assert_eq!(e.input(&g, key(true), now), Err(Error::Invalid));
    assert!(f.0.borrow().actions.is_empty());
    let (mut e, f, g, now) = setup();
    assert_eq!(
        e.input(&g, Event::Touch(vec![touch(1, Down)]), now),
        Err(Error::Unavailable)
    );
    assert!(f.0.borrow().touch_frames.is_empty());
}

fn pan(gesture: weblink_desktop_input::pan::Pan) -> Event {
    Event::Trackpad(weblink_desktop_input::trackpad::Event::Pan { gesture })
}
#[test]
fn native_pan_uses_current_cursor_and_cancels_on_pause_expiry_revoke_failure_and_media_end() {
    use weblink_desktop_input::pan::Pan;
    for kind in 0..5 {
        let (mut e, f, g, now) = setup();
        f.0.borrow_mut().pan_supported = true;
        f.0.borrow_mut().cursor = Some((-1000, 600));
        assert!(e.status().pan_supported);
        e.input(&g, pan(Pan::Start), now).unwrap();
        e.input(&g, pan(Pan::Update { x: 0.0, y: 42.5 }), now)
            .unwrap();
        assert!(matches!(
            f.0.borrow().actions.as_slice(),
            [Action::Move { .. }]
        ));
        assert_eq!(
            f.0.borrow().pans,
            [Pan::Start, Pan::Update { x: 0.0, y: 42.5 }]
        );
        let before = f.0.borrow().pan_cancels;
        match kind {
            0 => e.input(&g, Event::ReleaseAll, now).unwrap(),
            1 => e.tick(now + Duration::from_secs(2)),
            2 => e.revoke(),
            3 => {
                f.0.borrow_mut().fail = true;
                assert_eq!(e.input(&g, pan(Pan::End), now), Err(Error::Injection));
            }
            _ => e.invalidate(&g.binding),
        }
        assert!(f.0.borrow().pan_cancels > before);
    }
}
#[test]
fn native_pan_rejects_invalid_lifecycle_and_mixed_input_without_wheel_fallback() {
    use weblink_desktop_input::pan::Pan;
    for invalid in [
        pan(Pan::Start),
        pan(Pan::Update { x: 2049.0, y: 0.0 }),
        Event::Move(Position { x: 0.5, y: 0.5 }),
        Event::Touch(vec![touch(1, weblink_desktop_input::touch::Phase::Down)]),
    ] {
        let (mut e, f, g, now) = setup();
        f.0.borrow_mut().pan_supported = true;
        f.0.borrow_mut().cursor = Some((-1000, 600));
        e.input(&g, pan(Pan::Start), now).unwrap();
        assert_eq!(e.input(&g, invalid, now), Err(Error::Invalid));
        assert!(e.status().closed);
    }
    let (mut e, f, g, now) = setup();
    assert_eq!(e.input(&g, pan(Pan::Start), now), Err(Error::Unavailable));
    assert!(f.0.borrow().actions.is_empty());
    let (mut e, f, g, now) = setup();
    f.0.borrow_mut().pan_supported = true;
    assert_eq!(e.input(&g, pan(Pan::End), now), Err(Error::Invalid));
}
#[test]
fn native_pan_can_end_then_click_or_restart_and_late_updates_cannot_continue_it() {
    use weblink_desktop_input::pan::Pan;
    let (mut e, f, g, now) = setup();
    f.0.borrow_mut().pan_supported = true;
    f.0.borrow_mut().cursor = Some((-1000, 600));
    for gesture in [Pan::Start, Pan::End, Pan::Start, Pan::Cancel] {
        e.input(&g, pan(gesture), now).unwrap();
    }
    e.input(
        &g,
        Event::Trackpad(weblink_desktop_input::trackpad::Event::Button {
            button: 2,
            down: true,
        }),
        now,
    )
    .unwrap();
    assert_eq!(
        e.input(&g, pan(Pan::Update { x: 0.0, y: 1.0 }), now),
        Err(Error::Unavailable)
    );
    assert!(e.status().closed);
}

#[test]
fn interrupted_input_requires_fresh_activation_without_another_approval() {
    let (mut e, f, g, now) = setup();
    e.input(&g, key(true), now).unwrap();
    e.interrupt();
    assert_eq!(e.status().grant, Some(g.clone()));
    assert!(!e.status().closed);
    assert!(e.status().input_suspended);
    assert_eq!(f.0.borrow().actions.last(), Some(&key_held().up()));
    assert_eq!(e.input(&g, key(true), now), Err(Error::Unauthorized));
    e.input(&g, Event::ReleaseAll, now).unwrap();
    e.input(&g, key(true), now).unwrap();
    assert!(!e.status().input_suspended);
    e.revoke();
    assert!(e.status().grant.is_none());
    assert!(!e.renew(&g, now));
}
