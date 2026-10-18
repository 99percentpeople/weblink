//! WebRTC observer adapter. The sender forwards audio before this callback; the
//! portable core validates and queues recording payloads without storage or IPC.
use crate::media::recording::audio::{
    AudioPayloadFormats, EncodedAudioFrame, NegotiatedAudioFormat,
};
use crate::media::recording::{EncodedAudioSource, EncodedRecordingTap};
use libwebrtc::{native::encoded_audio::EncodedAudioObserver, rtp_sender::RtpSender};
use std::sync::Arc;

pub(crate) struct SenderAudioRecording {
    pub tap: Arc<EncodedRecordingTap>,
    observer: EncodedAudioObserver,
    sender: RtpSender,
    formats: Arc<AudioPayloadFormats>,
}
impl SenderAudioRecording {
    pub fn new(sender: RtpSender) -> Option<Arc<Self>> {
        let tap = Arc::new(EncodedRecordingTap::default());
        let weak = Arc::downgrade(&tap);
        let formats = Arc::new(AudioPayloadFormats::default());
        let selected = formats.clone();
        let observer = EncodedAudioObserver::new(
            &sender,
            Arc::new(move |frame| {
                let Some(tap) = weak.upgrade() else {
                    return;
                };
                selected.publish(
                    &tap,
                    EncodedAudioFrame {
                        data: frame.data,
                        payload_type: frame.payload_type,
                        mime_type: frame.mime_type,
                        capture_time_us: frame.capture_time_us,
                        timestamp: frame.timestamp,
                        ssrc: frame.ssrc,
                    },
                );
            }),
        )
        .ok()?;
        Some(Arc::new(Self {
            tap,
            observer,
            sender,
            formats,
        }))
    }
    pub fn close(&self) {
        self.observer.close();
        self.tap.end();
    }
}
impl EncodedAudioSource for SenderAudioRecording {
    fn tap(&self) -> Arc<EncodedRecordingTap> {
        self.tap.clone()
    }
    fn available(&self) -> bool {
        self.formats.configure(
            self.sender
                .parameters()
                .codecs
                .into_iter()
                .filter_map(|codec| {
                    Some(NegotiatedAudioFormat {
                        payload_type: codec.payload_type,
                        mime_type: codec.mime_type,
                        clock_rate: codec.clock_rate?,
                        channels: u32::from(codec.channels.unwrap_or(1)),
                    })
                }),
        )
    }
    fn set_active(&self, active: bool) {
        self.observer.set_enabled(active);
    }
}
