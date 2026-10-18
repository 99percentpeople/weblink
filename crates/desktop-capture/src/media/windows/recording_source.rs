//! Pull-based binary recording delivery. IPC and muxer backpressure never run on
//! the encoder/audio threads; stalled consumers exhaust only their bounded taps.
use super::{audio, mf};
use crate::media::recording::{EncodedRecordingTap, Packet, PacketKind, Subscription};
use crate::media::RecordingInfo;
use crate::Result;
use libwebrtc::peer_connection::{PeerConnection, PeerConnectionState};
use std::sync::{mpsc::RecvTimeoutError, Arc, Mutex, Weak};
use std::time::Duration;

struct Input {
    tap: Arc<EncodedRecordingTap>,
    subscription: Subscription,
}
impl Input {
    fn new(tap: Arc<EncodedRecordingTap>) -> Result<Self> {
        let subscription = tap.subscribe()?;
        tap.set_active(&subscription, false, 0);
        Ok(Self { tap, subscription })
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        self.tap.unsubscribe(&self.subscription);
    }
}
struct State {
    video: Input,
    audio: Option<Input>,
    active: bool,
    segment: u32,
    ended: bool,
    closing: bool,
}
pub(super) struct RecordingSource {
    encoder: Weak<mf::Encoder>,
    sender: PeerConnection,
    state: Mutex<State>,
    pub info: RecordingInfo,
}
impl RecordingSource {
    pub fn new(
        encoder: &Arc<mf::Encoder>,
        sender: PeerConnection,
        audio: Option<&audio::Loopback>,
    ) -> Result<Self> {
        Ok(Self {
            encoder: Arc::downgrade(encoder),
            sender,
            info: RecordingInfo {
                audio: audio.map(|audio| audio.format.clone()),
            },
            state: Mutex::new(State {
                video: Input::new(encoder.recording.clone())?,
                audio: audio
                    .map(|audio| Input::new(audio.recording.clone()))
                    .transpose()?,
                active: false,
                segment: 0,
                ended: false,
                closing: false,
            }),
        })
    }
    pub fn control(&self, active: bool, segment: u32) -> Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.ended {
            return Ok(());
        }
        if segment < state.segment {
            return Err("Outdated recording segment".into());
        }
        if active == state.active && segment == state.segment {
            return Ok(());
        }
        state.active = active;
        state.segment = segment;
        state
            .video
            .tap
            .set_active(&state.video.subscription, active, segment);
        if let Some(audio) = &state.audio {
            audio.tap.set_active(&audio.subscription, active, segment);
        }
        drop(state);
        if active {
            if let Some(encoder) = self.encoder.upgrade() {
                encoder.request_recording_keyframe();
            }
        }
        Ok(())
    }
    pub fn read(&self) -> Vec<u8> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut bytes = Vec::new();
        if state.ended {
            terminal(&mut bytes, None);
            return bytes;
        }
        let disconnected = self.sender.connection_state() != PeerConnectionState::Connected;
        let input_error = state.video.subscription.error().or_else(|| {
            state
                .audio
                .as_ref()
                .and_then(|audio| audio.subscription.error())
        });
        state.closing |= disconnected || input_error.is_some();
        if state.closing {
            state.video.tap.unsubscribe(&state.video.subscription);
            if let Some(audio) = &state.audio {
                audio.tap.unsubscribe(&audio.subscription);
            }
        }
        let mut video_done = false;
        let mut audio_done = state.audio.is_none();
        let mut error = input_error;
        // One IPC response remains bounded even at high bitrates. Send video
        // before PCM so the muxer can establish a keyframe's common clock first.
        for index in 0..32 {
            match state.video.subscription.receive(if index == 0 {
                Duration::from_millis(40)
            } else {
                Duration::ZERO
            }) {
                Ok(packet) => {
                    encode(&mut bytes, packet);
                    if bytes.len() >= 1024 * 1024 {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    video_done = true;
                    error = error.or_else(|| state.video.subscription.error());
                    break;
                }
            }
        }
        if video_done {
            state.closing = true;
            if let Some(audio) = &state.audio {
                audio.tap.unsubscribe(&audio.subscription);
            }
        }
        if let Some(audio) = &state.audio {
            for _ in 0..32 {
                match audio.subscription.receive(Duration::ZERO) {
                    Ok(packet) => encode(&mut bytes, packet),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        audio_done = true;
                        error = error.or_else(|| audio.subscription.error());
                        break;
                    }
                }
            }
        }
        if audio_done && state.audio.is_some() {
            state.closing = true;
            state.video.tap.unsubscribe(&state.video.subscription);
        }
        if video_done && audio_done {
            state.ended = true;
            state.video.tap.unsubscribe(&state.video.subscription);
            if let Some(audio) = &state.audio {
                audio.tap.unsubscribe(&audio.subscription);
            }
            terminal(&mut bytes, error.as_deref());
        }
        bytes
    }
}

// Fixed 36-byte LE header followed by payload. No JSON/base64 copies of media.
fn encode(output: &mut Vec<u8>, packet: Packet) {
    let (kind, codec, width, height, rate, channels) = match packet.kind {
        PacketKind::Video {
            codec,
            width,
            height,
        } => (0u8, codec, width, height, 0, 0),
        PacketKind::Audio {
            sample_rate,
            channels,
        } => (1, 0, 0, 0, sample_rate, channels),
    };
    output.extend_from_slice(&(packet.bytes.len() as u32).to_le_bytes());
    output.extend_from_slice(&packet.segment.to_le_bytes());
    output.extend_from_slice(&packet.timestamp_us.to_le_bytes());
    for value in [width, height, rate, channels] {
        output.extend_from_slice(&value.to_le_bytes());
    }
    output.extend_from_slice(&[kind, codec, u8::from(packet.keyframe), 0]);
    output.extend_from_slice(&packet.bytes);
}
fn terminal(output: &mut Vec<u8>, error: Option<&str>) {
    let text = error.unwrap_or("").as_bytes();
    output.extend_from_slice(&(text.len() as u32).to_le_bytes());
    output.extend_from_slice(&[0; 28]);
    output.extend_from_slice(&[2, 0, 0, 0]);
    output.extend_from_slice(text);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_recording_binary_keeps_audio_clock_format_and_terminal_reason() {
        let mut data = Vec::new();
        encode(
            &mut data,
            Packet {
                bytes: vec![1, 2, 3, 4],
                timestamp_us: 1234567,
                keyframe: true,
                kind: PacketKind::Audio {
                    sample_rate: 48000,
                    channels: 2,
                },
                segment: 3,
            },
        );
        assert_eq!(data.len(), 40);
        assert_eq!(i64::from_le_bytes(data[8..16].try_into().unwrap()), 1234567);
        assert_eq!(u32::from_le_bytes(data[24..28].try_into().unwrap()), 48000);
        assert_eq!(data[32], 1);
        terminal(&mut data, Some("storage failed"));
        assert_eq!(data[72], 2);
        assert_eq!(&data[76..], b"storage failed");
    }
}
