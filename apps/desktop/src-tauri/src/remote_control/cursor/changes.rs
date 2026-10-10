//! Coalesce native invalidations without sampling an unchanged cursor.
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc, Mutex,
};
use std::thread::Thread;

pub(super) const APPEARANCE: u8 = 1;
pub(super) const ACTIVITY: u8 = 2;

#[derive(Default)]
struct State {
    active: AtomicBool,
    pending: AtomicU8,
    owner: Mutex<Option<Thread>>,
}
#[derive(Clone, Default)]
pub(super) struct Changes(Arc<State>);
impl Changes {
    pub fn activate(&self, active: bool) {
        self.0.active.store(active, Ordering::Release);
        if !active {
            self.0.pending.store(0, Ordering::Release);
        }
    }
    pub fn set_waker(&self, owner: Thread) {
        *self.0.owner.lock().unwrap_or_else(|e| e.into_inner()) = Some(owner.clone());
        if self.pending() {
            owner.unpark();
        }
    }
    pub fn notify(&self, flags: u8) {
        if self.0.active.load(Ordering::Acquire)
            && self.0.pending.fetch_or(flags, Ordering::AcqRel) == 0
        {
            if let Some(owner) = &*self.0.owner.lock().unwrap_or_else(|e| e.into_inner()) {
                owner.unpark();
            }
        }
    }
    pub fn pending(&self) -> bool {
        self.0.pending.load(Ordering::Acquire) != 0
    }
    pub fn take(&self) -> u8 {
        self.0.pending.swap(0, Ordering::AcqRel)
    }
}
