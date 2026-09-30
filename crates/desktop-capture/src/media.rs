//! Independent send-only WebRTC connections for one explicitly selected source.
use serde::{Deserialize, Serialize};
pub mod latency;
pub mod pipeline;
pub mod preview;

#[cfg(any(windows, test))]
mod bitrate;

// Keep in sync with MAX_NATIVE_FRAME_RATE in @weblink/platform.
pub const MAX_FRAME_RATE: u32 = 1000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderInfo {
    pub id: String,
    pub name: String,
    pub hardware: bool,
    pub codecs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MediaOptions {
    pub audio: bool,
    pub max_width: u32,
    pub max_height: u32,
    pub frame_rate: u32,
    pub max_bitrate: u64,
    pub codec: Option<String>,
    pub encoder: String,
    pub degradation_preference: String,
}

impl Default for MediaOptions {
    fn default() -> Self {
        Self {
            audio: false,
            max_width: 1920,
            max_height: 1080,
            frame_rate: 30,
            max_bitrate: 25 * 1024 * 1024,
            codec: None,
            encoder: "auto".into(),
            degradation_preference: "balanced".into(),
        }
    }
}

impl MediaOptions {
    pub fn validate(&self) -> crate::Result<()> {
        if self.encoder != "auto"
            && self.encoder != "software"
            && !(self.encoder.starts_with("mf:") && self.encoder.len() <= 64)
        {
            return Err("Invalid native encoder".into());
        }
        if !(2..=3840).contains(&self.max_width)
            || !(2..=2160).contains(&self.max_height)
            || !(1..=MAX_FRAME_RATE).contains(&self.frame_rate)
            || !(128 * 1024..=150 * 1024 * 1024).contains(&self.max_bitrate)
            || !matches!(
                self.degradation_preference.as_str(),
                "balanced" | "maintain-framerate" | "maintain-resolution"
            )
        {
            return Err("Invalid native video settings".into());
        }
        Ok(())
    }

    pub fn dimensions(&self, width: u32, height: u32) -> (u32, u32) {
        let scale = (self.max_width as f64 / width.max(1) as f64)
            .min(self.max_height as f64 / height.max(1) as f64)
            .min(1.0);
        (
            ((width as f64 * scale) as u32 & !1).max(2),
            ((height as f64 * scale) as u32 & !1).max(2),
        )
    }
}

/// Only parameters that preserve capture, codec, audio consent and peer identity.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoSettings {
    pub max_width: u32,
    pub max_height: u32,
    pub frame_rate: u32,
    pub max_bitrate: u64,
    pub degradation_preference: String,
}
impl VideoSettings {
    pub fn apply(&self, current: &MediaOptions) -> crate::Result<MediaOptions> {
        let options = MediaOptions {
            max_width: self.max_width,
            max_height: self.max_height,
            frame_rate: self.frame_rate,
            max_bitrate: self.max_bitrate,
            degradation_preference: self.degradation_preference.clone(),
            ..current.clone()
        };
        options.validate()?;
        Ok(options)
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub credential: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IceCandidate {
    pub candidate: String,
    pub sdp_mid: Option<String>,
    pub sdp_m_line_index: Option<u16>,
}

pub type CandidateHandler = Box<dyn Fn(IceCandidate) + Send + Sync>;

/// Small diagnostic snapshots only; pixel and encoded payload data stay native.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStats {
    pub id: String,
    pub timestamp: f64,
    pub codec: String,
    pub implementation: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub frames: u32,
    pub encode_frames: u64,
    pub encode_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoder_queue_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_to_encode_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fresh_frames: Option<u64>,
    pub packets_sent: u64,
    pub send_delay_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round_trip_seconds: Option<f64>,
}

/// WebRTC's initial estimate is not the user's ceiling. A local preview can
/// start at its selected budget; remote transports still probe conservatively.
/// Do not set a minimum: congestion control and live ceiling changes must win.
#[cfg(any(windows, test))]
fn starting_bitrate_sdp(sdp: &str, limit: u64, preview: bool) -> String {
    let kbps = (if preview { limit } else { limit.min(1_000_000) } / 1000).max(1);
    let mut sections = vec![Vec::<String>::new()];
    for line in sdp.lines() {
        if line.starts_with("m=") {
            sections.push(Vec::new());
        }
        sections.last_mut().unwrap().push(line.to_string());
    }
    for lines in &mut sections {
        if !lines
            .first()
            .is_some_and(|line| line.starts_with("m=video "))
        {
            continue;
        }
        let payloads: Vec<String> = lines
            .iter()
            .filter_map(|line| {
                let (payload, encoding) = line.strip_prefix("a=rtpmap:")?.split_once(' ')?;
                matches!(
                    encoding.split('/').next()?.to_ascii_uppercase().as_str(),
                    "H264" | "H265" | "VP8" | "VP9" | "AV1"
                )
                .then(|| payload.to_string())
            })
            .collect();
        for payload in payloads {
            let prefix = format!("a=fmtp:{payload} ");
            let hint = format!("x-google-start-bitrate={kbps}");
            if let Some(line) = lines.iter_mut().find(|line| line.starts_with(&prefix)) {
                let mut parameters: Vec<_> = line[prefix.len()..]
                    .split(';')
                    .filter(|p| !p.trim().starts_with("x-google-start-bitrate="))
                    .map(str::to_string)
                    .collect();
                parameters.push(hint);
                *line = format!("{prefix}{}", parameters.join(";"));
            } else {
                lines.push(format!("{prefix}{hint}"));
            }
        }
    }
    let mut result = sections
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\r\n");
    result.push_str("\r\n");
    result
}

/// Complete a non-trickle offer without moving audio candidates into the video section.
#[cfg(any(windows, test))]
fn gathered_sdp(sdp: &str, candidates: &[IceCandidate]) -> String {
    let mut result = String::new();
    let mut section = None;
    let append = |index: Option<u16>, result: &mut String| {
        if let Some(index) = index {
            for candidate in candidates
                .iter()
                .filter(|c| c.sdp_m_line_index == Some(index))
            {
                result.push_str("a=");
                result.push_str(candidate.candidate.trim());
                result.push_str("\r\n");
            }
            result.push_str("a=end-of-candidates\r\n");
        }
    };
    for line in sdp.lines() {
        if line.starts_with("m=") {
            append(section, &mut result);
            section = Some(section.map_or(0, |index| index + 1));
        }
        result.push_str(line);
        result.push_str("\r\n");
    }
    append(section, &mut result);
    result
}

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::MediaSession;

#[cfg(not(windows))]
pub struct MediaSession;
#[cfg(not(windows))]
impl MediaSession {
    pub fn pipeline_stats(&self) -> pipeline::PipelineStats {
        Default::default()
    }
    pub async fn stats(&self, _: &str) -> crate::Result<Vec<VideoStats>> {
        Err("Native screen sharing currently requires Windows".into())
    }
    pub fn encoders() -> crate::Result<Vec<EncoderInfo>> {
        Ok(vec![])
    }
    pub fn codecs() -> Vec<String> {
        vec![]
    }
    pub fn new(_: MediaOptions) -> crate::Result<std::sync::Arc<Self>> {
        Err("Native screen sharing currently requires Windows".into())
    }
    pub fn error(&self) -> Option<String> {
        None
    }
    pub fn close(&self) {}
    pub fn set_audio_enabled(&self, _: bool) {}
    pub fn update_video_settings(&self, _: VideoSettings) -> crate::Result<()> {
        Err("Native screen sharing currently requires Windows".into())
    }
    pub fn close_peer(&self, _: &str) {}
    pub async fn offer(
        &self,
        _: String,
        _: Vec<IceServer>,
        _: bool,
        _: bool,
    ) -> crate::Result<String> {
        Err("Native screen sharing currently requires Windows".into())
    }
    pub async fn answer(&self, _: &str, _: &str) -> crate::Result<()> {
        Err("Native screen sharing currently requires Windows".into())
    }
    pub async fn offer_trickle(
        &self,
        _: String,
        _: Vec<IceServer>,
        _: bool,
        _: bool,
        _: CandidateHandler,
    ) -> crate::Result<String> {
        Err("Native screen sharing currently requires Windows".into())
    }
    pub async fn add_ice_candidate(&self, _: &str, _: IceCandidate) -> crate::Result<()> {
        Err("Native screen sharing currently requires Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bitrate_start_hints_preserve_codecs_ice_audio_and_future_limit_changes() {
        let sdp = "v=0\r\ns=contains m= in text\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 98\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 profile-level-id=42e01f;packetization-mode=1;x-google-start-bitrate=300\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=rtpmap:98 VP8/90000\r\na=ice-ufrag:keep\r\na=mid:0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\na=mid:1\r\n";
        let local = starting_bitrate_sdp(sdp, 8_000_000, true);
        assert_eq!(local.matches("x-google-start-bitrate=8000").count(), 2);
        assert!(local
            .contains("profile-level-id=42e01f;packetization-mode=1;x-google-start-bitrate=8000"));
        assert!(local.contains("a=fmtp:97 apt=96\r\n"));
        assert!(local.contains("a=ice-ufrag:keep\r\n"));
        assert!(local.starts_with("v=0\r\ns=contains m= in text\r\n"));
        assert_eq!(
            local.split_once("m=audio").unwrap().1,
            sdp.split_once("m=audio").unwrap().1
        );
        assert!(!local.contains("x-google-min-bitrate"));
        assert!(!local.contains("x-google-max-bitrate"));
        assert_eq!(
            starting_bitrate_sdp(sdp, 8_000_000, false)
                .matches("x-google-start-bitrate=1000")
                .count(),
            2
        );
        assert_eq!(
            starting_bitrate_sdp(sdp, 128_000, false)
                .matches("x-google-start-bitrate=128")
                .count(),
            2
        );
    }
    #[test]
    fn live_video_changes_preserve_session_settings_and_validate_before_commit() {
        let initial = MediaOptions {
            audio: true,
            codec: Some("video/h264".into()),
            encoder: "software".into(),
            ..Default::default()
        };
        let mut update = VideoSettings {
            max_width: 854,
            max_height: 480,
            frame_rate: 60,
            max_bitrate: 2_000_000,
            degradation_preference: "maintain-resolution".into(),
        };
        let next = update.apply(&initial).unwrap();
        assert!(next.audio);
        assert_eq!(next.codec, initial.codec);
        assert_eq!(next.encoder, initial.encoder);
        assert_eq!(next.dimensions(1920, 1080), (852, 480));
        assert_eq!(next.frame_rate, 60);
        update.frame_rate = 0;
        assert!(update.apply(&initial).is_err());
        assert_eq!(initial.frame_rate, 30);
    }
    #[test]
    fn audio_requires_consent_and_gathered_candidates_keep_their_media_section() {
        assert!(!MediaOptions::default().audio);
        let sdp = gathered_sdp("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:1\r\n", &[
            IceCandidate { candidate: "candidate:video".into(), sdp_mid: Some("0".into()), sdp_m_line_index: Some(0) },
            IceCandidate { candidate: "candidate:audio".into(), sdp_mid: Some("1".into()), sdp_m_line_index: Some(1) },
        ]);
        let (video, audio) = sdp.split_once("m=audio").unwrap();
        assert!(video.contains("a=candidate:video\r\n"));
        assert!(!video.contains("candidate:audio"));
        assert!(audio.contains("a=candidate:audio\r\n"));
        assert!(!audio.contains("candidate:video"));
        assert_eq!(sdp.matches("a=end-of-candidates").count(), 2);
    }
    #[test]
    fn bounded_configuration_and_aspect_ratio() {
        let mut options = MediaOptions::default();
        assert!(options.validate().is_ok());
        assert_eq!(options.dimensions(3840, 2160), (1920, 1080));
        assert_eq!(options.dimensions(1080, 1920), (606, 1080));
        assert_eq!(options.dimensions(581, 379), (580, 378));
        options.frame_rate = 0;
        assert!(options.validate().is_err());
        options.frame_rate = 60;
        options.max_bitrate = u64::MAX;
        assert!(options.validate().is_err());
        options.max_bitrate = 128 * 1024;
        options.degradation_preference = "unknown".into();
        assert!(options.validate().is_err());
    }

    #[test]
    fn accepts_high_refresh_capture_without_removing_the_validation_bound() {
        for frame_rate in [60, 120, 144, 154, 165, 240, MAX_FRAME_RATE] {
            assert!(MediaOptions {
                frame_rate,
                ..Default::default()
            }
            .validate()
            .is_ok());
        }
        assert!(MediaOptions {
            frame_rate: MAX_FRAME_RATE + 1,
            ..Default::default()
        }
        .validate()
        .is_err());
    }
}
