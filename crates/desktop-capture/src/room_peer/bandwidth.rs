use crate::{
    media::{AUDIO_BITRATE_BPS, DEFAULT_VIDEO_BITRATE_BPS},
    Result,
};
use libwebrtc::{
    peer_connection::{BitrateSettings, PeerConnection},
    rtp_transceiver::RtpTransceiver,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

struct Sender {
    screen: Option<RtpTransceiver>,
    limit: u64,
    system_audio: bool,
}

#[derive(Default)]
struct State {
    next: u64,
    senders: HashMap<u64, Sender>,
    applied: Option<u64>,
}

impl State {
    fn apply(&mut self, pc: &PeerConnection) -> Result<()> {
        // Camera/data-only rooms retain the engine's transport defaults.
        let maximum = self.senders.values().any(|s| s.screen.is_some()).then(|| {
            self.senders
                .values()
                .fold(0u64, |sum, s| {
                    sum.saturating_add(s.limit)
                        .saturating_add(if s.system_audio { AUDIO_BITRATE_BPS } else { 0 })
                })
                .min(i32::MAX as u64)
        });
        if self.applied != maximum {
            pc.set_bitrate(BitrateSettings {
                max_bitrate_bps: maximum,
                ..Default::default()
            })
            .map_err(|e| e.to_string())?;
            self.applied = maximum;
        }
        Ok(())
    }
}

pub(crate) struct RoomBandwidth {
    pc: PeerConnection,
    state: Mutex<State>,
}

impl RoomBandwidth {
    #[cfg(test)]
    pub(super) fn applied_maximum(&self) -> Option<u64> {
        self.state.lock().unwrap().applied
    }

    pub(super) fn new(pc: PeerConnection) -> Arc<Self> {
        Arc::new(Self {
            pc,
            state: Mutex::default(),
        })
    }

    pub(super) fn capture(self: &Arc<Self>, video: bool) -> Result<SenderBudget> {
        // A camera's per-viewer limit arrives after add_capture. Reserve the
        // normal meeting video budget until then, without an INT_MAX probe.
        let limit = if video {
            DEFAULT_VIDEO_BITRATE_BPS
        } else {
            AUDIO_BITRATE_BPS
        };
        self.register(Sender {
            screen: None,
            limit,
            system_audio: false,
        })
    }

    pub(crate) fn screen(
        self: &Arc<Self>,
        video: RtpTransceiver,
        limit: u64,
        system_audio: bool,
    ) -> Result<SenderBudget> {
        self.register(Sender {
            screen: Some(video),
            limit,
            system_audio,
        })
    }

    fn register(self: &Arc<Self>, sender: Sender) -> Result<SenderBudget> {
        let mut state = self.state.lock().unwrap();
        let key = state.next;
        state.next += 1;
        let default_limit = sender.limit;
        state.senders.insert(key, sender);
        if let Err(error) = state.apply(&self.pc) {
            state.senders.remove(&key);
            return Err(error);
        }
        Ok(SenderBudget {
            room: self.clone(),
            key,
            default_limit,
        })
    }

    pub(super) fn screen_limits(&self) -> HashMap<String, u64> {
        self.state
            .lock()
            .unwrap()
            .senders
            .values()
            .filter_map(|sender| Some((sender.screen.as_ref()?.mid()?, sender.limit)))
            .collect()
    }
}

// Owned by the publication so closing capture also releases its transport budget.
pub(crate) struct SenderBudget {
    room: Arc<RoomBandwidth>,
    key: u64,
    default_limit: u64,
}

impl SenderBudget {
    pub(crate) fn set_limit(&self, limit: Option<u64>) -> Result<u64> {
        let mut state = self.room.state.lock().unwrap();
        let sender = state.senders.get_mut(&self.key).unwrap();
        let previous = std::mem::replace(&mut sender.limit, limit.unwrap_or(self.default_limit));
        if let Err(error) = state.apply(&self.room.pc) {
            state.senders.get_mut(&self.key).unwrap().limit = previous;
            return Err(error);
        }
        Ok(previous)
    }
}

impl Drop for SenderBudget {
    fn drop(&mut self) {
        let mut state = self.room.state.lock().unwrap();
        state.senders.remove(&self.key);
        let _ = state.apply(&self.room.pc);
    }
}
