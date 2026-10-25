//! Capture-scoped hardware encoders, shared by matching video profiles and bandwidth buckets.
use super::{encoding_output::Output, hardware, MediaOptions, VideoSettings};
use crate::media::encoding::{bitrate_bucket, EncodingProfile};
use crate::Result;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
#[cfg(test)]
#[path = "encoding_pool_tests.rs"]
mod tests;

// BWE feedback from different transports does not arrive atomically. Delay only
// upward migrations; the current lower bitrate is safe while peers catch up.
const UPGRADE_GRACE: Duration = Duration::from_millis(500);
// Reusing an existing worker changes the bitstream and waits for a keyframe.
// Keep independent workers through brief budget convergence, adjusting their
// rates in place immediately. Merge only after the destination stays stable.
const MERGE_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Key {
    profile: EncodingProfile,
    bitrate: u32,
}
struct Slot {
    id: String,
    backend: String,
    options: MediaOptions,
    preview: bool,
    recording: bool,
    target: u64,
    upgrade: Option<(u32, Instant)>,
    merge: Option<(u32, u64, Instant)>,
    key: Key,
    encoder: Arc<hardware::Encoder>,
    output: Option<Arc<Output>>,
}
#[derive(Default)]
struct State {
    next: u64,
    closed: bool,
    slots: HashMap<u64, Slot>,
    groups: HashMap<Key, Weak<hardware::Encoder>>,
}
struct Retired {
    token: u64,
    slot: Slot,
    last: bool,
}
impl State {
    fn refresh_groups(&mut self) {
        // Multiple workers may temporarily have the same key while a merge is
        // pending. Keep the current destination while it still owns that key.
        let slots = &self.slots;
        self.groups.retain(|key, group| {
            group.upgrade().is_some_and(|group| {
                group.error().is_none()
                    && slots
                        .values()
                        .any(|s| s.key == *key && Arc::ptr_eq(&s.encoder, &group))
            })
        });
        let mut slots: Vec<_> = slots.values().collect();
        slots.sort_by_key(|slot| slot.encoder.group_id);
        for slot in slots {
            if slot.encoder.error().is_some() {
                continue;
            }
            if slot.recording {
                // A recording tap cannot move to another worker.
                self.groups
                    .insert(slot.key.clone(), Arc::downgrade(&slot.encoder));
            } else {
                self.groups
                    .entry(slot.key.clone())
                    .or_insert_with(|| Arc::downgrade(&slot.encoder));
            }
        }
    }
    fn reconfigure(&mut self, encoder: &Arc<hardware::Encoder>, key: &Key) {
        encoder.set_bitrate(key.bitrate);
        for member in self.slots.values_mut() {
            if Arc::ptr_eq(&member.encoder, encoder) {
                member.key = key.clone();
            }
        }
        self.refresh_groups();
    }
    fn remove(&mut self, token: u64) -> Option<Retired> {
        let slot = self.slots.remove(&token)?;
        let last = !self
            .slots
            .values()
            .any(|other| Arc::ptr_eq(&slot.encoder, &other.encoder));
        if last {
            self.refresh_groups();
        }
        Some(Retired { token, slot, last })
    }
}
impl Retired {
    fn close(self) {
        self.slot.encoder.detach(self.token);
        if let Some(output) = self.slot.output {
            output.source.set_rate_control_wakeup(None);
            output.replace(); // Reject a frame already copied out of the old group's list.
        }
        if self.last {
            self.slot.encoder.close();
        }
    }
}
pub(super) struct FailedPeer {
    pub id: String,
    pub error: String,
    token: u64,
}
impl FailedPeer {
    pub fn matches(&self, consumer: &Consumer) -> bool {
        self.token == consumer.token
    }
}
#[derive(Default)]
pub(super) struct Pool {
    state: Mutex<State>,
    feedback: Option<crate::surface::gpu::Wake>,
}
pub(super) struct Consumer {
    token: u64,
    pool: Arc<Pool>,
    pub output: Option<Arc<Output>>,
}
impl Consumer {
    pub fn encoder(&self) -> Option<Arc<hardware::Encoder>> {
        self.pool
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .slots
            .get(&self.token)
            .map(|s| s.encoder.clone())
    }
    pub fn close(&self) {
        self.pool.release(self.token);
    }
}
impl Drop for Consumer {
    fn drop(&mut self) {
        self.close();
    }
}
impl Pool {
    pub fn new(feedback: crate::surface::gpu::Wake) -> Self {
        Self {
            state: Mutex::default(),
            feedback: Some(feedback),
        }
    }
    pub fn acquire(
        self: &Arc<Self>,
        id: String,
        backend: String,
        options: MediaOptions,
        preview: bool,
        recording: bool,
        wake: crate::surface::gpu::Wake,
    ) -> Result<Arc<Consumer>> {
        let output = if recording {
            None
        } else {
            Some(Output::new(
                &options,
                self.feedback.clone().unwrap_or_else(|| wake.clone()),
            )?)
        };
        let target = if recording || preview {
            options.max_bitrate
        } else {
            300_000
        };
        let key = Key {
            profile: EncodingProfile::new(&backend, &options, preview),
            bitrate: bitrate_bucket(target, options.max_bitrate),
        };
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return Err("Native encoder pool is closed".into());
        }
        let encoder = self.get_or_create(&mut state, &key, &backend, &options, wake)?;
        state.next += 1;
        let token = state.next;
        if let Some(output) = &output {
            encoder.attach(token, output.clone(), output.replace());
        }
        state.slots.insert(
            token,
            Slot {
                id,
                backend,
                options,
                preview,
                recording,
                target,
                upgrade: None,
                merge: None,
                key,
                encoder,
                output: output.clone(),
            },
        );
        Ok(Arc::new(Consumer {
            token,
            pool: self.clone(),
            output,
        }))
    }
    fn get_or_create(
        &self,
        state: &mut State,
        key: &Key,
        backend: &str,
        options: &MediaOptions,
        wake: crate::surface::gpu::Wake,
    ) -> Result<Arc<hardware::Encoder>> {
        if let Some(encoder) = state
            .groups
            .get(key)
            .and_then(Weak::upgrade)
            .filter(|e| e.error().is_none())
        {
            return Ok(encoder);
        }
        let encoder = Arc::new(hardware::Encoder::shared(
            backend.into(),
            options.clone(),
            wake,
            self.feedback.clone().unwrap_or_else(|| Arc::new(|| {})),
            key.bitrate,
        )?);
        state.groups.retain(|_, encoder| encoder.strong_count() > 0);
        state.groups.insert(key.clone(), Arc::downgrade(&encoder));
        Ok(encoder)
    }
    fn release(&self, token: u64) {
        let retired = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token);
        if let Some(retired) = retired {
            retired.close();
        }
    }
    pub fn release_peer(&self, id: &str) {
        let tokens: Vec<_> = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .slots
            .iter()
            .filter(|(_, slot)| !slot.recording && slot.id == id)
            .map(|(token, _)| *token)
            .collect();
        for token in tokens {
            self.release(token);
        }
    }
    pub fn encoder(&self, id: &str) -> Option<Arc<hardware::Encoder>> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .slots
            .values()
            .find(|s| s.id == id)
            .map(|s| s.encoder.clone())
    }
    pub fn active(&self) -> Vec<(String, Arc<hardware::Encoder>)> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut encoders: Vec<(String, Arc<hardware::Encoder>)> = Vec::new();
        for slot in state.slots.values() {
            if !encoders.iter().any(|(_, e)| Arc::ptr_eq(e, &slot.encoder)) {
                encoders.push((slot.id.clone(), slot.encoder.clone()));
            }
        }
        encoders
    }
    pub fn take_failed_peers(&self) -> Vec<FailedPeer> {
        let (failed, retired) = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let failed: Vec<_> = state
                .slots
                .iter()
                .filter(|(_, slot)| !slot.recording)
                .filter_map(|(token, slot)| {
                    slot.encoder.error().map(|error| FailedPeer {
                        id: slot.id.clone(),
                        error,
                        token: *token,
                    })
                })
                .collect();
            // CPU and GPU capture can observe the same failure concurrently.
            // Claim the exact consumers before releasing the pool lock.
            let retired: Vec<_> = failed
                .iter()
                .filter_map(|f| state.remove(f.token))
                .collect();
            (failed, retired)
        };
        // Native callbacks and worker joins must run outside the pool lock.
        for retired in retired {
            retired.close();
        }
        failed
    }
    pub fn statistics(&self) -> Vec<crate::media::latency::EncoderPipelineStats> {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut groups = HashMap::<u64, (Arc<hardware::Encoder>, Vec<String>)>::new();
        for slot in state.slots.values() {
            groups
                .entry(slot.encoder.group_id)
                .or_insert_with(|| (slot.encoder.clone(), Vec::new()))
                .1
                .push(slot.id.clone());
        }
        drop(state);
        let mut result: Vec<_> = groups
            .into_iter()
            .map(|(id, (encoder, mut consumers))| {
                consumers.sort();
                let mut stats = encoder.statistics().snapshot(consumers[0].clone());
                stats.group_id = id;
                stats.consumers = consumers;
                stats
            })
            .collect();
        result.sort_by_key(|stats| stats.group_id);
        result
    }
    pub fn reconcile(&self, wake: crate::surface::gpu::Wake) -> Result<()> {
        self.reconcile_at(wake, Instant::now())
    }
    fn reconcile_at(&self, wake: crate::surface::gpu::Wake, now: Instant) -> Result<()> {
        let mut retired = Vec::new();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut tokens: Vec<_> = state.slots.keys().copied().collect();
        tokens.sort_by_key(|token| !state.slots[token].recording);
        // Read every pending budget before deciding whether a shared group
        // needs to split. Processing one viewer at a time can otherwise reopen
        // an encoder even when all viewers are moving to the same bucket.
        for slot in state.slots.values_mut() {
            if let Some(output) = &slot.output {
                if output.take_keyframe_request() {
                    slot.encoder.request_recording_keyframe();
                }
                if let Some(rate) = output.source.take_rate_control_request() {
                    if !slot.preview {
                        slot.target = rate.target_bitrate_bps;
                    }
                }
            }
        }
        for token in tokens {
            let slot = state.slots.get_mut(&token).unwrap();
            let key = Key {
                profile: slot.key.profile.clone(),
                bitrate: bitrate_bucket(slot.target, slot.options.max_bitrate),
            };
            let unchanged = slot.key == key;
            let recording = slot.recording;
            let old = slot.encoder.clone();
            let options = slot.options.clone();
            let backend = slot.backend.clone();
            let output = slot.output.clone();
            let old_key = slot.key.clone();
            let existing = state
                .groups
                .get(&key)
                .and_then(Weak::upgrade)
                .filter(|e| e.error().is_none());
            if recording {
                state.slots.get_mut(&token).unwrap().upgrade = None;
                state.slots.get_mut(&token).unwrap().merge = None;
                // A recording's tap is bound to this worker. Reconfigure it in
                // place; viewers sharing it can move after their budgets change.
                if !unchanged {
                    state.reconfigure(&old, &key);
                }
                state.groups.insert(key, Arc::downgrade(&old));
                continue;
            }
            if unchanged
                && existing
                    .as_ref()
                    .is_none_or(|encoder| Arc::ptr_eq(encoder, &old))
            {
                state.slots.get_mut(&token).unwrap().upgrade = None;
                state.slots.get_mut(&token).unwrap().merge = None;
                continue;
            }
            let moves_together = state
                .slots
                .values()
                .filter(|s| Arc::ptr_eq(&s.encoder, &old))
                .all(|s| {
                    s.key.profile == key.profile
                        && bitrate_bucket(s.target, s.options.max_bitrate) == key.bitrate
                });
            let merge_destination = existing.as_ref().filter(|encoder| {
                !Arc::ptr_eq(encoder, &old)
                    && !state
                        .slots
                        .values()
                        .any(|s| s.recording && Arc::ptr_eq(&s.encoder, encoder))
            });
            if let Some(destination) = merge_destination
                .filter(|_| moves_together && old_key.bitrate > 0 && key.bitrate > 0)
            {
                let slot = state.slots.get_mut(&token).unwrap();
                slot.upgrade = None;
                let since = match slot.merge {
                    Some((rate, group, since))
                        if rate == key.bitrate && group == destination.group_id =>
                    {
                        since
                    }
                    _ => {
                        slot.merge = Some((key.bitrate, destination.group_id, now));
                        now
                    }
                };
                if now.saturating_duration_since(since) < MERGE_GRACE {
                    if !unchanged {
                        state.reconfigure(&old, &key);
                    }
                    continue;
                }
            }
            let slot = state.slots.get_mut(&token).unwrap();
            slot.merge = None;
            if !moves_together && old_key.bitrate > 0 && key.bitrate > old_key.bitrate {
                let since = match slot.upgrade {
                    Some((target, since)) if target == key.bitrate => since,
                    _ => {
                        slot.upgrade = Some((key.bitrate, now));
                        now
                    }
                };
                if now.saturating_duration_since(since) < UPGRADE_GRACE {
                    continue;
                }
            }
            slot.upgrade = None;
            let encoder = if let Some(existing) = existing {
                existing
            } else if moves_together {
                // Keep the bitstream and all output generations intact when
                // the entire group changes rate, including a sole viewer.
                state.reconfigure(&old, &key);
                old.clone()
            } else {
                self.get_or_create(&mut state, &key, &backend, &options, wake.clone())?
            };
            let slot = state.slots.get_mut(&token).unwrap();
            if !Arc::ptr_eq(&encoder, &old) {
                old.detach(token);
                if let Some(output) = output {
                    encoder.attach(token, output.clone(), output.replace());
                }
                retired.push(std::mem::replace(&mut slot.encoder, encoder));
            }
            slot.key = key;
        }
        retired.retain(|encoder| {
            !state
                .slots
                .values()
                .any(|slot| Arc::ptr_eq(&slot.encoder, encoder))
        });
        if !retired.is_empty() {
            state.refresh_groups();
        }
        drop(state);
        for encoder in retired {
            encoder.close();
        }
        Ok(())
    }
    pub fn update(&self, settings: &VideoSettings) -> Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        for slot in state.slots.values_mut() {
            slot.options = settings.apply(&slot.options)?;
            if slot.recording || slot.preview {
                slot.target = slot.options.max_bitrate;
            }
            slot.key.profile = EncodingProfile::new(&slot.backend, &slot.options, slot.preview);
            slot.upgrade = None;
            slot.merge = None;
            // Pending options are coalesced by the shared worker.
            slot.encoder.update_options(slot.options.clone());
        }
        state.refresh_groups();
        Ok(())
    }
    pub fn close(&self) {
        let slots = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.closed = true;
            state.groups.clear();
            std::mem::take(&mut state.slots)
        };
        for (token, slot) in &slots {
            slot.encoder.detach(*token);
            if let Some(output) = &slot.output {
                output.source.set_rate_control_wakeup(None);
                output.replace();
            }
        }
        for slot in slots.values() {
            slot.encoder.close();
        }
    }
}
