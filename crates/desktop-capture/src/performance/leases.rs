//! Serialize the first acquire and final restore, including concurrent reacquisition.
use std::{
    collections::HashMap,
    hash::Hash,
    sync::{Arc, Mutex},
};

pub(super) struct Registry<K, R> {
    entries: Mutex<HashMap<K, (usize, R)>>,
}
impl<K, R> Default for Registry<K, R> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}
impl<K: Eq + Hash + Clone, R> Registry<K, R> {
    pub fn acquire(self: &Arc<Self>, key: K, create: impl FnOnce() -> R) -> Lease<K, R> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let entry = entries.entry(key.clone()).or_insert_with(|| (0, create()));
        entry.0 += 1;
        Lease {
            registry: self.clone(),
            key,
        }
    }
    pub fn inspect<T>(&self, key: &K, read: impl FnOnce(Option<&R>) -> T) -> T {
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        read(entries.get(key).map(|e| &e.1))
    }
}
pub(super) struct Lease<K: Eq + Hash + Clone, R> {
    registry: Arc<Registry<K, R>>,
    key: K,
}
impl<K: Eq + Hash + Clone, R> Lease<K, R> {
    pub fn inspect<T>(&self, read: impl FnOnce(&R) -> T) -> T {
        self.registry
            .inspect(&self.key, |entry| read(entry.expect("live resource lease")))
    }
}
impl<K: Eq + Hash + Clone, R> Drop for Lease<K, R> {
    fn drop(&mut self) {
        let mut entries = self
            .registry
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let entry = entries.get_mut(&self.key).expect("live resource lease");
        entry.0 -= 1;
        if entry.0 == 0 {
            // Drop while still locked: a new acquire must not read the old override
            // as its baseline while the last owner is concurrently restoring it.
            drop(entries.remove(&self.key));
        }
    }
}

#[cfg(test)]
mod tests;
