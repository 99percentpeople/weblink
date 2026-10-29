//! Capture-scoped hardware encoders, shared by matching video profiles and bandwidth buckets.
use super::{encoding_output::Output, hardware, MediaOptions, VideoSettings};
use crate::media::encoding::{bitrate_bucket, EncodingProfile};
use crate::Result;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};
#[cfg(test)]
#[path = "encoding_pool_tests.rs"]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Key {
    profile: EncodingProfile,
    bitrate: u32,
}
struct Slot {
    id: String,
    backend: String,
    options: MediaOptions,
    limits: Option<VideoSettings>,
    warming: bool,
    preview: bool,
    recording: bool,
    target: u64,
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
    fn remove(&mut self, token: u64) -> Option<Retired> {
        let slot = self.slots.remove(&token)?;
        let last = !self
            .slots
            .values()
            .any(|other| Arc::ptr_eq(&slot.encoder, &other.encoder));
        if last {
            self.groups.retain(|_, group| {
                group
                    .upgrade()
                    .is_some_and(|group| !Arc::ptr_eq(&group, &slot.encoder))
            });
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
                limits: None,
                warming: false,
                preview,
                recording,
                target,
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
                .filter(|(_, slot)| !slot.recording && !slot.warming)
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
        let mut retired = Vec::new();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut tokens: Vec<_> = state
            .slots
            .iter()
            .filter(|(_, slot)| !slot.warming)
            .map(|(token, _)| *token)
            .collect();
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
                profile: EncodingProfile::new(&slot.backend, &slot.options, slot.preview),
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
                // A recording's tap is bound to this worker. Reconfigure it in
                // place; viewers sharing it can move after their budgets change.
                if !unchanged {
                    old.update_options(options.clone());
                    old.set_bitrate(key.bitrate);
                    state.groups.remove(&old_key);
                    for member in state.slots.values_mut() {
                        if Arc::ptr_eq(&member.encoder, &old) {
                            member.key = key.clone();
                        }
                    }
                }
                state.groups.insert(key, Arc::downgrade(&old));
                continue;
            }
            if unchanged
                && existing
                    .as_ref()
                    .is_none_or(|encoder| Arc::ptr_eq(encoder, &old))
            {
                continue;
            }
            let moves_together = state
                .slots
                .values()
                .filter(|s| Arc::ptr_eq(&s.encoder, &old))
                .all(|s| {
                    EncodingProfile::new(&s.backend, &s.options, s.preview) == key.profile
                        && bitrate_bucket(s.target, s.options.max_bitrate) == key.bitrate
                });
            let encoder = if let Some(existing) = existing {
                existing
            } else if moves_together {
                // Keep the bitstream and all output generations intact when
                // the entire group changes rate, including a sole viewer.
                old.set_bitrate(key.bitrate);
                if old_key.profile != key.profile {
                    old.update_options(options.clone());
                }
                state.groups.remove(&old_key);
                state.groups.insert(key.clone(), Arc::downgrade(&old));
                for member in state.slots.values_mut() {
                    if Arc::ptr_eq(&member.encoder, &old) {
                        member.key = key.clone();
                    }
                }
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
        state.groups.retain(|_, group| {
            group
                .upgrade()
                .is_some_and(|group| !retired.iter().any(|old| Arc::ptr_eq(old, &group)))
        });
        drop(state);
        for encoder in retired {
            encoder.close();
        }
        Ok(())
    }
    pub fn update(&self, settings: &VideoSettings) -> Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        for slot in state.slots.values_mut() {
            let ceiling = settings.apply(&slot.options)?;
            slot.options = match &slot.limits {
                Some(limits) => limits.bounded(&ceiling)?,
                None => ceiling,
            };
            if slot.recording || slot.preview {
                slot.target = slot.options.max_bitrate;
            }
        }
        drop(state);
        self.reconcile(self.feedback.clone().unwrap_or_else(|| Arc::new(|| {})))
    }
    pub fn update_peer(
        &self,
        id: &str,
        settings: &VideoSettings,
        ceiling: &MediaOptions,
    ) -> Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let token = *state
            .slots
            .iter()
            .find(|(_, s)| s.id == id && !s.preview && !s.recording && !s.warming)
            .ok_or("Video encoder no longer active")?
            .0;
        let slot = &state.slots[&token];
        // Preserve this consumer's negotiated codec and backend.
        let bounds = VideoSettings {
            max_width: ceiling.max_width,
            max_height: ceiling.max_height,
            frame_rate: ceiling.frame_rate,
            max_bitrate: ceiling.max_bitrate,
            degradation_preference: ceiling.degradation_preference.clone(),
        };
        let next = settings.bounded(&bounds.apply(&slot.options)?)?;
        let key = Key {
            profile: EncodingProfile::new(&slot.backend, &next, slot.preview),
            bitrate: bitrate_bucket(slot.target, next.max_bitrate),
        };
        if key == slot.key {
            let slot = state.slots.get_mut(&token).unwrap();
            slot.limits = Some(settings.clone());
            slot.options = next;
            return Ok(());
        }
        let backend = slot.backend.clone();
        let old = slot.encoder.clone();
        let target = slot.target;
        let encoder = self.get_or_create(
            &mut state,
            &key,
            &backend,
            &next,
            self.feedback.clone().unwrap_or_else(|| Arc::new(|| {})),
        )?;
        // Warm a candidate without detaching the viewer or exposing its failures
        // to transport recovery. The old encoder/output remains valid until commit.
        state.next += 1;
        let warm = state.next;
        state.slots.insert(
            warm,
            Slot {
                id: format!("warming:{id}"),
                backend,
                options: next.clone(),
                limits: None,
                warming: true,
                preview: false,
                recording: false,
                target,
                key: key.clone(),
                encoder: encoder.clone(),
                output: None,
            },
        );
        drop(state);
        if let Some(wake) = &self.feedback {
            wake();
        }
        encoder.request_recording_keyframe();
        let started = std::time::Instant::now();
        let result = loop {
            if let Some(error) = encoder.error() {
                break Err(error);
            }
            if encoder.statistics().frames > 0 {
                break Ok(());
            }
            if started.elapsed() >= std::time::Duration::from_secs(3) {
                break Err("Video quality encoder did not become ready".into());
            }
            if !self
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .slots
                .contains_key(&token)
            {
                break Err("Video receiver no longer active".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.slots.remove(&warm);
        let result = result.and_then(|()| {
            let slot = state
                .slots
                .get_mut(&token)
                .ok_or("Video receiver no longer active")?;
            if !Arc::ptr_eq(&slot.encoder, &old) {
                return Err("Video encoder changed".into());
            }
            old.detach(token);
            if let Some(output) = &slot.output {
                encoder.attach(token, output.clone(), output.replace());
            }
            slot.encoder = encoder.clone();
            slot.options = next;
            slot.limits = Some(settings.clone());
            slot.key = key;
            Ok(())
        });
        let retired: Vec<_> = [old, encoder]
            .into_iter()
            .filter(|encoder| {
                !state
                    .slots
                    .values()
                    .any(|s| Arc::ptr_eq(&s.encoder, encoder))
            })
            .collect();
        state.groups.retain(|_, group| {
            group
                .upgrade()
                .is_some_and(|group| !retired.iter().any(|old| Arc::ptr_eq(old, &group)))
        });
        drop(state);
        for encoder in retired {
            encoder.close();
        }
        result
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
