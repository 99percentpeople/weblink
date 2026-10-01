use crate::{media::control::*, Result};
use libwebrtc::{
    data_channel::{DataChannel, DataChannelInit, DataChannelState},
    peer_connection::{PeerConnection, PeerConnectionState},
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
pub(super) struct Channels {
    reliable: DataChannel,
    movement: DataChannel,
    port: Arc<dyn Port>,
    closed: AtomicBool,
    opened: AtomicBool,
}
/// The media owner detaches callbacks while it still holds a strong reference.
/// A callback's temporary Arc must never become the last owner and unsubscribe itself.
pub(super) struct Connection(Arc<Channels>);
impl Connection {
    pub fn close(&self) {
        self.0.close();
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.close();
    }
}
impl Channels {
    pub fn connect(pc: &PeerConnection, port: Arc<dyn Port>) -> Result<Connection> {
        let reliable = pc
            .create_data_channel(
                RELIABLE_LABEL,
                DataChannelInit {
                    protocol: RELIABLE_LABEL.into(),
                    ..Default::default()
                },
            )
            .map_err(|e| e.to_string())?;
        let movement = match pc.create_data_channel(
            MOVEMENT_LABEL,
            DataChannelInit {
                protocol: MOVEMENT_LABEL.into(),
                ordered: false,
                max_retransmits: Some(0),
                ..Default::default()
            },
        ) {
            Ok(c) => c,
            Err(e) => {
                reliable.close();
                port.closed();
                return Err(e.to_string());
            }
        };
        let this = Arc::new(Self {
            reliable,
            movement,
            port,
            closed: AtomicBool::new(false),
            opened: AtomicBool::new(false),
        });
        for (movement, channel) in [(false, &this.reliable), (true, &this.movement)] {
            let weak = Arc::downgrade(&this);
            channel.on_state_change(Some(Box::new(move |state| {
                if let Some(this) = weak.upgrade() {
                    if matches!(state, DataChannelState::Closing | DataChannelState::Closed) {
                        this.terminate();
                    } else {
                        this.ready();
                    }
                }
            })));
            let weak = Arc::downgrade(&this);
            channel.on_message(Some(Box::new(move |buffer| {
                if let Some(this) = weak.upgrade() {
                    if this.closed.load(Ordering::Acquire) {
                        return;
                    }
                    if buffer.binary || buffer.data.len() > MAX_BYTES {
                        this.terminate();
                        return;
                    }
                    this.port.message(movement, buffer.data);
                }
            })));
        }
        let weak = Arc::downgrade(&this);
        pc.on_connection_state_change(Some(Box::new(move |state| {
            if matches!(
                state,
                PeerConnectionState::Disconnected
                    | PeerConnectionState::Failed
                    | PeerConnectionState::Closed
            ) {
                if let Some(this) = weak.upgrade() {
                    this.terminate();
                }
            }
        })));
        this.ready();
        Ok(Connection(this))
    }
    fn ready(self: &Arc<Self>) {
        if !self.closed.load(Ordering::Acquire)
            && self.reliable.state() == DataChannelState::Open
            && self.movement.state() == DataChannelState::Open
            && !self.opened.swap(true, Ordering::AcqRel)
        {
            // Weak sender prevents the owner's outbound handle from retaining the media connection.
            self.port.opened(Arc::new(Outbound(Arc::downgrade(self))));
        }
    }
    fn terminate(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            self.port.closed();
        }
    }
    pub fn close(&self) {
        self.terminate();
        for c in [&self.reliable, &self.movement] {
            c.on_message(None);
            c.on_state_change(None);
            c.close();
        }
    }
}
struct Outbound(std::sync::Weak<Channels>);
impl Sender for Outbound {
    fn close(&self) {
        if let Some(channels) = self.0.upgrade() {
            channels.close();
        }
    }
    fn send(&self, data: &[u8]) -> bool {
        self.0.upgrade().is_some_and(|c| {
            !c.closed.load(Ordering::Acquire)
                && data.len() <= MAX_BYTES
                && c.reliable.buffered_amount() + data.len() as u64 <= HIGH_WATER
                && c.reliable.send(data, false).is_ok()
        })
    }
}
