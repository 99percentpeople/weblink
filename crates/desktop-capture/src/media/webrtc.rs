//! Reusable SDK adapters. OS capture, GPU resources and audio devices stay in
//! their backend; the recording core only sees its backend-neutral ports.
mod recording_audio;
pub(super) use recording_audio::SenderAudioRecording;

pub(crate) fn update_sender_parameters(
    sender: &libwebrtc::rtp_sender::RtpSender,
    mut update: impl FnMut(&mut libwebrtc::rtp_parameters::RtpParameters),
) -> crate::Result<()> {
    let mut apply = || {
        let mut parameters = sender.parameters();
        update(&mut parameters);
        sender.set_parameters(parameters)
    };
    // Negotiation can invalidate the transaction between the two signaling-thread calls.
    // The pinned SDK distinguishes these conflicts only by message. Start one fresh transaction.
    match apply() {
        Err(error) if matches!(error.message.as_str(),
            "Failed to set parameters since getParameters() has never been called on this sender" |
            "Failed to set parameters since the transaction_id doesn't match the last value returned from getParameters()"
        ) => apply(),
        result => result,
    }
    .map_err(|error| error.to_string())
}

/// Keep software frame budgets stable when the shared capture worker is idle.
pub(super) fn configure_software_vfr(
    factory: &libwebrtc::peer_connection_factory::PeerConnectionFactory,
    frame_rate: u32,
) -> crate::Result<()> {
    factory
        .set_software_vfr_frame_rate(Some(frame_rate))
        .map_err(|error| error.to_string())
}

pub(super) fn configure_software_preset(
    factory: &libwebrtc::peer_connection_factory::PeerConnectionFactory,
    preset: super::preset::EncodingPreset,
) {
    factory.set_software_encoding_preset(Some(software_preset(preset)));
}

pub(super) fn software_preset(
    preset: super::preset::EncodingPreset,
) -> libwebrtc::peer_connection_factory::SoftwareEncodingPreset {
    use libwebrtc::peer_connection_factory::SoftwareEncodingPreset;
    match preset {
        super::preset::EncodingPreset::Balanced => SoftwareEncodingPreset::Balanced,
        super::preset::EncodingPreset::Quality => SoftwareEncodingPreset::Quality,
        super::preset::EncodingPreset::Latency => SoftwareEncodingPreset::Latency,
    }
}

/// The clock used by both native video and encoded audio capture timestamps.
pub(super) fn clock_us() -> i64 {
    libwebrtc::audio_source::native::NativeAudioSource::capture_clock_us()
}
