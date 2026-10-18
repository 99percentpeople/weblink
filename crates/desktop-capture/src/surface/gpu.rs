//! Bounded GPU resources. A lease is reusable only after its last consumer releases it.
use std::{
    ops::Deref,
    sync::{Arc, Mutex, Weak},
};
use windows::{
    core::{Interface, Result},
    Win32::Graphics::Direct3D11::*,
};

pub(crate) type Wake = Arc<dyn Fn() + Send + Sync>;

struct Slots<T> {
    free: Vec<T>,
    allocated: usize,
}
pub(crate) struct Pool<T> {
    slots: Mutex<Slots<T>>,
    limit: usize,
    wake: Wake,
}
pub(crate) struct Lease<T> {
    value: Option<T>,
    pool: Weak<Pool<T>>,
}
impl<T> Pool<T> {
    pub fn new(limit: usize, wake: Wake) -> Arc<Self> {
        Arc::new(Self {
            slots: Mutex::new(Slots {
                free: Vec::new(),
                allocated: 0,
            }),
            limit,
            wake,
        })
    }
    pub fn take(self: &Arc<Self>, create: impl FnOnce() -> Result<T>) -> Result<Option<Lease<T>>> {
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        let value = if let Some(value) = slots.free.pop() {
            value
        } else {
            if slots.allocated == self.limit {
                return Ok(None);
            }
            let value = create()?;
            slots.allocated += 1;
            value
        };
        Ok(Some(Lease {
            value: Some(value),
            pool: Arc::downgrade(self),
        }))
    }
}
impl<T> Deref for Lease<T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.value.as_ref().unwrap()
    }
}
impl<T> Drop for Lease<T> {
    fn drop(&mut self) {
        if let Some(pool) = self.pool.upgrade() {
            pool.slots
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .free
                .push(self.value.take().unwrap());
            (pool.wake)();
        }
    }
}

/// D3D's per-call protection is insufficient for a sequence of shader bindings.
/// Serialize the entire command batch with other users of the immediate context.
pub(crate) struct ContextLock(ID3D11Multithread);
impl ContextLock {
    pub fn enter(context: &ID3D11DeviceContext) -> Result<Self> {
        let lock: ID3D11Multithread = context.cast()?;
        unsafe {
            lock.Enter();
        }
        Ok(Self(lock))
    }
}
impl Drop for ContextLock {
    fn drop(&mut self) {
        unsafe {
            self.0.Leave();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pool_never_reuses_a_live_lease_and_does_not_keep_the_owner_alive() {
        let pool = Pool::new(2, Arc::new(|| {}));
        let first = Arc::new(pool.take(|| Ok(1)).unwrap().unwrap());
        let second = pool.take(|| Ok(2)).unwrap().unwrap();
        let held = first.clone();
        drop(first);
        assert!(pool.take(|| Ok(3)).unwrap().is_none());
        drop(held);
        assert_eq!(*pool.take(|| Ok(99)).unwrap().unwrap(), 1);
        let weak = Arc::downgrade(&pool);
        drop(pool);
        assert!(weak.upgrade().is_none());
        drop(second);
    }
}
