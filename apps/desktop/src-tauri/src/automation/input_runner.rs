//! Execute one gesture without holding application locks between samples.
use std::time::{Duration, Instant};
use weblink_desktop_input::input::Event;
pub struct Step {
    pub at: Duration,
    pub events: Vec<Event>,
}
#[derive(Default)]
pub struct Plan {
    pub steps: Vec<Step>,
    /// Key holds/text gaps start after the preceding submission completes.
    pub paced: bool,
}
impl Plan {
    pub fn push(&mut self, millis: f64, events: Vec<Event>) {
        self.steps.push(Step {
            at: Duration::from_secs_f64(millis / 1000.),
            events,
        });
    }
}
pub trait Sink {
    fn check(&self) -> Result<(), String>;
    fn send(&self, events: Vec<Event>) -> Result<(), String>;
    /// Release only the exact native control lease captured when this call was admitted.
    fn abort(&self);
}
pub trait Clock {
    fn elapsed(&self) -> Duration;
    fn sleep(&self, duration: Duration);
}
struct WallClock(Instant);
impl Clock for WallClock {
    fn elapsed(&self) -> Duration {
        self.0.elapsed()
    }
    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}
struct Cleanup<'a, S: Sink> {
    sink: &'a S,
    armed: bool,
}
impl<S: Sink> Drop for Cleanup<'_, S> {
    fn drop(&mut self) {
        if self.armed {
            self.sink.abort();
        }
    }
}
pub fn run(plan: Plan, sink: &impl Sink) -> Result<usize, String> {
    run_with_clock(plan, sink, &WallClock(Instant::now()))
}
pub fn run_with_clock(plan: Plan, sink: &impl Sink, clock: &impl Clock) -> Result<usize, String> {
    let mut cleanup = Cleanup { sink, armed: false };
    let mut applied = 0;
    let mut completed = Duration::ZERO;
    for step in plan.steps {
        let due = if plan.paced {
            completed + step.at
        } else {
            step.at
        };
        loop {
            sink.check()?;
            let elapsed = clock.elapsed();
            if elapsed > Duration::from_secs(15) {
                return Err("INPUT_TIMEOUT".into());
            }
            if elapsed >= due {
                break;
            }
            clock.sleep((due - elapsed).min(Duration::from_millis(16)));
        }
        // Do not replay a burst of old input after a suspended/stalled host resumes.
        if clock.elapsed().saturating_sub(due) > Duration::from_millis(500) {
            return Err("INPUT_STALLED".into());
        }
        cleanup.armed = true; // includes partial native injection failures
        let started = clock.elapsed();
        sink.send(step.events)?;
        applied += 1;
        completed = clock.elapsed();
        if completed > Duration::from_secs(15) {
            return Err("INPUT_TIMEOUT".into());
        }
        if plan.paced && completed.saturating_sub(started) > Duration::from_millis(500) {
            return Err("INPUT_STALLED".into());
        }
    }
    sink.check()?;
    cleanup.armed = false;
    Ok(applied)
}
