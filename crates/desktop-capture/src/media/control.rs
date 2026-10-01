//! Optional media DataChannel boundary. Authorization and input belong to the native owner.
use std::sync::Arc;
pub const RELIABLE_LABEL: &str = "weblink-control";
pub const MOVEMENT_LABEL: &str = "weblink-pointer";
pub const MAX_BYTES: usize = 4096;
pub const HIGH_WATER: u64 = 16 * 1024;
pub trait Sender: Send + Sync {
    fn send(&self, data: &[u8]) -> bool;
    fn close(&self);
}
/// Callbacks must not block WebRTC threads. Closing input does not end screen viewing.
pub trait Port: Send + Sync {
    fn opened(&self, sender: Arc<dyn Sender>);
    fn message(&self, movement: bool, data: &[u8]);
    fn closed(&self);
}
