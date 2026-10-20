//! A recording owns its pool lease independently of any viewer.
use super::{audio, encoding_pool};
use crate::media::recording::{
    EncodedRecordingTap, PcmAudioSource, RecordingAudioInputs, RecordingInputs, VideoSource,
};
use std::sync::Arc;

struct SharedVideo {
    consumer: Arc<encoding_pool::Consumer>,
    tap: Arc<EncodedRecordingTap>,
}
impl VideoSource for SharedVideo {
    fn tap(&self) -> Arc<EncodedRecordingTap> {
        self.tap.clone()
    }
    fn is_connected(&self) -> bool {
        self.consumer
            .encoder()
            .is_some_and(|encoder| encoder.error().is_none())
    }
    fn request_keyframe(&self) {
        if let Some(encoder) = self.consumer.encoder() {
            encoder.request_recording_keyframe();
        }
    }
    fn release(&self) {
        self.consumer.close();
    }
}

pub(super) fn inputs(
    consumer: Arc<encoding_pool::Consumer>,
    audio: Option<&audio::Loopback>,
) -> RecordingInputs {
    let tap = consumer.encoder().unwrap().recording.clone();
    RecordingInputs {
        video: Arc::new(SharedVideo { consumer, tap }),
        audio: audio.map(|audio| RecordingAudioInputs {
            pcm: PcmAudioSource {
                tap: audio.recording.clone(),
                format: audio.format.clone(),
            },
            // Network audio ends with its viewer. Capture PCM shares the
            // recording's lifetime and clock and is encoded once by its muxer.
            encoded: None,
        }),
    }
}
