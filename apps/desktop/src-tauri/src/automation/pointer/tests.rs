use super::super::input_holds::{Holds, HOLD_LIMIT};
use super::super::input_runner::Plan;
use super::super::input_runner::{self as runner, Clock, Sink};
use super::super::*;
use std::cell::{Cell, RefCell};
use weblink_desktop_input::input::{Button, Event};
use weblink_desktop_input::input::{Geometry, Position, Rect};
fn geometry() -> Geometry {
    Geometry {
        display: Rect {
            left: -1000,
            top: -100,
            width: 1000,
            height: 1000,
        },
        desktop: Rect {
            left: -1000,
            top: -100,
            width: 2000,
            height: 1100,
        },
    }
}
fn args(action: &str) -> Value {
    json!({"target":"local","coordinateSpace":"desktopPhysicalPixels","sourceId":"monitor","geometryRevision":"rev","action":action,"x":-900,"y":0})
}
fn drag() -> Value {
    let mut a = args("drag");
    a["path"] = json!([{"x":-500,"y":300},{"x":-100,"y":700}]);
    a["durationMs"] = json!(160);
    a
}
#[derive(Default)]
struct Fake {
    elapsed: Cell<Duration>,
    events: RefCell<Vec<(Duration, Event)>>,
    held: RefCell<Vec<Button>>,
    fail_at: Cell<Option<usize>>,
    stop_at: Cell<Option<(Duration, &'static str)>>,
    aborted: Cell<usize>,
    current_lease: Cell<u8>,
    replace_at: Cell<Option<Duration>>,
    stall: Cell<bool>,
}
impl Fake {
    fn new() -> Self {
        Self {
            current_lease: Cell::new(1),
            ..Self::default()
        }
    }
    fn run(&self, args: &Value) -> Result<usize, String> {
        let plan = Plan::pointer(args, geometry(), &self.held.borrow())?;
        runner::run_with_clock(plan, self, self)
    }
}
impl Clock for Fake {
    fn elapsed(&self) -> Duration {
        self.elapsed.get()
    }
    fn sleep(&self, duration: Duration) {
        self.elapsed.set(
            self.elapsed.get()
                + if self.stall.get() {
                    Duration::from_secs(2)
                } else {
                    duration
                },
        );
        if self
            .replace_at
            .get()
            .is_some_and(|at| self.elapsed.get() >= at)
        {
            self.current_lease.set(2); // simulate a new owner's mouse already held
            *self.held.borrow_mut() = vec![Button::Right];
        }
    }
}
impl Sink for Fake {
    fn check(&self) -> Result<(), String> {
        if self.current_lease.get() != 1 {
            return Err("CONTROL_REQUIRED".into());
        }
        if let Some((at, code)) = self.stop_at.get() {
            if self.elapsed.get() >= at {
                return Err(code.into());
            }
        }
        Ok(())
    }
    fn send(&self, events: Vec<Event>) -> Result<(), String> {
        self.check()?;
        for event in events {
            if let Event::Button { button, down, .. } = &event {
                if *down {
                    self.held.borrow_mut().push(*button);
                } else {
                    self.held.borrow_mut().retain(|b| b != button);
                }
            }
            self.events.borrow_mut().push((self.elapsed.get(), event));
            // Injection may already have pressed a button before returning an error.
            if self.fail_at.get() == Some(self.events.borrow().len()) {
                return Err("INJECTION_FAILED".into());
            }
        }
        Ok(())
    }
    fn abort(&self) {
        self.aborted.set(self.aborted.get() + 1);
        if self.current_lease.get() == 1 {
            self.held.borrow_mut().clear();
        }
    }
}
#[test]
fn drag_interpolates_waypoints_in_order_and_releases_at_destination() {
    let fake = Fake::new();
    fake.run(&drag()).unwrap();
    let events = fake.events.borrow();
    assert!(matches!(
        events.first().unwrap().1,
        Event::Button { down: true, .. }
    ));
    assert!(matches!(
        events.last().unwrap().1,
        Event::Button { down: false, .. }
    ));
    let points: Vec<_> = events
        .iter()
        .filter_map(|(_, e)| {
            if let Event::Move(p) = e {
                geometry().pixels(*p)
            } else {
                None
            }
        })
        .collect();
    assert!(points.len() > 2);
    assert!(points.contains(&(-500, 300)));
    assert_eq!(points.last(), Some(&(-100, 700)));
    assert!(events
        .windows(2)
        .all(|w| w[1].0 >= w[0].0 && w[1].0 - w[0].0 <= Duration::from_millis(16)));
    assert_eq!(fake.elapsed.get(), Duration::from_millis(160));
    assert!(fake.held.borrow().is_empty());
    assert_eq!(fake.aborted.get(), 0);
}
#[test]
fn down_move_up_preserves_button_between_calls_and_rejects_conflicting_gestures() {
    let fake = Fake::new();
    fake.run(&args("down")).unwrap();
    assert_eq!(*fake.held.borrow(), vec![Button::Left]);
    assert_eq!(fake.run(&args("down")).unwrap_err(), "BUTTON_ALREADY_DOWN");
    assert_eq!(fake.run(&drag()).unwrap_err(), "BUTTON_HELD");
    assert_eq!(fake.run(&args("click")).unwrap_err(), "BUTTON_HELD");
    let mut moving = drag();
    moving["action"] = json!("move");
    fake.run(&moving).unwrap();
    assert_eq!(*fake.held.borrow(), vec![Button::Left]);
    fake.elapsed.set(Duration::ZERO); // each call has its own clock origin
    fake.run(&args("up")).unwrap();
    assert!(fake.held.borrow().is_empty());
    assert_eq!(fake.run(&args("up")).unwrap_err(), "BUTTON_NOT_DOWN");
}
#[test]
fn click_timing_horizontal_scroll_and_extra_buttons_are_explicit() {
    let fake = Fake::new();
    let mut a = args("click");
    a["clickCount"] = json!(2);
    a["holdMs"] = json!(40);
    a["intervalMs"] = json!(120);
    fake.run(&a).unwrap();
    assert_eq!(
        fake.events
            .borrow()
            .iter()
            .map(|(t, _)| t.as_millis())
            .collect::<Vec<_>>(),
        vec![0, 40, 160, 200]
    );
    let fake = Fake::new();
    let mut a = args("scroll");
    a["scrollX"] = json!(120);
    a["scrollY"] = json!(-240);
    fake.run(&a).unwrap();
    assert!(matches!(
        fake.events.borrow()[0].1,
        Event::Wheel {
            horizontal: 120,
            vertical: -240,
            ..
        }
    ));
    for name in ["right", "middle", "back", "forward"] {
        let fake = Fake::new();
        let mut a = args("down");
        a["button"] = json!(name);
        fake.run(&a).unwrap();
        a["action"] = json!("up");
        fake.run(&a).unwrap();
        assert!(fake.held.borrow().is_empty());
    }
}
#[test]
fn validates_entire_path_and_action_specific_fields_before_injection() {
    let fake = Fake::new();
    let mut bad = drag();
    bad["path"][1]["x"] = json!(0);
    assert_eq!(fake.run(&bad).unwrap_err(), "OUT_OF_BOUNDS");
    assert!(fake.events.borrow().is_empty());
    for mutate in [
        json!({"action":"drag"}),
        json!({"action":"move","button":"left"}),
        json!({"action":"move","durationMs":100}),
        json!({"action":"click","path":[{"x":-1,"y":0}]}),
        json!({"action":"scroll","scrollY":120}),
        json!({"action":"click","clickCount":3}),
    ] {
        let mut a = args("move");
        for (k, v) in mutate.as_object().unwrap() {
            a[k] = v.clone();
        }
        assert!(fake.run(&a).is_err());
    }
    for path in [
        json!([]),
        json!(vec![json!({"x":-1,"y":0}); 129]),
        json!([{"x":-1,"y":0,"untrusted":true}]),
    ] {
        let mut a = drag();
        a["path"] = path;
        assert!(fake.run(&a).is_err());
    }
    assert!(fake.events.borrow().is_empty());
}
#[test]
fn all_interruptions_release_pressed_buttons_and_stop_later_events() {
    for reason in [
        "CANCELLED",
        "GRANT_EXPIRED",
        "SESSION_CLOSED",
        "WINDOW_FOCUS_LOST",
        "WINDOW_UNAVAILABLE",
        "GEOMETRY_CHANGED",
        "APPROVAL_PENDING",
    ] {
        let fake = Fake::new();
        fake.stop_at.set(Some((Duration::from_millis(32), reason)));
        assert_eq!(fake.run(&drag()).unwrap_err(), reason);
        assert_eq!(fake.aborted.get(), 1);
        assert!(fake.held.borrow().is_empty());
        assert!(fake.events.borrow().last().unwrap().0 < Duration::from_millis(32));
    }
    let fake = Fake::new();
    fake.fail_at.set(Some(1));
    assert_eq!(fake.run(&drag()).unwrap_err(), "INJECTION_FAILED");
    assert!(fake.held.borrow().is_empty());
    let fake = Fake::new();
    fake.stall.set(true);
    assert_eq!(fake.run(&drag()).unwrap_err(), "INPUT_STALLED");
    assert_eq!(fake.events.borrow().len(), 1);
    assert!(fake.held.borrow().is_empty());
}
#[test]
fn stale_cleanup_never_releases_replacement_control_and_pre_dispatch_cancel_has_no_effect() {
    let fake = Fake::new();
    fake.replace_at.set(Some(Duration::from_millis(16)));
    assert_eq!(fake.run(&drag()).unwrap_err(), "CONTROL_REQUIRED");
    assert_eq!(*fake.held.borrow(), vec![Button::Right]);
    let fake = Fake::new();
    fake.stop_at.set(Some((Duration::ZERO, "CANCELLED")));
    assert_eq!(fake.run(&drag()).unwrap_err(), "CANCELLED");
    assert!(fake.events.borrow().is_empty());
    assert_eq!(fake.aborted.get(), 0);
}
#[test]
fn hold_watchdog_does_not_extend_with_moves_or_clear_a_new_lease() {
    let mut holds = Holds::default();
    let start = Instant::now();
    let p = Position { x: 0., y: 0. };
    let down = Event::Button {
        position: p,
        button: Button::Left,
        down: true,
    };
    holds.update("owner", "old", &[down.clone()], start);
    holds.update(
        "owner",
        "old",
        &[Event::Move(p)],
        start + Duration::from_secs(29),
    );
    assert!(holds
        .expired(start + Duration::from_secs(29), false)
        .is_none());
    assert_eq!(
        holds.expired(start + HOLD_LIMIT, false),
        Some(("owner".into(), "old".into()))
    );
    holds.update("owner", "new", &[down.clone()], start);
    holds.clear("old");
    assert_eq!(holds.buttons("new"), vec![Button::Left]);
    assert_eq!(
        holds.expired(start, true),
        Some(("owner".into(), "new".into()))
    );
    holds.update("owner", "newer", &[down], start);
    holds.update(
        "owner",
        "newer",
        &[Event::Button {
            position: p,
            button: Button::Left,
            down: false,
        }],
        start,
    );
    assert!(holds.buttons("newer").is_empty());
    assert!(holds.expired(start + HOLD_LIMIT, false).is_none());
}
#[test]
fn maximum_path_is_bounded_and_small_numbers_are_physical_pixels() {
    let mut a = drag();
    a["path"] = json!(vec![json!({"x":-1,"y":0}); 128]);
    a["durationMs"] = json!(10000);
    let p = Plan::pointer(&a, geometry(), &[]).unwrap();
    assert!(p.steps.len() <= 800);
    assert_eq!(p.steps.last().unwrap().at, Duration::from_secs(10));
    let r = Rect {
        left: 0,
        top: 0,
        width: 1920,
        height: 1080,
    };
    let g = Geometry {
        display: r,
        desktop: r,
    };
    let mut a = args("move");
    a["x"] = json!(1);
    a["y"] = json!(1);
    let p = Plan::pointer(&a, g, &[]).unwrap();
    let Event::Move(point) = p.steps[0].events[0] else {
        panic!()
    };
    assert_eq!(g.pixels(point), Some((1, 1)));
}
