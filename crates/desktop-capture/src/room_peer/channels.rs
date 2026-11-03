use crate::{receive::Events, Result};
use libwebrtc::{
    data_channel::{DataChannel, DataChannelInit, DataChannelState},
    peer_connection::PeerConnection,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
};

pub type MessageSink = Arc<dyn Fn(u32, &[u8], bool) -> bool + Send + Sync>;

// Keys identify channels before SCTP assigns its stream ID. Incoming and outgoing
// keys occupy disjoint ranges even if both peers open the same label.
const INCOMING: u32 = 1 << 31;
const MAX_CHANNELS: usize = 256;
const MAX_MESSAGE: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelOptions {
    pub label: String,
    pub protocol: String,
    pub ordered: bool,
    pub max_retransmits: Option<u16>,
    pub max_packet_life_time: Option<u16>,
}

pub(super) struct Channels {
    entries: Mutex<HashMap<u32, DataChannel>>,
    next: AtomicU32,
    closed: AtomicBool,
    events: Events,
    messages: MessageSink,
}

impl Channels {
    pub fn new(events: Events, messages: MessageSink) -> Arc<Self> {
        Arc::new(Self {
            entries: Default::default(),
            next: AtomicU32::new(INCOMING),
            closed: AtomicBool::new(false),
            events,
            messages,
        })
    }
    pub fn create(
        self: &Arc<Self>,
        pc: &PeerConnection,
        key: u32,
        options: ChannelOptions,
    ) -> Result<()> {
        if key == 0
            || key >= INCOMING
            || options.label.len() > 4096
            || options.protocol.len() > 4096
            || (options.max_retransmits.is_some() && options.max_packet_life_time.is_some())
        {
            return Err("Invalid native data channel".into());
        }
        let channel = pc
            .create_data_channel(
                &options.label,
                DataChannelInit {
                    ordered: options.ordered,
                    protocol: options.protocol,
                    max_retransmits: options.max_retransmits.map(i32::from),
                    max_retransmit_time: options.max_packet_life_time.map(i32::from),
                    ..Default::default()
                },
            )
            .map_err(|e| e.to_string())?;
        self.bind(key, channel, false)
    }
    pub fn accept(self: &Arc<Self>, channel: DataChannel) {
        let key = self.next.fetch_add(1, Ordering::Relaxed);
        let _ = self.bind(key, channel, true);
    }
    fn bind(self: &Arc<Self>, key: u32, channel: DataChannel, incoming: bool) -> Result<()> {
        {
            let mut map = self.entries.lock().unwrap();
            if self.closed.load(Ordering::Acquire)
                || map.len() >= MAX_CHANNELS
                || map.contains_key(&key)
            {
                drop(map);
                channel.close();
                return Err("Native data channel limit exceeded".into());
            }
            map.insert(key, channel.clone());
        }
        if incoming {
            (self.events)(
                json!({"type":"channel", "key":key, "label":channel.label(), "protocol":channel.protocol(),
                "ordered":channel.ordered(), "maxRetransmits":channel.max_retransmits(),"maxPacketLifeTime":channel.max_retransmit_time()}),
            );
        }
        let weak = Arc::downgrade(self);
        channel.on_message(Some(Box::new(move |msg| {
            if let Some(channels) = weak.upgrade() {
                if !channels.closed.load(Ordering::Acquire)
                    && (msg.data.len() > MAX_MESSAGE
                        || !(channels.messages)(key, msg.data, msg.binary))
                {
                    channels.close_one(key);
                }
            }
        })));
        let weak = Arc::downgrade(self);
        channel.on_buffered_amount_change(Some(Box::new(move |bytes| {
            if let Some(channels) = weak.upgrade() {
                (channels.events)(json!({"type":"drain","key":key,"bytes":bytes}));
            }
        })));
        let weak = Arc::downgrade(self);
        channel.on_state_change(Some(Box::new(move |state| {
            if let Some(channels) = weak.upgrade() {
                channels.state(key, state);
            }
        })));
        self.state(key, channel.state());
        Ok(())
    }
    fn state(&self, key: u32, state: DataChannelState) {
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        let channel = {
            let mut entries = self.entries.lock().unwrap();
            if state == DataChannelState::Closed {
                entries.remove(&key)
            } else {
                entries.get(&key).cloned()
            }
        };
        if let Some(channel) = channel {
            (self.events)(
                json!({"type":"channel-state","key":key,"state":format!("{state:?}").to_lowercase(),"id":channel.id()}),
            );
        }
    }
    pub fn write(&self, key: u32, data: &[u8], binary: bool) -> Result<()> {
        let dc = self
            .entries
            .lock()
            .unwrap()
            .get(&key)
            .cloned()
            .ok_or("Native data channel closed")?;
        if data.len() > MAX_MESSAGE || dc.state() != DataChannelState::Open {
            return Err("Native data channel not writable".into());
        }
        dc.send(data, binary).map_err(|e| e.to_string())
    }
    pub fn close_one(&self, key: u32) {
        let dc = self.entries.lock().unwrap().get(&key).cloned();
        if let Some(dc) = dc {
            dc.close();
        }
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let entries = std::mem::take(&mut *self.entries.lock().unwrap());
        for dc in entries.into_values() {
            dc.on_state_change(None);
            dc.on_message(None);
            dc.on_buffered_amount_change(None);
            dc.close();
        }
    }
}
