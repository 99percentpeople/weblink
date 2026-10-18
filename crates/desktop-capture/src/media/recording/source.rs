//! Pull-based recording over backend ports. Nothing here depends on a GPU,
//! capture API, WebRTC implementation, Tauri or a storage provider.
use super::wire::{encode, terminal};
use super::{EncodedRecordingTap, Subscription};
use crate::media::{AudioCaptureFormat, RecordingInfo};
use crate::Result;
use std::sync::{mpsc::RecvTimeoutError, Arc, Mutex};
use std::time::Duration;

#[cfg(test)]
#[path = "source_tests.rs"]
mod tests;

/// Borrows an existing sender; implementations must never start or stop streaming.
pub(crate) trait VideoSource: Send + Sync {
    fn tap(&self) -> Arc<EncodedRecordingTap>;
    fn is_connected(&self) -> bool;
    fn request_keyframe(&self);
}

/// Controls recording copies only; disabling this port must still forward audio.
pub(crate) trait EncodedAudioSource: Send + Sync {
    fn tap(&self) -> Arc<EncodedRecordingTap>;
    fn available(&self) -> bool;
    fn set_active(&self, active: bool);
}

pub(crate) struct PcmAudioSource {
    pub tap: Arc<EncodedRecordingTap>,
    pub format: AudioCaptureFormat,
}

/// A selected source with audio always supplies its PCM fallback, including
/// silence when muted. Unsupported encoded audio must not silently omit sound.
pub(crate) struct RecordingAudioInputs {
    pub pcm: PcmAudioSource,
    pub encoded: Option<Arc<dyn EncodedAudioSource>>,
}

pub(crate) struct RecordingInputs {
    pub video: Arc<dyn VideoSource>,
    pub audio: Option<RecordingAudioInputs>,
}

struct Input {
    tap: Arc<EncodedRecordingTap>,
    subscription: Subscription,
    encoded: Option<Arc<dyn EncodedAudioSource>>,
    released: bool,
}
impl Input {
    fn new(tap: Arc<EncodedRecordingTap>) -> Result<Self> {
        let subscription = tap.subscribe()?;
        tap.set_active(&subscription, false, 0);
        Ok(Self {
            tap,
            subscription,
            encoded: None,
            released: false,
        })
    }
    fn encoded(source: Arc<dyn EncodedAudioSource>) -> Result<Self> {
        let mut input = Self::new(source.tap())?;
        input.encoded = Some(source);
        Ok(input)
    }
    fn set_active(&self, active: bool, segment: u32) {
        if self.released {
            return;
        }
        self.tap.set_active(&self.subscription, active, segment);
        if let Some(encoded) = &self.encoded {
            encoded.set_active(active);
        }
    }
    fn release(&mut self) {
        if std::mem::replace(&mut self.released, true) {
            return;
        }
        if let Some(encoded) = &self.encoded {
            encoded.set_active(false);
        }
        self.tap.unsubscribe(&self.subscription);
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        self.release();
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
    video: Arc<dyn VideoSource>,
    state: Mutex<State>,
    pub info: RecordingInfo,
}
impl RecordingSource {
    pub fn new(inputs: RecordingInputs, prefer_encoded: bool) -> Result<Self> {
        let (audio, format, encoded) = if let Some(audio) = inputs.audio {
            if let Some(source) = audio
                .encoded
                .filter(|source| prefer_encoded && source.available())
            {
                (Some(Input::encoded(source)?), None, true)
            } else {
                (
                    Some(Input::new(audio.pcm.tap)?),
                    Some(audio.pcm.format),
                    false,
                )
            }
        } else {
            (None, None, false)
        };
        Ok(Self {
            state: Mutex::new(State {
                video: Input::new(inputs.video.tap())?,
                audio,
                active: false,
                segment: 0,
                ended: false,
                closing: false,
            }),
            video: inputs.video,
            info: RecordingInfo {
                audio: format,
                encoded_audio: encoded,
            },
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
        state.video.set_active(active, segment);
        if let Some(audio) = &mut state.audio {
            audio.set_active(active, segment);
        }
        drop(state);
        if active {
            self.video.request_keyframe();
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
        let disconnected = !self.video.is_connected();
        let input_error = state.video.subscription.error().or_else(|| {
            state
                .audio
                .as_ref()
                .and_then(|audio| audio.subscription.error())
        });
        state.closing |= disconnected || input_error.is_some();
        if state.closing {
            state.video.release();
            if let Some(audio) = &mut state.audio {
                audio.release();
            }
        }
        let mut video_done = false;
        let mut audio_done = state.audio.is_none();
        let mut error = input_error;
        // One IPC response remains bounded even at high bitrates. Send video
        // before audio so the muxer can establish a keyframe's common clock first.
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
            if let Some(audio) = &mut state.audio {
                audio.release();
            }
        }
        if let Some(audio) = &mut state.audio {
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
            state.video.release();
        }
        if video_done && audio_done {
            state.ended = true;
            state.video.release();
            if let Some(audio) = &mut state.audio {
                audio.release();
            }
            terminal(&mut bytes, error.as_deref());
        }
        bytes
    }
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.ended = true;
        state.video.release();
        if let Some(audio) = &mut state.audio {
            audio.release();
        }
    }
}
impl Drop for RecordingSource {
    fn drop(&mut self) {
        self.close();
    }
}
