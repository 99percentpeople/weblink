//! Stable native IPC bytes, independent of the backend producing packets.
use super::{Packet, PacketKind};

// Fixed 36-byte LE header followed by payload. No JSON/base64 copies of media.
pub(super) fn encode(output: &mut Vec<u8>, packet: Packet) {
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
        PacketKind::EncodedAudio {
            codec,
            sample_rate,
            channels,
            timestamp,
            ssrc,
        } => (3, codec as u8, timestamp, ssrc, sample_rate, channels),
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
pub(super) fn terminal(output: &mut Vec<u8>, error: Option<&str>) {
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
    fn native_recording_binary_keeps_opus_payload_rtp_identity_and_capture_clock() {
        let mut data = Vec::new();
        encode(
            &mut data,
            Packet {
                bytes: vec![0xf8, 0xff, 0xfe],
                timestamp_us: 987654321,
                keyframe: true,
                segment: 2,
                kind: PacketKind::EncodedAudio {
                    codec: crate::media::recording::EncodedAudioCodec::Opus,
                    sample_rate: 48000,
                    channels: 2,
                    timestamp: u32::MAX - 960,
                    ssrc: 42,
                },
            },
        );
        assert_eq!(data.len(), 39);
        assert_eq!(
            i64::from_le_bytes(data[8..16].try_into().unwrap()),
            987654321
        );
        assert_eq!(
            u32::from_le_bytes(data[16..20].try_into().unwrap()),
            u32::MAX - 960
        );
        assert_eq!(u32::from_le_bytes(data[20..24].try_into().unwrap()), 42);
        assert_eq!(u32::from_le_bytes(data[4..8].try_into().unwrap()), 2);
        assert_eq!(&data[32..34], &[3, 1]);
        assert_eq!(&data[36..], &[0xf8, 0xff, 0xfe]);
    }
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
