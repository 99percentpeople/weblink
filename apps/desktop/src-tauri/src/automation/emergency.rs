//! The shared host shortcut fences calls immediately; cleanup runs off the hook thread.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;

#[derive(Default)]
pub(super) struct Emergency {
    pending: AtomicBool,
    pub wake: Notify,
}
impl Emergency {
    pub fn pending(&self) -> bool {
        self.pending.load(Ordering::Acquire)
    }
    fn signal(&self) {
        self.pending.store(true, Ordering::Release);
        self.wake.notify_one();
    }
}
impl Service {
    pub fn emergency_observer(&self) -> Arc<dyn Fn() + Send + Sync> {
        let emergency = self.state.lock().unwrap().emergency.clone();
        Arc::new(move || emergency.signal())
    }
    pub(super) fn consume_emergency(&self, s: &mut State) {
        // Consume under the authority lock. A subsequent signal remains pending.
        if s.emergency.pending.swap(false, Ordering::AcqRel) && s.enabled {
            self.stop_locked(s);
        }
    }
    pub(super) fn stop_locked(&self, s: &mut State) {
        s.policies_suspended = true;
        s.grants.clear();
        Self::cancel_all(s);
        *self.input_holds.lock().unwrap() = input_holds::Holds::default();
        self.jobs.stop();
    }
}
