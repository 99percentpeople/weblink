//! Negotiated audio payload validation shared by native recording backends.
use super::{EncodedAudioCodec, EncodedRecordingTap, Packet, PacketKind};
use std::sync::Mutex;

#[cfg(test)]
#[path = "audio_tests.rs"]
mod tests;

pub(crate) struct NegotiatedAudioFormat {
    pub payload_type: u8,
    pub mime_type: String,
    pub clock_rate: u64,
    pub channels: u32,
}

pub(crate) struct EncodedAudioFrame {
    pub data: Vec<u8>,
    pub payload_type: u8,
    pub mime_type: String,
    pub capture_time_us: Option<i64>,
    pub timestamp: u32,
    pub ssrc: u32,
}

#[derive(Default)]
pub(crate) struct AudioPayloadFormats {
    formats: Mutex<Vec<(u8, EncodedAudioCodec, u32)>>,
}
impl AudioPayloadFormats {
    pub fn configure(&self, formats: impl IntoIterator<Item = NegotiatedAudioFormat>) -> bool {
        let formats = formats
            .into_iter()
            .filter_map(|format| {
                let codec = EncodedAudioCodec::from_rtp(
                    &format.mime_type,
                    format.clock_rate,
                    format.channels,
                )?;
                Some((format.payload_type, codec, format.channels))
            })
            .collect::<Vec<_>>();
        let available = !formats.is_empty();
        *self.formats.lock().unwrap_or_else(|e| e.into_inner()) = formats;
        available
    }

    /// Called after normal transport delivery; never invokes IPC, storage or an encoder.
    pub fn publish(&self, tap: &EncodedRecordingTap, frame: EncodedAudioFrame) {
        if !tap.has_subscriber() {
            return;
        }
        let format = self
            .formats
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(payload, _, _)| *payload == frame.payload_type)
            .map(|(_, codec, channels)| (*codec, *channels));
        let Some((timestamp_us, (codec, channels))) =
            frame
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
    }
}
