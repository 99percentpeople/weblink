use crate::Result;
use libwebrtc::{
    audio_frame::AudioFrame,
    audio_source::{native::NativeAudioSource, AudioSourceOptions},
    media_stream_track::MediaStreamTrack,
    peer_connection_factory::{native::PeerConnectionFactoryExt, PeerConnectionFactory},
    video_frame::{I420Buffer, VideoFrame, VideoRotation},
    video_source::{native::NativeVideoSource, VideoResolution},
};
use std::borrow::Cow;

/// A WebView capture can feed several peers without capturing or crossing IPC per viewer.
pub enum CaptureSource {
    Video(NativeVideoSource),
    Audio(NativeAudioSource),
}
impl CaptureSource {
    pub fn video() -> Self {
        Self::Video(NativeVideoSource::new(VideoResolution::default(), false))
    }
    pub fn audio(channels: u32) -> Result<Self> {
        if !(1..=2).contains(&channels) {
            return Err("Invalid meeting microphone channel count".into());
        }
        Ok(Self::Audio(NativeAudioSource::new(
            AudioSourceOptions::default(),
            48000,
            channels,
            0,
        )))
    }
    pub(super) fn track(&self, factory: &PeerConnectionFactory, id: &str) -> MediaStreamTrack {
        match self {
            Self::Video(v) => MediaStreamTrack::Video(factory.create_video_track(id, v.clone())),
            Self::Audio(a) => MediaStreamTrack::Audio(factory.create_audio_track(id, a.clone())),
        }
    }
    pub fn yuv_frame(&self, width: u32, height: u32, data: &[u8], nv12: bool) -> Result<()> {
        let Self::Video(source) = self else {
            return Err("Not a video capture".into());
        };
        if width == 0
            || height == 0
            || width > 4096
            || height > 4096
            || u64::from(width) * u64::from(height) > 3840 * 2160
        {
            return Err("Invalid meeting camera dimensions".into());
        }
        let luma = (width * height) as usize;
        let chroma = (width.div_ceil(2) * height.div_ceil(2)) as usize;
        if data.len() != luma + 2 * chroma {
            return Err("Invalid camera plane lengths".into());
        }
        if nv12 {
            let mut pixels = libwebrtc::video_frame::NV12Buffer::new(width, height);
            let (y, uv) = pixels.data_mut();
            y.copy_from_slice(&data[..luma]);
            uv.copy_from_slice(&data[luma..]);
            source.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, pixels));
            return Ok(());
        }
        let mut pixels = I420Buffer::new(width, height);
        let (y, u, v) = pixels.data_mut();
        y.copy_from_slice(&data[..luma]);
        u.copy_from_slice(&data[luma..luma + chroma]);
        v.copy_from_slice(&data[luma + chroma..]);
        source.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, pixels));
        Ok(())
    }
    pub fn bgra_frame(&self, width: u32, height: u32, data: &[u8]) -> Result<()> {
        let Self::Video(source) = self else {
            return Err("Not a camera".into());
        };
        if width == 0
            || height == 0
            || width > 4096
            || height > 4096
            || u64::from(width) * u64::from(height) > 3840 * 2160
            || data.len() != (width * height * 4) as usize
        {
            return Err("Invalid BGRA camera frame".into());
        }
        let mut pixels = I420Buffer::new(width, height);
        libwebrtc::native::yuv_helper::argb_to_i420_with_matrix(
            data,
            width * 4,
            &mut pixels,
            libwebrtc::native::yuv_helper::YuvMatrix::Bt709Limited,
        );
        source.capture_frame(&VideoFrame::new(VideoRotation::VideoRotation0, pixels));
        Ok(())
    }

    pub fn audio_frame(&self, data: &[u8]) -> Result<()> {
        let Self::Audio(source) = self else {
            return Err("Not a microphone capture".into());
        };
        let channels = source.num_channels();
        // WebRTC expects 10 ms at a time. Allow a bounded batch from the AudioWorklet.
        let block = 480 * channels as usize * 2;
        if data.is_empty() || data.len() % block != 0 || data.len() > block * 8 {
            return Err("Invalid meeting PCM batch".into());
        }
        let blocks = data.len() / block;
        let start = NativeAudioSource::capture_clock_us() - 10_000 * (blocks as i64 - 1);
        for (i, bytes) in data.chunks_exact(block).enumerate() {
            let samples = bytes
                .chunks_exact(2)
                .map(|p| i16::from_le_bytes([p[0], p[1]]))
                .collect();
            source
                .capture_frame_at(
                    &AudioFrame {
                        data: Cow::Owned(samples),
                        sample_rate: 48000,
                        num_channels: channels,
                        samples_per_channel: 480,
                    },
                    start + i as i64 * 10_000,
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
