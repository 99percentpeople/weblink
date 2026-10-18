//! Reusable SDK adapters. OS capture, GPU resources and audio devices stay in
//! their backend; the recording core only sees its backend-neutral ports.
mod recording_audio;
pub(super) use recording_audio::SenderAudioRecording;

/// Keep software frame budgets stable when the shared capture worker is idle.
pub(super) fn configure_software_vfr(
    factory: &libwebrtc::peer_connection_factory::PeerConnectionFactory,
    frame_rate: u32,
) -> crate::Result<()> {
    factory
        .set_software_vfr_frame_rate(Some(frame_rate))
        .map_err(|error| error.to_string())
}

/// The clock used by both native video and encoded audio capture timestamps.
pub(super) fn clock_us() -> i64 {
    libwebrtc::audio_source::native::NativeAudioSource::capture_clock_us()
}
