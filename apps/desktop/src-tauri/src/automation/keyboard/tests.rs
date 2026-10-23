use super::super::{
    catalog,
    input_holds::{Holds, HOLD_LIMIT},
    input_runner::{self, Clock, Plan, Sink},
};
use super::*;
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    time::{Duration, Instant},
};
use weblink_desktop_input::input::{Button, Event, Geometry, Position, Rect};

fn args(action: &str, name: &str) -> Value {
    json!({"target":"local","action":action,"key":name})
}
fn chord() -> Value {
    json!({"target":"local","action":"chord","keys":["ControlLeft","ShiftLeft","KeyS"],"holdMs":40,"repeat":2,"intervalMs":120})
}
struct Fake {
    start: Instant,
    elapsed: Cell<Duration>,
    cost: Cell<Duration>,
    events: RefCell<Vec<(Duration, Event)>>,
    holds: RefCell<Holds>,
    stop_after: Cell<Option<usize>>,
    failure: Cell<&'static str>,
    fail_at: Cell<Option<usize>>,
    replace_at: Cell<Option<usize>>,
    lease: Cell<&'static str>,
    aborted: Cell<usize>,
}
impl Fake {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            elapsed: Cell::new(Duration::ZERO),
            cost: Cell::new(Duration::ZERO),
            events: Default::default(),
            holds: Default::default(),
            stop_after: Cell::new(None),
            failure: Cell::new("CANCELLED"),
            fail_at: Cell::new(None),
            replace_at: Cell::new(None),
            lease: Cell::new("old"),
            aborted: Cell::new(0),
        }
    }
    fn run(&self, plan: Plan) -> Result<usize, String> {
        self.elapsed.set(Duration::ZERO);
        input_runner::run_with_clock(plan, self, self)
    }
    fn key(&self, a: &Value) -> Result<usize, String> {
        let plan = Plan::key(a, &self.holds.borrow().keys("old"))?;
        self.run(plan)
    }
    fn text(&self, a: &Value) -> Result<usize, String> {
        let plan = Plan::text(a, self.holds.borrow().any("old"))?;
        self.run(plan)
    }
}
impl Clock for Fake {
    fn elapsed(&self) -> Duration {
        self.elapsed.get()
    }
    fn sleep(&self, duration: Duration) {
        self.elapsed.set(self.elapsed.get() + duration);
    }
}
impl Sink for Fake {
    fn check(&self) -> Result<(), String> {
        if self.lease.get() != "old" {
            return Err("CONTROL_REQUIRED".into());
        }
        if self
            .stop_after
            .get()
            .is_some_and(|n| self.events.borrow().len() >= n)
        {
            return Err(self.failure.get().into());
        }
        Ok(())
    }
    fn send(&self, events: Vec<Event>) -> Result<(), String> {
        self.check()?;
        self.holds
            .borrow_mut()
            .update("owner", "old", &events, self.start + self.elapsed.get());
        for event in events {
            self.events.borrow_mut().push((self.elapsed.get(), event));
        }
        self.elapsed.set(self.elapsed.get() + self.cost.get());
        let count = self.events.borrow().len();
        if self.replace_at.get() == Some(count) {
            self.lease.set("new");
            self.holds.borrow_mut().update(
                "owner",
                "new",
                &[Event::Key {
                    key: key("AltRight")?,
                    down: true,
                }],
                self.start,
            );
        }
        if self.fail_at.get() == Some(count) {
            return Err("INJECTION_FAILED".into());
        }
        Ok(())
    }
    fn abort(&self) {
        self.aborted.set(self.aborted.get() + 1);
        self.holds.borrow_mut().clear("old");
    }
}
#[test]
fn shared_key_names_roundtrip_and_schema_covers_exact_native_whitelist() {
    let schema = catalog::find("control.key").unwrap();
    let names = schema["inputSchema"]["properties"]["key"]["enum"]
        .as_array()
        .unwrap();
    assert_eq!(names.len(), codes().len());
    let mut unique = std::collections::BTreeSet::new();
    for n in names {
        let n = n.as_str().unwrap();
        let k = key(n).unwrap();
        assert_eq!(name(k), n);
        assert!(unique.insert((k.code(), k.extended())));
    }
    assert_ne!(key("ControlLeft").unwrap(), key("ControlRight").unwrap());
    assert!(key("NumpadEnter").unwrap().extended());
    for n in ["Ctrl", "a", "PrintScreen", "Pause", "F13"] {
        assert!(key(n).is_err());
    }
}
#[test]
fn alt_f4_focus_loss_releases_keys_without_replaying_the_remaining_sequence() {
    use super::super::input_sequence::window_result;
    use weblink_desktop_input::{
        input::Error,
        window::{BoundWindow, WindowGuard},
    };
    struct LostWindow;
    impl WindowGuard for LostWindow {
        fn check(&self, _: Option<(i32, i32)>) -> Result<(), Error> {
            Err(Error::WindowUnavailable)
        }
        fn activate(&self) -> Result<(), Error> {
            panic!("Never refocus an interrupted input target")
        }
    }
    let window: BoundWindow = std::sync::Arc::new(LostWindow);
    let f = Fake::new();
    // Both downs were sent; native lease cleanup wins the next authority check.
    f.stop_after.set(Some(2));
    f.failure.set("CONTROL_REQUIRED");
    let result = f.key(&json!({"target":"local","action":"chord","keys":["AltLeft","F4"]}));
    assert_eq!(result, Err("CONTROL_REQUIRED".into()));
    assert_eq!(
        window_result(result, Some(&window), || Ok(())),
        Err("WINDOW_FOCUS_LOST".into())
    );
    assert_eq!(f.events.borrow().len(), 2);
    assert_eq!(f.aborted.get(), 1);
    assert!(!f.holds.borrow().any("old"));
}
#[test]
fn chords_press_in_order_release_in_reverse_and_repeat_after_the_gap() {
    let f = Fake::new();
    f.key(&chord()).unwrap();
    let actual: Vec<_> = f
        .events
        .borrow()
        .iter()
        .map(|(t, e)| match e {
            Event::Key { key, down } => (t.as_millis(), name(*key), *down),
            _ => panic!(),
        })
        .collect();
    assert_eq!(
        actual,
        vec![
            (0, "ControlLeft", true),
            (0, "ShiftLeft", true),
            (0, "KeyS", true),
            (40, "KeyS", false),
            (40, "ShiftLeft", false),
            (40, "ControlLeft", false),
            (160, "ControlLeft", true),
            (160, "ShiftLeft", true),
            (160, "KeyS", true),
            (200, "KeyS", false),
            (200, "ShiftLeft", false),
            (200, "ControlLeft", false),
        ]
    );
    assert!(!f.holds.borrow().any("old"));
    // Native submission time must not consume the requested hold time.
    let f = Fake::new();
    f.cost.set(Duration::from_millis(20));
    f.key(&args("press", "Enter")).unwrap();
    assert_eq!(f.events.borrow()[1].0, Duration::from_millis(50));
}
#[test]
fn held_modifier_survives_key_presses_and_a_pointer_drag_until_explicit_up() {
    let f = Fake::new();
    f.key(&args("down", "ShiftLeft")).unwrap();
    f.key(&args("press", "ArrowRight")).unwrap();
    assert_eq!(
        f.key(&args("down", "ShiftLeft")).unwrap_err(),
        "KEY_ALREADY_DOWN"
    );
    assert_eq!(
        f.key(&args("up", "ControlLeft")).unwrap_err(),
        "KEY_NOT_DOWN"
    );
    let rect = Rect {
        left: 0,
        top: 0,
        width: 100,
        height: 100,
    };
    let geometry = Geometry {
        display: rect,
        desktop: rect,
    };
    let plan = Plan::pointer(&json!({"target":"local","action":"drag","coordinateSpace":"desktopPhysicalPixels","sourceId":"screen","geometryRevision":"revision","x":1,"y":1,"path":[{"x":90,"y":90}],"durationMs":32}), geometry, &[]).unwrap();
    f.run(plan).unwrap();
    assert_eq!(
        f.holds.borrow().result("old")["heldKeys"],
        json!(["ShiftLeft"])
    );
    assert!(f.holds.borrow().buttons("old").is_empty());
    f.key(&args("up", "ShiftLeft")).unwrap();
    assert!(!f.holds.borrow().any("old"));
}
#[test]
fn all_arguments_are_validated_before_any_key_is_pressed() {
    let f = Fake::new();
    for a in [
        json!({"target":"local","scanCode":30}),
        args("press", "Invalid"),
        json!({"target":"local","action":"chord","keys":["ControlLeft","Invalid"]}),
        json!({"target":"local","action":"chord","keys":["KeyA","KeyA"]}),
        json!({"target":"local","action":"chord","keys":[]}),
        json!({"target":"local","action":"down","key":"KeyA","holdMs":30}),
        json!({"target":"local","action":"up","key":"KeyA","repeat":2}),
        json!({"target":"local","action":"press","key":"KeyA","repeat":101}),
        json!({"target":"local","action":"press","key":"KeyA","holdMs":0}),
        json!({"target":"local","action":"press","key":"KeyA","holdMs":2000,"repeat":6}),
    ] {
        assert!(f.key(&a).is_err(), "{a}");
    }
    assert!(f.events.borrow().is_empty());
    f.key(&args("down", "ControlLeft")).unwrap();
    let before = f.events.borrow().len();
    assert_eq!(f.key(&chord()).unwrap_err(), "KEY_ALREADY_DOWN");
    assert_eq!(f.events.borrow().len(), before);
    let mut max = args("press", "KeyA");
    max["holdMs"] = json!(100);
    max["intervalMs"] = json!(0);
    max["repeat"] = json!(100);
    assert_eq!(Plan::key(&max, &[]).unwrap().steps.len(), 200);
}
#[test]
fn interruption_at_every_chord_boundary_stops_later_events_and_releases_owned_keys() {
    for reason in [
        "CANCELLED",
        "GRANT_EXPIRED",
        "CONTROL_REQUIRED",
        "WINDOW_FOCUS_LOST",
        "WINDOW_UNAVAILABLE",
        "APPROVAL_PENDING",
        "HOLD_EXPIRED",
    ] {
        for boundary in 0..=6 {
            let f = Fake::new();
            f.stop_after.set(Some(boundary));
            f.failure.set(reason);
            assert_eq!(f.key(&chord()).unwrap_err(), reason);
            assert_eq!(f.events.borrow().len(), boundary);
            assert!(!f.holds.borrow().any("old"));
            assert_eq!(f.aborted.get(), usize::from(boundary > 0));
        }
    }
    let f = Fake::new();
    f.fail_at.set(Some(2));
    assert_eq!(f.key(&chord()).unwrap_err(), "INJECTION_FAILED");
    assert!(!f.holds.borrow().any("old"));
    let f = Fake::new();
    f.replace_at.set(Some(1));
    assert_eq!(f.key(&chord()).unwrap_err(), "CONTROL_REQUIRED");
    assert_eq!(f.holds.borrow().keys("new"), vec![key("AltRight").unwrap()]);
}
#[test]
fn unicode_chunks_preserve_characters_allow_processing_time_and_support_typing_gaps() {
    let f = Fake::new();
    f.cost.set(Duration::from_millis(5));
    let text = "中😀".repeat(2048);
    f.text(&json!({"target":"local","text":text})).unwrap();
    let rebuilt: String = f
        .events
        .borrow()
        .iter()
        .map(|(_, e)| match e {
            Event::Text(t) => {
                assert!(t.encode_utf16().count() <= 64);
                t.clone()
            }
            _ => panic!(),
        })
        .collect();
    assert_eq!(rebuilt, text);
    assert!(f.elapsed.get() > Duration::from_millis(500));
    assert!(f.elapsed.get() < Duration::from_secs(2));
    assert!(f
        .events
        .borrow()
        .windows(2)
        .all(|pair| { pair[1].0 > pair[0].0 + f.cost.get() }));
    let f = Fake::new();
    f.text(&json!({"target":"local","text":"中😀A","intervalMs":50}))
        .unwrap();
    assert_eq!(
        f.events
            .borrow()
            .iter()
            .map(|(t, _)| t.as_millis())
            .collect::<Vec<_>>(),
        vec![0, 50, 100]
    );
}
#[test]
fn text_preflight_and_mid_stream_cancel_do_not_emit_later_chunks() {
    let f = Fake::new();
    for a in [
        json!({"target":"local","text":"a\nb"}),
        json!({"target":"local","text":"\t"}),
        json!({"target":"local","text":"\u{0085}"}),
        json!({"target":"local","text":""}),
        json!({"target":"local","text":"x".repeat(4097)}),
        json!({"target":"local","text":"x".repeat(12),"intervalMs":1000}),
    ] {
        assert!(f.text(&a).is_err());
    }
    assert!(f.events.borrow().is_empty());
    f.key(&args("down", "ControlLeft")).unwrap();
    assert_eq!(
        f.text(&json!({"target":"local","text":"hello"}))
            .unwrap_err(),
        "INPUT_HELD"
    );
    f.key(&args("up", "ControlLeft")).unwrap();
    let f = Fake::new();
    f.stop_after.set(Some(2));
    assert_eq!(
        f.text(&json!({"target":"local","text":"😀".repeat(100)}))
            .unwrap_err(),
        "CANCELLED"
    );
    assert_eq!(f.events.borrow().len(), 2);
    assert_eq!(f.aborted.get(), 1);
    let f = Fake::new();
    f.cost.set(Duration::from_millis(600));
    assert_eq!(
        f.text(&json!({"target":"local","text":"x".repeat(100)}))
            .unwrap_err(),
        "INPUT_STALLED"
    );
    assert_eq!(f.events.borrow().len(), 1);
    let f = Fake::new();
    f.cost.set(Duration::from_millis(3));
    assert_eq!(
        f.text(&json!({"target":"local","text":"x".repeat(4096),"intervalMs":2}))
            .unwrap_err(),
        "INPUT_TIMEOUT"
    );
    assert!(f.events.borrow().len() < 4096);
}
#[test]
fn keys_and_buttons_share_one_non_renewing_hold_deadline() {
    let mut holds = Holds::default();
    let now = Instant::now();
    let shift = key("ShiftLeft").unwrap();
    holds.update(
        "owner",
        "old",
        &[Event::Key {
            key: shift,
            down: true,
        }],
        now,
    );
    holds.update(
        "owner",
        "old",
        &[Event::Button {
            position: Position { x: 0., y: 0. },
            button: Button::Left,
            down: true,
        }],
        now + Duration::from_secs(29),
    );
    holds.update(
        "owner",
        "old",
        &[Event::Key {
            key: shift,
            down: false,
        }],
        now + Duration::from_secs(29),
    );
    assert!(holds.keys("old").is_empty());
    assert_eq!(holds.buttons("old"), vec![Button::Left]);
    assert_eq!(
        holds.expired(now + HOLD_LIMIT, false),
        Some(("owner".into(), "old".into()))
    );
    holds.update(
        "owner",
        "new",
        &[Event::Key {
            key: shift,
            down: true,
        }],
        now,
    );
    holds.clear("old");
    assert_eq!(holds.keys("new"), vec![shift]);
    assert_eq!(
        holds.expired(now, true),
        Some(("owner".into(), "new".into()))
    );
}
