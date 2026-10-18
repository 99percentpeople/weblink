use super::audio::{AudioPayloadFormats, EncodedAudioFrame, NegotiatedAudioFormat};
use super::*;
use crate::media::AudioCaptureFormat;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

pub struct Video {
    pub tap: Arc<EncodedRecordingTap>,
    pub connected: AtomicBool,
    pub keyframes: AtomicUsize,
    pub forwarded: AtomicUsize,
}
impl Video {
    pub fn publish(&self, stamp: i64, keyframe: bool, size: usize) {
        self.forwarded.fetch_add(1, Ordering::SeqCst);
        self.tap.publish(Packet {
            bytes: vec![42; size],
            timestamp_us: stamp,
            keyframe,
            kind: PacketKind::Video {
                codec: 1,
                width: 1280,
                height: 720,
            },
            segment: 0,
        });
    }
}
impl VideoSource for Video {
    fn tap(&self) -> Arc<EncodedRecordingTap> {
        self.tap.clone()
    }
    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }
    fn request_keyframe(&self) {
        self.keyframes.fetch_add(1, Ordering::SeqCst);
    }
}

pub struct Audio {
    pub tap: Arc<EncodedRecordingTap>,
    pub active: AtomicBool,
    pub supported: AtomicBool,
    pub probes: AtomicUsize,
    pub forwarded: AtomicUsize,
    pub codec: EncodedAudioCodec,
    formats: AudioPayloadFormats,
}
impl Audio {
    pub fn publish(&self, clock: Option<i64>) {
        self.forwarded.fetch_add(1, Ordering::SeqCst);
        if self.active.load(Ordering::SeqCst) {
            self.formats.publish(
                &self.tap,
                EncodedAudioFrame {
                    data: vec![1, 2, 3],
                    payload_type: 111,
                    mime_type: self.codec.mime_type().into(),
                    capture_time_us: clock,
                    timestamp: 960,
                    ssrc: 7,
                },
            );
        }
    }
}
impl EncodedAudioSource for Audio {
    fn tap(&self) -> Arc<EncodedRecordingTap> {
        self.tap.clone()
    }
    fn available(&self) -> bool {
        self.probes.fetch_add(1, Ordering::SeqCst);
        self.supported.load(Ordering::SeqCst)
    }
    fn set_active(&self, active: bool) {
        self.active.store(active, Ordering::SeqCst);
    }
}

pub struct Fixture {
    pub video: Arc<Video>,
    pub encoded: Arc<Audio>,
    pub pcm: Arc<EncodedRecordingTap>,
}
impl Fixture {
    pub fn new(codec: EncodedAudioCodec) -> Self {
        let formats = AudioPayloadFormats::default();
        assert!(formats.configure([NegotiatedAudioFormat {
            payload_type: 111,
            mime_type: codec.mime_type().into(),
            clock_rate: if codec == EncodedAudioCodec::Opus {
                48000
            } else {
                8000
            },
            channels: 1,
        }]));
        Self {
            video: Arc::new(Video {
                tap: Arc::new(EncodedRecordingTap::default()),
                connected: AtomicBool::new(true),
                keyframes: AtomicUsize::new(0),
                forwarded: AtomicUsize::new(0),
            }),
            encoded: Arc::new(Audio {
                tap: Arc::new(EncodedRecordingTap::default()),
                active: AtomicBool::new(false),
                supported: AtomicBool::new(true),
                probes: AtomicUsize::new(0),
                forwarded: AtomicUsize::new(0),
                codec,
                formats,
            }),
            pcm: Arc::new(EncodedRecordingTap::default()),
        }
    }
    pub fn inputs(&self, audio: bool) -> RecordingInputs {
        RecordingInputs {
            video: self.video.clone(),
            audio: audio.then(|| RecordingAudioInputs {
                pcm: PcmAudioSource {
                    tap: self.pcm.clone(),
                    format: AudioCaptureFormat {
                        sample_rate: 48000,
                        channel_count: 2,
                    },
                },
                encoded: Some(self.encoded.clone()),
            }),
        }
    }
    pub fn pcm_packet(&self, stamp: i64) {
        self.pcm.publish(Packet {
            bytes: vec![1, 2, 3, 4],
            timestamp_us: stamp,
            keyframe: true,
            kind: PacketKind::Audio {
                sample_rate: 48000,
                channels: 2,
            },
            segment: 0,
        });
    }
}

#[derive(Debug)]
pub struct WirePacket {
    pub kind: u8,
    pub codec: u8,
    pub segment: u32,
    pub clock: i64,
    pub payload: Vec<u8>,
}
pub fn packets(bytes: &[u8]) -> Vec<WirePacket> {
    let mut at = 0;
    let mut result = Vec::new();
    while at < bytes.len() {
        let header = &bytes[at..at + 36];
        let size = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
        result.push(WirePacket {
            kind: header[32],
            codec: header[33],
            segment: u32::from_le_bytes(header[4..8].try_into().unwrap()),
            clock: i64::from_le_bytes(header[8..16].try_into().unwrap()),
            payload: bytes[at + 36..at + 36 + size].to_vec(),
        });
        at += 36 + size;
    }
    result
}
