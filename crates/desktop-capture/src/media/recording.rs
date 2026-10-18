//! A bounded side channel for recording copies. The sender never waits for a
//! recorder, a local transport, IPC, or storage to consume a packet.
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant};

/// Shared monotonic clock for encoded video and captured audio.
pub(crate) fn clock_us() -> i64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    ORIGIN.get_or_init(Instant::now).elapsed().as_micros() as i64
}

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_PACKETS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PacketKind {
    Video { codec: u8, width: u32, height: u32 },
    Audio { sample_rate: u32, channels: u32 },
}
pub(crate) struct Packet {
    pub bytes: Vec<u8>,
    pub timestamp_us: i64,
    pub keyframe: bool,
    pub kind: PacketKind,
    pub segment: u32,
}

struct Shared {
    bytes: AtomicUsize,
    error: Mutex<Option<String>>,
}
struct Sender {
    queue: SyncSender<Packet>,
    shared: Arc<Shared>,
    waiting_keyframe: bool,
    active: bool,
    segment: u32,
}

#[derive(Default)]
pub(crate) struct EncodedRecordingTap {
    // Only registration and publishing hold this lock; consumers never hold it.
    sender: Mutex<Option<Sender>>,
    closed: AtomicBool,
}
impl EncodedRecordingTap {
    pub fn subscribe(&self) -> Result<Subscription, String> {
        let mut sender = self.sender.lock().unwrap_or_else(|e| e.into_inner());
        if self.closed.load(Ordering::Acquire) {
            return Err("Native recording sender has ended".into());
        }
        if sender.is_some() {
            return Err("This sender already has a recording subscriber".into());
        }
        let (queue, receiver) = mpsc::sync_channel(MAX_PACKETS);
        let shared = Arc::new(Shared {
            bytes: AtomicUsize::new(0),
            error: Mutex::new(None),
        });
        *sender = Some(Sender {
            queue,
            shared: shared.clone(),
            waiting_keyframe: true,
            active: true,
            segment: 0,
        });
        Ok(Subscription { receiver, shared })
    }

    pub fn publish(&self, mut packet: Packet) {
        let mut slot = self.sender.lock().unwrap_or_else(|e| e.into_inner());
        let Some(sender) = slot.as_mut() else { return };
        if !sender.active {
            return;
        }
        if sender.waiting_keyframe && !packet.keyframe {
            return;
        }
        packet.segment = sender.segment;
        let bytes = packet.bytes.len();
        if sender.shared.bytes.load(Ordering::Acquire) + bytes > MAX_BYTES {
            Self::overflow(&mut slot);
            return;
        }
        sender.shared.bytes.fetch_add(bytes, Ordering::AcqRel);
        match sender.queue.try_send(packet) {
            Ok(()) => sender.waiting_keyframe = false,
            Err(error) => {
                sender.shared.bytes.fetch_sub(bytes, Ordering::AcqRel);
                match error {
                    TrySendError::Full(_) => Self::overflow(&mut slot),
                    TrySendError::Disconnected(_) => {
                        slot.take();
                    }
                }
            }
        }
    }

    pub fn set_active(&self, subscription: &Subscription, active: bool, segment: u32) {
        let mut slot = self.sender.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sender) = slot
            .as_mut()
            .filter(|sender| Arc::ptr_eq(&sender.shared, &subscription.shared))
        {
            sender.active = active;
            sender.segment = segment;
            sender.waiting_keyframe = true;
            while let Ok(packet) = subscription.receiver.try_recv() {
                sender
                    .shared
                    .bytes
                    .fetch_sub(packet.bytes.len(), Ordering::AcqRel);
            }
        }
    }
    pub fn has_subscriber(&self) -> bool {
        self.sender
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|s| s.active)
    }

    fn overflow(slot: &mut Option<Sender>) {
        if let Some(sender) = slot.take() {
            *sender
                .shared
                .error
                .lock()
                .unwrap_or_else(|e| e.into_inner()) =
                Some("Native recording cannot keep up with the sender".into());
        }
    }

    pub fn end(&self) {
        let mut sender = self.sender.lock().unwrap_or_else(|e| e.into_inner());
        self.closed.store(true, Ordering::Release);
        sender.take();
    }

    pub fn unsubscribe(&self, subscription: &Subscription) {
        let mut slot = self.sender.lock().unwrap_or_else(|e| e.into_inner());
        if slot
            .as_ref()
            .is_some_and(|sender| Arc::ptr_eq(&sender.shared, &subscription.shared))
        {
            slot.take();
        }
    }
}

pub(crate) struct Subscription {
    receiver: Receiver<Packet>,
    shared: Arc<Shared>,
}
impl Subscription {
    pub fn receive(&self, timeout: Duration) -> Result<Packet, RecvTimeoutError> {
        let packet = self.receiver.recv_timeout(timeout)?;
        self.shared
            .bytes
            .fetch_sub(packet.bytes.len(), Ordering::AcqRel);
        Ok(packet)
    }
    pub fn error(&self) -> Option<String> {
        self.shared
            .error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet(timestamp_us: i64, keyframe: bool, bytes: usize) -> Packet {
        Packet {
            bytes: vec![0; bytes],
            timestamp_us,
            keyframe,
            kind: PacketKind::Video {
                codec: 1,
                width: 1280,
                height: 720,
            },
            segment: 0,
        }
    }
    #[test]
    fn waits_for_keyframe_preserves_order_and_drains_on_source_end() {
        let tap = EncodedRecordingTap::default();
        let subscriber = tap.subscribe().unwrap();
        tap.publish(packet(0, false, 1));
        tap.publish(packet(1, true, 3));
        tap.publish(packet(2, false, 4));
        tap.end();
        for stamp in [1, 2] {
            let frame = subscriber.receive(Duration::ZERO).unwrap();
            assert_eq!(frame.timestamp_us, stamp);
            assert_eq!(
                frame.kind,
                PacketKind::Video {
                    codec: 1,
                    width: 1280,
                    height: 720
                }
            );
        }
        assert_eq!(subscriber.shared.bytes.load(Ordering::Acquire), 0);
        assert!(matches!(
            subscriber.receive(Duration::ZERO),
            Err(RecvTimeoutError::Disconnected)
        ));
        assert!(subscriber.error().is_none());
        assert!(tap.subscribe().is_err());
    }
    #[test]
    fn paused_subscriptions_discard_backlog_and_resume_on_a_fresh_keyframe() {
        let tap = EncodedRecordingTap::default();
        let subscriber = tap.subscribe().unwrap();
        tap.publish(packet(0, true, 10));
        tap.set_active(&subscriber, false, 1);
        for index in 0..1000 {
            tap.publish(packet(index, true, 10));
        }
        assert_eq!(subscriber.shared.bytes.load(Ordering::Acquire), 0);
        assert!(subscriber.error().is_none());
        tap.set_active(&subscriber, true, 2);
        tap.publish(packet(1001, false, 10));
        assert!(subscriber.receive(Duration::ZERO).is_err());
        tap.publish(packet(1002, true, 10));
        let packet = subscriber.receive(Duration::ZERO).unwrap();
        assert_eq!(packet.timestamp_us, 1002);
        assert_eq!(packet.segment, 2);
        tap.unsubscribe(&subscriber);
    }
    #[test]
    fn slow_recording_is_bounded_and_never_blocks_the_sender() {
        for size in [1, MAX_BYTES / 2] {
            let tap = EncodedRecordingTap::default();
            let subscriber = tap.subscribe().unwrap();
            for stamp in 0..40 {
                tap.publish(packet(stamp, true, size));
            }
            assert!(subscriber.shared.bytes.load(Ordering::Acquire) <= MAX_BYTES);
            assert!(subscriber.error().unwrap().contains("cannot keep up"));
            let mut count = 0;
            while subscriber.receive(Duration::ZERO).is_ok() {
                count += 1;
            }
            assert_eq!(count, MAX_PACKETS.min(MAX_BYTES / size));
            let next = tap.subscribe().unwrap();
            tap.publish(packet(1001, true, 1));
            assert_eq!(next.receive(Duration::ZERO).unwrap().timestamp_us, 1001);
        }
    }
    #[test]
    fn closing_recording_does_not_end_the_encoder_or_a_new_subscription() {
        let tap = EncodedRecordingTap::default();
        let old = tap.subscribe().unwrap();
        assert!(tap.subscribe().is_err());
        tap.unsubscribe(&old);
        let next = tap.subscribe().unwrap();
        tap.unsubscribe(&old);
        tap.publish(packet(1, true, 1));
        assert_eq!(next.receive(Duration::ZERO).unwrap().timestamp_us, 1);
        tap.unsubscribe(&next);
    }
}
