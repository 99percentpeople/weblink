//! Windows adapters for the portable recording inputs. Selection stays with the
//! media session; recording lifetime and binary delivery stay in the common core.
use super::{audio, mf};
use crate::media::recording::{
    EncodedAudioSource, EncodedRecordingTap, PcmAudioSource, RecordingAudioInputs, RecordingInputs,
    VideoSource,
};
use crate::media::webrtc::SenderAudioRecording;
use libwebrtc::peer_connection::{PeerConnection, PeerConnectionState};
use std::sync::{Arc, Weak};

struct SenderVideo {
    encoder: Weak<mf::Encoder>,
    tap: Arc<EncodedRecordingTap>,
    sender: PeerConnection,
}
impl VideoSource for SenderVideo {
    fn tap(&self) -> Arc<EncodedRecordingTap> {
        self.tap.clone()
    }
    fn is_connected(&self) -> bool {
        self.sender.connection_state() == PeerConnectionState::Connected
    }
    fn request_keyframe(&self) {
        if let Some(encoder) = self.encoder.upgrade() {
            encoder.request_recording_keyframe();
        }
    }
}

pub(super) fn inputs(
    encoder: &Arc<mf::Encoder>,
    sender: PeerConnection,
    audio: Option<&audio::Loopback>,
    encoded: Option<Arc<SenderAudioRecording>>,
) -> RecordingInputs {
    RecordingInputs {
        video: Arc::new(SenderVideo {
            encoder: Arc::downgrade(encoder),
            tap: encoder.recording.clone(),
            sender,
        }),
        audio: audio.map(|audio| RecordingAudioInputs {
            pcm: PcmAudioSource {
                tap: audio.recording.clone(),
                format: audio.format.clone(),
            },
            encoded: encoded.map(|source| source as Arc<dyn EncodedAudioSource>),
        }),
    }
}
