//! Observe the selected sender's supported audio payloads. Only bounded copies cross into
//! recording; the sender is forwarded before this callback and is never awaited.
use crate::media::recording::{EncodedAudioCodec, EncodedRecordingTap, Packet, PacketKind};
use libwebrtc::{native::encoded_audio::EncodedAudioObserver, rtp_sender::RtpSender};
use std::sync::{Arc, Mutex};

pub(super) struct SenderAudioRecording {
    pub tap: Arc<EncodedRecordingTap>,
    observer: EncodedAudioObserver,
    sender: RtpSender,
    formats: Arc<Mutex<Vec<(u8, EncodedAudioCodec, u32)>>>,
}
impl SenderAudioRecording {
    pub fn new(sender: RtpSender) -> Option<Arc<Self>> {
        let tap = Arc::new(EncodedRecordingTap::default());
        let weak = Arc::downgrade(&tap);
        let formats = Arc::new(Mutex::new(Vec::<(u8, EncodedAudioCodec, u32)>::new()));
        let selected = formats.clone();
        let observer = EncodedAudioObserver::new(
            &sender,
            Arc::new(move |frame| {
                let Some(tap) = weak.upgrade().filter(|tap| tap.has_subscriber()) else {
                    return;
                };
                let format = selected
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .iter()
                    .find(|(payload, _, _)| *payload == frame.payload_type)
                    .map(|(_, codec, channels)| (*codec, *channels));
                let Some((timestamp_us, (codec, channels))) = frame
                    .capture_time_us
                    .zip(format)
                    .filter(|(time, (codec, _))| {
                        *time >= 0 && frame.mime_type.eq_ignore_ascii_case(codec.mime_type())
                    })
                else {
                    tap.fail("Sender audio codec or capture clock is unavailable");
                    return;
                };
                tap.publish(Packet {
                    bytes: frame.data,
                    timestamp_us,
                    keyframe: true,
                    kind: PacketKind::EncodedAudio {
                        codec,
                        sample_rate: codec.sample_rate(),
                        channels,
                        timestamp: frame.timestamp,
                        ssrc: frame.ssrc,
                    },
                    segment: 0,
                });
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
    pub fn available(&self) -> bool {
        let formats = self
            .sender
            .parameters()
            .codecs
            .into_iter()
            .filter_map(|codec| {
                let channels = u32::from(codec.channels.unwrap_or(1));
                let format =
                    EncodedAudioCodec::from_rtp(&codec.mime_type, codec.clock_rate?, channels)?;
                Some((codec.payload_type, format, channels))
            })
            .collect::<Vec<_>>();
        let available = !formats.is_empty();
        *self.formats.lock().unwrap_or_else(|e| e.into_inner()) = formats;
        available
    }
    pub fn set_active(&self, active: bool) {
        self.observer.set_enabled(active);
    }
    pub fn close(&self) {
        self.observer.close();
        self.tap.end();
    }
}
