//! Bounded control queues. Congestion interrupts input, not the viewing connection.
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use weblink_desktop_capture::media::control::{Port, SendResult, Sender};
use weblink_desktop_input::{protocol, wire};

const CAPACITY: usize = 128;
#[derive(Default)]
struct Queue {
    reliable: VecDeque<(Instant, Vec<u8>)>,
    movement: Option<(Instant, Vec<u8>)>,
    interrupted: bool,
}
#[derive(Default)]
pub(super) struct Endpoint {
    pub(super) closed: Arc<AtomicBool>,
    sender: Mutex<Option<Arc<dyn Sender>>>,
    queue: Mutex<Queue>,
    outbound: Mutex<VecDeque<serde_json::Value>>,
}
impl Endpoint {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
    pub fn is_open(&self) -> bool {
        !self.is_closed()
            && self
                .sender
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some()
    }
    pub fn send(&self, value: &impl Serialize) -> bool {
        let Ok(value) = serde_json::to_value(value) else {
            self.closed();
            return false;
        };
        if self.is_closed() {
            return false;
        }
        {
            let mut q = self.outbound.lock().unwrap_or_else(|e| e.into_inner());
            // Only the latest liveness/state observation matters. Consent messages
            // keep their original order, including a revoke queued behind a grant.
            if matches!(value["type"].as_str(), Some("heartbeat" | "state")) {
                q.retain(|old| {
                    !(old["type"] == value["type"]
                        && old["grantId"] == value["grantId"]
                        && old["inputEpoch"] == value["inputEpoch"])
                });
            }
            if q.len() >= CAPACITY {
                self.closed();
                return false;
            }
            q.push_back(value);
        }
        self.flush();
        !self.is_closed()
    }
    pub fn flush(&self) {
        if self.is_closed() {
            return;
        }
        let mut q = self.outbound.lock().unwrap_or_else(|e| e.into_inner());
        let sender = self.sender.lock().unwrap_or_else(|e| e.into_inner());
        let Some(sender) = sender.as_ref() else {
            return;
        };
        while let Some(value) = q.front() {
            let Ok(data) = serde_json::to_vec(value) else {
                self.closed();
                return;
            };
            match sender.send(&data) {
                SendResult::Sent => {
                    q.pop_front();
                }
                SendResult::Backpressure => break,
                SendResult::Closed => {
                    self.closed();
                    break;
                }
            }
        }
    }
    pub fn dispose(&self) {
        self.closed();
        let sender = self.sender.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(sender) = sender {
            sender.close();
        }
        self.outbound
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
    pub fn take_interrupted(&self) -> bool {
        let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut q.interrupted)
    }
    pub fn pop(&self) -> Option<(bool, Instant, Vec<u8>)> {
        let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        q.reliable
            .pop_front()
            .map(|(at, data)| (false, at, data))
            .or_else(|| q.movement.take().map(|(at, data)| (true, at, data)))
    }
}
impl Port for Endpoint {
    fn opened(&self, sender: Arc<dyn Sender>) {
        *self.sender.lock().unwrap_or_else(|e| e.into_inner()) = Some(sender);
    }
    fn message(&self, movement: bool, data: &[u8]) {
        if self.is_closed() {
            return;
        }
        if data.len() > protocol::MAX_MESSAGE_BYTES {
            self.closed();
            return;
        }
        let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let input = movement || wire::parse(data).is_some();
        if !movement && q.reliable.len() >= CAPACITY {
            // Keep consent/revocation messages, discard the delayed gesture burst.
            q.reliable.retain(|(_, data)| wire::parse(data).is_none());
            q.movement = None;
            q.interrupted = true;
            if q.reliable.len() >= CAPACITY {
                self.closed();
                return;
            }
        }
        if input && q.interrupted {
            return;
        }
        if movement {
            q.movement = Some((Instant::now(), data.to_vec()));
        } else {
            q.reliable.push_back((Instant::now(), data.to_vec()));
        }
    }
    fn closed(&self) {
        self.closed.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[derive(Default)]
    struct Fake {
        busy: AtomicBool,
        sent: Mutex<Vec<serde_json::Value>>,
    }
    impl Sender for Fake {
        fn send(&self, data: &[u8]) -> SendResult {
            if self.busy.load(Ordering::Acquire) {
                return SendResult::Backpressure;
            }
            self.sent
                .lock()
                .unwrap()
                .push(serde_json::from_slice(data).unwrap());
            SendResult::Sent
        }
        fn close(&self) {}
    }
    #[test]
    fn congestion_preserves_consent_order_and_coalesces_liveness() {
        let endpoint = Endpoint::new();
        let sender = Arc::new(Fake::default());
        sender.busy.store(true, Ordering::Release);
        endpoint.opened(sender.clone());
        assert!(endpoint.is_open());
        assert!(endpoint.send(&json!({"type":"grant","grantId":"g"})));
        for _ in 0..1000 {
            assert!(endpoint.send(&json!({"type":"heartbeat","grantId":"g"})));
        }
        assert!(endpoint.send(&json!({"type":"revoke","grantId":"g"})));
        assert_eq!(endpoint.outbound.lock().unwrap().len(), 3);
        assert!(!endpoint.is_closed());
        sender.busy.store(false, Ordering::Release);
        endpoint.flush();
        let sent = sender.sent.lock().unwrap();
        assert_eq!(
            sent.iter()
                .map(|v| v["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["grant", "heartbeat", "revoke"]
        );
        drop(sent);
        endpoint.dispose();
        assert!(!endpoint.send(&json!({"type":"heartbeat"})));
    }
    #[test]
    fn input_overflow_keeps_channel_and_revocation_but_drops_old_gestures() {
        let endpoint = Endpoint::new();
        let packet = json!({"type":"input","grantId":"g","generation":"m","geometryRevision":"r","inputEpoch":"e","sequence":2,"event":{"type":"wheel","x":0.5,"y":0.5,"horizontal":0,"vertical":120}}).to_string();
        for _ in 0..CAPACITY {
            endpoint.message(false, packet.as_bytes());
        }
        let revoke = br#"{"type":"revoke","grantId":"g","reason":"local"}"#;
        endpoint.message(false, revoke);
        endpoint.message(false, packet.as_bytes());
        assert!(!endpoint.is_closed());
        assert!(endpoint.take_interrupted());
        assert!(!endpoint.take_interrupted());
        assert_eq!(endpoint.pop().unwrap().2, revoke);
        assert!(endpoint.pop().is_none());
        endpoint.message(false, packet.as_bytes());
        assert!(endpoint.pop().is_some());
    }
}
