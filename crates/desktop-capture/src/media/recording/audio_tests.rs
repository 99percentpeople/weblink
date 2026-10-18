use super::*;
use std::time::Duration;

fn format(mime: &str, clock_rate: u64, channels: u32) -> NegotiatedAudioFormat {
    NegotiatedAudioFormat {
        payload_type: 111,
        mime_type: mime.into(),
        clock_rate,
        channels,
    }
}
fn frame(mime: &str) -> EncodedAudioFrame {
    EncodedAudioFrame {
        data: vec![0xf8, 0xff, 0xfe],
        payload_type: 111,
        mime_type: mime.into(),
        capture_time_us: Some(1234567),
        timestamp: u32::MAX - 160,
        ssrc: 42,
    }
}

#[test]
fn negotiated_formats_keep_rtp_identity_sample_rate_and_payload_bytes() {
    for (mime, clock, rate, codec) in [
        ("audio/opus", 48000, 48000, EncodedAudioCodec::Opus),
        ("audio/G722", 8000, 16000, EncodedAudioCodec::G722),
        ("audio/PCMU", 8000, 8000, EncodedAudioCodec::Pcmu),
        ("audio/PCMA", 8000, 8000, EncodedAudioCodec::Pcma),
    ] {
        let formats = AudioPayloadFormats::default();
        assert!(formats.configure([format(mime, clock, 1)]));
        let tap = EncodedRecordingTap::default();
        let sub = tap.subscribe().unwrap();
        tap.set_active(&sub, true, 2);
        formats.publish(&tap, frame(mime));
        let packet = sub.receive(Duration::ZERO).unwrap();
        assert_eq!(packet.bytes, [0xf8, 0xff, 0xfe]);
        assert_eq!((packet.timestamp_us, packet.segment), (1234567, 2));
        assert_eq!(
            packet.kind,
            PacketKind::EncodedAudio {
                codec,
                sample_rate: rate,
                channels: 1,
                timestamp: u32::MAX - 160,
                ssrc: 42,
            }
        );
    }
}

#[test]
fn incompatible_formats_and_missing_clocks_fail_only_active_recording() {
    for invalid in ["payload", "codec", "clock", "negative clock"] {
        let formats = AudioPayloadFormats::default();
        formats.configure([format("audio/opus", 48000, 2)]);
        let tap = EncodedRecordingTap::default();
        let sub = tap.subscribe().unwrap();
        let mut packet = frame("audio/opus");
        match invalid {
            "payload" => packet.payload_type = 112,
            "codec" => packet.mime_type = "audio/pcma".into(),
            "clock" => packet.capture_time_us = None,
            _ => packet.capture_time_us = Some(-1),
        }
        formats.publish(&tap, packet);
        assert!(sub.error().unwrap().contains("codec or capture clock"));
        assert!(sub.receive(Duration::ZERO).is_err());
        // A fresh subscription can retry; failure never ends the sender tap.
        let next = tap.subscribe().unwrap();
        tap.set_active(&next, false, 1);
        formats.publish(&tap, frame("audio/invalid"));
        assert!(next.error().is_none());
        tap.set_active(&next, true, 2);
        formats.publish(&tap, frame("audio/opus"));
        assert!(next.receive(Duration::ZERO).is_ok());
    }
}

#[test]
fn unsupported_negotiation_clears_old_payload_mappings() {
    for invalid in [
        format("audio/g722", 16000, 1),
        format("audio/pcma", 8000, 2),
        format("audio/red", 48000, 1),
    ] {
        let formats = AudioPayloadFormats::default();
        assert!(formats.configure([format("audio/opus", 48000, 2)]));
        assert!(!formats.configure([invalid]));
        let tap = EncodedRecordingTap::default();
        let sub = tap.subscribe().unwrap();
        formats.publish(&tap, frame("audio/opus"));
        assert!(sub.error().is_some());
    }
}
