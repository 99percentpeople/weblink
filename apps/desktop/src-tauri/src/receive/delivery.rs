//! Two immutable-to-the-renderer leases. A slot is reusable only after its exact
//! lease is returned, including frames discarded before VideoFrame construction.
use super::{shared_frame::SharedFrame, timing::Timing};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::ipc::Channel;
use tokio::sync::Notify;
use weblink_desktop_capture::receive::{Frame, Receiver};

pub(super) const SLOT_COUNT: usize = 2;
#[derive(Clone, Copy, Default)]
enum Slot {
    #[default]
    Free,
    Copying(u64),
    Ready {
        lease: u64,
        sent: Instant,
    },
}
#[derive(Default)]
struct Slots {
    slots: [Slot; SLOT_COUNT],
    next: Arc<AtomicU64>,
    after: u64,
    visible: bool,
    closed: bool,
}
impl Slots {
    fn reserve(&mut self) -> Option<(usize, u64, u64)> {
        if self.closed || !self.visible {
            return None;
        }
        let slot = self.slots.iter().position(|s| matches!(s, Slot::Free))?;
        let lease = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.slots[slot] = Slot::Copying(lease);
        Some((slot, lease, self.after))
    }
    fn finish(&mut self, slot: usize, lease: u64, sequence: Option<u64>) -> bool {
        if !matches!(self.slots.get(slot), Some(Slot::Copying(current)) if *current == lease) {
            return false;
        }
        if self.closed || !self.visible || sequence.is_none() {
            self.slots[slot] = Slot::Free;
            return false;
        }
        self.after = sequence.unwrap();
        self.slots[slot] = Slot::Ready {
            lease,
            sent: Instant::now(),
        };
        true
    }
    fn release(&mut self, slot: usize, lease: u64) -> Option<f64> {
        if self.closed {
            return None;
        }
        let Slot::Ready {
            lease: current,
            sent,
        } = *self.slots.get(slot)?
        else {
            return None;
        };
        if current != lease {
            return None;
        }
        self.slots[slot] = Slot::Free;
        Some(sent.elapsed().as_secs_f64() * 1000.0)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Release {
    pub slot: usize,
    pub lease: u64,
}
#[derive(Default)]
struct Metrics {
    copies: u64,
    pushed: u64,
    skipped: u64,
    last_sequence: u64,
    released: u64,
    invalid_releases: u64,
    release_messages: u64,
    worker_queue: Timing,
    decoded_queue: Timing,
    pixel_copy: Timing,
    lease_hold: Timing,
}
#[derive(Default)]
struct State {
    slots: Slots,
    buffers: Option<[Arc<SharedFrame>; SLOT_COUNT]>,
    metrics: Metrics,
}
pub(super) struct Delivery {
    state: Mutex<State>,
    pub wake: Arc<Notify>,
    receiver: Arc<Receiver>,
    events: Channel<Value>,
}
impl Delivery {
    pub fn new(
        receiver: Arc<Receiver>,
        events: Channel<Value>,
        wake: Arc<Notify>,
        next: Arc<AtomicU64>,
    ) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                slots: Slots {
                    next,
                    ..Default::default()
                },
                ..Default::default()
            }),
            wake,
            receiver,
            events,
        })
    }
    pub fn attach(&self, buffers: [Arc<SharedFrame>; SLOT_COUNT]) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if state.slots.closed || state.buffers.is_some() {
            return Err("Native receiver closed during startup".into());
        }
        state.buffers = Some(buffers);
        Ok(())
    }
    pub fn start(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        let wake = self.wake.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                wake.notified().await;
                let Some(delivery) = weak.upgrade() else {
                    break;
                };
                if delivery.state.lock().unwrap().slots.closed {
                    break;
                }
                if let Err(error) = delivery.drain().await {
                    let _ = delivery.events.send(json!({"type":"error","error":error}));
                    delivery.close();
                    break;
                }
            }
        });
    }
    async fn drain(&self) -> Result<(), String> {
        loop {
            let selected = {
                let mut state = self.state.lock().unwrap();
                if state.buffers.is_none() {
                    return Ok(());
                }
                state.slots.reserve().map(|(slot, lease, after)| {
                    (
                        slot,
                        lease,
                        after,
                        state.buffers.as_ref().unwrap()[slot].clone(),
                    )
                })
            };
            let Some((slot, lease, after, buffer)) = selected else {
                return Ok(());
            };
            let queued = Instant::now();
            let receiver = self.receiver.clone();
            let (frame, queue_ms) = tauri::async_runtime::spawn_blocking(move || {
                let queue_ms = queued.elapsed().as_secs_f64() * 1000.0;
                (
                    buffer.write(|pixels| receiver.copy_frame(after, pixels)),
                    queue_ms,
                )
            })
            .await
            .map_err(|e| e.to_string())?;
            let frame = frame?;
            let publish = {
                let mut state = self.state.lock().unwrap();
                if let Some(frame) = &frame {
                    Self::record_copy(&mut state.metrics, frame, queue_ms);
                }
                let publish = state
                    .slots
                    .finish(slot, lease, frame.as_ref().map(|f| f.sequence));
                if publish {
                    state.metrics.pushed += 1;
                }
                publish
            };
            if publish {
                // No request/response or UI-thread pixel copy on the frame path.
                self.events
                    .send(json!({"type":"frame","slot":slot,"lease":lease,"frame":frame}))
                    .map_err(|e| e.to_string())?;
            } else {
                return Ok(());
            }
        }
    }
    fn record_copy(metrics: &mut Metrics, frame: &Frame, queue_ms: f64) {
        metrics.copies += 1;
        if frame.sequence > metrics.last_sequence {
            metrics.skipped += frame.sequence - metrics.last_sequence - 1;
            metrics.last_sequence = frame.sequence;
        }
        metrics.worker_queue.record(queue_ms);
        metrics.decoded_queue.record(frame.decoded_queue_ms);
        metrics.pixel_copy.record(frame.pixel_copy_ms);
    }
    pub fn release(&self, releases: &[Release]) {
        if releases.is_empty() || releases.len() > SLOT_COUNT {
            return;
        }
        let mut state = self.state.lock().unwrap();
        if state.slots.closed {
            return;
        }
        state.metrics.release_messages += 1;
        for release in releases {
            if let Some(ms) = state.slots.release(release.slot, release.lease) {
                state.metrics.released += 1;
                state.metrics.lease_hold.record(ms);
            } else {
                state.metrics.invalid_releases += 1;
            }
        }
        drop(state);
        self.wake.notify_one();
    }
    pub fn visible(&self, visible: bool) {
        let mut state = self.state.lock().unwrap();
        if state.slots.closed {
            return;
        }
        if visible && !state.slots.visible {
            state.slots.after = 0;
        }
        state.slots.visible = visible;
        drop(state);
        self.receiver.visible(visible);
        self.wake.notify_one();
    }
    pub fn stats(&self) -> Value {
        let decoded = self.receiver.decoded_frames();
        let state = self.state.lock().unwrap();
        let m = &state.metrics;
        json!({"mode":"push","slots":SLOT_COUNT,"decodedFrames":decoded,
            "sharedCopies":m.copies,"pushedFrames":m.pushed,"skippedBeforeCopy":m.skipped,
            "releasedFrames":m.released,"releaseMessages":m.release_messages,"invalidReleases":m.invalid_releases,
            "workerQueueMs":m.worker_queue.snapshot(),"decodedQueueMs":m.decoded_queue.snapshot(),
            "pixelCopyMs":m.pixel_copy.snapshot(),"leaseHoldMs":m.lease_hold.snapshot()})
    }
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.slots.closed = true;
        state.buffers = None;
        drop(state);
        self.receiver.close();
        self.wake.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_reopened_receiver_never_reuses_a_previous_owners_lease() {
        let next = Arc::new(AtomicU64::new(0));
        let mut old = Slots {
            visible: true,
            next: next.clone(),
            ..Default::default()
        };
        let (slot, lease, _) = old.reserve().unwrap();
        assert!(old.finish(slot, lease, Some(1)));
        old.closed = true;
        let mut reopened = Slots {
            visible: true,
            next,
            ..Default::default()
        };
        let (same, fresh, _) = reopened.reserve().unwrap();
        assert_eq!(same, slot);
        assert_ne!(fresh, lease);
        assert!(reopened.finish(same, fresh, Some(1)));
        assert!(reopened.release(slot, lease).is_none());
        assert!(reopened.release(same, fresh).is_some());
    }
    #[test]
    fn full_pool_stops_writes_and_exact_lease_owns_each_slot() {
        let mut slots = Slots {
            visible: true,
            ..Default::default()
        };
        let (a, first, _) = slots.reserve().unwrap();
        assert!(
            slots.release(a, first).is_none(),
            "Never acknowledge an incomplete write"
        );
        assert!(slots.finish(a, first, Some(10)));
        let (b, second, after) = slots.reserve().unwrap();
        assert_eq!(after, 10);
        assert_ne!(a, b);
        assert!(slots.finish(b, second, Some(20)));
        assert!(slots.reserve().is_none());
        assert!(slots.release(a, second).is_none());
        assert!(slots.release(SLOT_COUNT, first).is_none());
        assert!(slots.release(a, first).is_some());
        let (same, third, _) = slots.reserve().unwrap();
        assert_eq!(same, a);
        assert!(slots.finish(same, third, Some(21)));
        assert!(
            slots.release(a, first).is_none(),
            "Delayed duplicate cannot free a reused slot"
        );
        assert!(slots.reserve().is_none());
        assert!(
            slots.release(b, second).is_some(),
            "Out-of-order release is independent"
        );
    }
    #[test]
    fn hidden_and_closed_owners_do_not_publish_or_reuse_outstanding_pixels() {
        let mut slots = Slots {
            visible: true,
            ..Default::default()
        };
        let (a, first, _) = slots.reserve().unwrap();
        assert!(slots.finish(a, first, Some(1)));
        let (b, second, _) = slots.reserve().unwrap();
        slots.visible = false;
        assert!(!slots.finish(b, second, Some(2)));
        assert!(slots.reserve().is_none());
        slots.visible = true;
        slots.after = 0;
        let (free, third, after) = slots.reserve().unwrap();
        assert_eq!((free, after), (b, 0));
        slots.closed = true;
        assert!(!slots.finish(free, third, Some(2)));
        assert!(slots.release(a, first).is_none());
        assert!(slots.reserve().is_none());
    }
}
