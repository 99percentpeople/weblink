//! Reusable SDK adapters. OS capture, GPU resources and audio devices stay in
//! their backend; the recording core only sees its backend-neutral ports.
mod recording_audio;
pub(super) use recording_audio::SenderAudioRecording;

/// The clock used by both native video and encoded audio capture timestamps.
pub(super) fn clock_us() -> i64 {
    libwebrtc::audio_source::native::NativeAudioSource::capture_clock_us()
}
