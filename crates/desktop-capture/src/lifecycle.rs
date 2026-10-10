//! Coalesced lifecycle invalidations. Pixels and diagnostic counters never queue work.
#[cfg(any(windows, test))]
use std::sync::Mutex;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

struct Pending {
    queued: AtomicBool,
    send: Box<dyn Fn() + Send + Sync>,
}

#[derive(Clone, Default)]
pub(crate) struct Changed(Option<Arc<Pending>>);
impl Changed {
    pub fn new(send: impl Fn() + Send + Sync + 'static) -> Self {
        Self(Some(Arc::new(Pending {
            queued: AtomicBool::new(false),
            send: Box::new(send),
        })))
    }
    pub fn notify(&self) {
        if let Some(pending) = &self.0 {
            if !pending.queued.swap(true, Ordering::AcqRel) {
                (pending.send)();
            }
        }
    }
    /// Clear before reconciling state so a concurrent change queues another wake.
    pub fn acknowledge(&self) {
        if let Some(pending) = &self.0 {
            pending.queued.store(false, Ordering::Release);
        }
    }
}

/// Media starts before its capture owner attaches. Failures remain in media state;
/// attaching subscribes before rechecking that state, and stopping detaches first.
#[cfg(any(windows, test))]
#[derive(Default)]
pub(crate) struct Subscription(Mutex<Changed>);
#[cfg(any(windows, test))]
impl Subscription {
    pub fn set(&self, changed: Changed) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = changed;
    }
    pub fn notify(&self) {
        let changed = self.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        changed.notify();
    }
}
