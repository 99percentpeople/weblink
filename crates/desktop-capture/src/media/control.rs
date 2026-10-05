//! Optional media DataChannel boundary. Authorization and input belong to the native owner.
use std::sync::Arc;
pub const RELIABLE_LABEL: &str = "weblink-control";
pub const MOVEMENT_LABEL: &str = "weblink-pointer";
pub const MAX_BYTES: usize = 4096;
// Host cursor images have a separate bound; input packets retain their 4 KiB limit.
pub const MAX_OUTBOUND_BYTES: usize = 24 * 1024;
pub const HIGH_WATER: u64 = 64 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendResult {
    Sent,
    Backpressure,
    Closed,
}
pub trait Sender: Send + Sync {
    fn send(&self, data: &[u8]) -> SendResult;
    fn close(&self);
}
/// Callbacks must not block WebRTC threads. Closing input does not end screen viewing.
pub trait Port: Send + Sync {
    fn opened(&self, sender: Arc<dyn Sender>);
    fn message(&self, movement: bool, data: &[u8]);
    fn closed(&self);
}
