use super::{CandidateHandler, EncoderInfo, IceCandidate, IceServer, MediaOptions, VideoSettings};
mod audio;
mod capture;
mod compose;
mod control;
mod ice;
mod mf;
mod pixels;
mod presentation;
use pixels::from_bgra;
pub use presentation::PreviewSubscription;
mod statistics;
#[cfg(test)]
mod tests;
use crate::surface::readback::Readback;
use crate::surface::{FrameSink, TextureFrame};
use crate::Result;
use libwebrtc::{
    media_stream_track::MediaStreamTrack,
    peer_connection::{IceGatheringState, OfferOptions, PeerConnection},
    peer_connection_factory::{
        native::PeerConnectionFactoryExt, ContinualGatheringPolicy, IceTransportsType,
        PeerConnectionFactory, RtcConfiguration,
    },
    prelude::VideoBuffer,
    rtp_parameters::{DegradationPreference, RtpEncodingParameters},
    rtp_sender::VideoEncoderBackend,
    rtp_transceiver::{RtpTransceiverDirection, RtpTransceiverInit},
    session_description::{SdpType, SessionDescription},
    video_frame::VideoFrame,
    video_source::{native::NativeVideoSource, VideoResolution},
    MediaType,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const AUDIO_BITRATE_BPS: u64 = 128_000;

// Capture is single-source; every peer has its own congestion-controlled encoder/transport.
// Production preview reads raw frames; legacy/test receivers still use independent peers.
pub struct MediaSession {
    factory: PeerConnectionFactory,
    source: NativeVideoSource,
    // WebRTC feeds sink adaptation back into its source. Preview adaptation
    // must not reduce the remote senders' frame rate or resolution.
    preview_source: NativeVideoSource,
    audio: Option<audio::Loopback>,
    peers: Mutex<HashMap<String, MediaPeer>>,
    hardware: Mutex<HashMap<String, Arc<mf::Encoder>>>,
    encoder_id: Option<String>,
    latest: Mutex<Option<Arc<VideoFrame<libwebrtc::video_frame::I420Buffer>>>>,
    latest_sequence: AtomicU64,
    previews: Mutex<presentation::Watches>,
    last_sent: Mutex<Instant>,
    readback: Mutex<Readback>,
    // Worker-owned bounded readbacks; capture only touches the retained source.
    conversion: Mutex<capture::Conversion>,
    readback_buffers: usize,
    options: Mutex<MediaOptions>,
    notify: Arc<tokio::sync::Notify>,
    error: Mutex<Option<String>>,
    changed: Arc<crate::lifecycle::Subscription>,
    closed: AtomicBool,
    cursor_visible: AtomicBool,
    started: Instant,
    pipeline: Mutex<super::pipeline::Timings>,
    peer_errors: Mutex<std::collections::VecDeque<String>>,
}

struct MediaPeer {
    connection: PeerConnection,
    gathering: Arc<ice::Gathering>,
    preview: bool,
    control: Option<control::Connection>,
}
impl MediaPeer {
    fn close(&self) {
        // Wake pending offers before detaching callbacks or closing native state.
        self.gathering.close();
        if let Some(control) = &self.control {
            control.close();
        }
        self.connection.on_ice_gathering_state_change(None);
        self.connection.on_ice_candidate(None);
        self.connection.close();
    }
}

impl MediaSession {
    pub fn set_cursor_visible(&self, visible: bool) {
        if self.cursor_visible.swap(visible, Ordering::AcqRel) != visible {
            let mut readback = self.readback.lock().unwrap_or_else(|e| e.into_inner());
            // Recompose even a stationary desktop, preserving its cursor metadata.
            if readback.cursor.is_some() {
                readback.dirty = true;
                self.notify.notify_one();
            }
        }
    }
    pub fn encoders() -> Result<Vec<EncoderInfo>> {
        let mut encoders = vec![EncoderInfo {
            id: "software".into(),
            name: "Software".into(),
            hardware: false,
            codecs: Self::software_codecs(),
        }];
        encoders.extend(mf::detect().unwrap_or_default());
        Ok(encoders)
    }
    pub fn codecs() -> Vec<String> {
        let mut codecs = Self::software_codecs();
        codecs.extend(
            mf::detect()
                .unwrap_or_default()
                .into_iter()
                .flat_map(|e| e.codecs),
        );
        codecs.sort();
        codecs.dedup();
        codecs
    }
    fn software_codecs() -> Vec<String> {
        let mut codecs: Vec<_> = PeerConnectionFactory::default()
            .get_rtp_sender_capabilities(MediaType::Video)
            .codecs
            .into_iter()
            .map(|c| c.mime_type.to_lowercase())
            .filter(|c| {
                matches!(
                    c.as_str(),
                    "video/vp8" | "video/vp9" | "video/h264" | "video/av1" | "video/h265"
                )
            })
            .collect();
        codecs.sort();
        codecs.dedup();
        codecs
    }

    pub fn audio_formats() -> Result<Vec<super::AudioCaptureFormat>> {
        audio::supported_formats()
    }

    pub fn audio_codecs() -> Vec<String> {
        let mut codecs: Vec<_> = PeerConnectionFactory::default()
            .get_rtp_sender_capabilities(MediaType::Audio)
            .codecs
            .into_iter()
            .map(|codec| codec.mime_type.to_lowercase())
            .filter(|codec| {
                !matches!(
                    codec.as_str(),
                    "audio/red" | "audio/cn" | "audio/telephone-event"
                )
            })
            .collect();
        codecs.sort();
        codecs.dedup();
        codecs
    }

    pub fn new(mut options: MediaOptions) -> Result<Arc<Self>> {
        options.validate()?;
        let hardware = if options.encoder == "software" {
            None
        } else {
            let encoders = if options.encoder == "auto" {
                mf::detect().unwrap_or_default()
            } else {
                mf::detect()?
            };
            select_hardware_encoder(&options, encoders)?
        };
        if let Some(encoder) = &hardware {
            options
                .codec
                .get_or_insert_with(|| encoder.codecs[0].clone());
        } else if options
            .codec
            .as_ref()
            .is_some_and(|codec| !Self::software_codecs().contains(codec))
        {
            return Err("Selected native video codec is unavailable".into());
        }
        let encoder_id = hardware.map(|encoder| encoder.id);
        let send_options = libwebrtc::peer_connection_factory::VideoSendOptions {
            min_playout_delay_ms: 0,
            max_playout_delay_ms: Some(0),
            pacing_factor: Some(1.5),
            software_h264_external_frame_dropper: true,
        };
        let factory = PeerConnectionFactory::with_screen_video_send_options(
            send_options,
            encoder_id.is_some() && options.codec.as_deref() == Some("video/h265"),
        )
        .map_err(|e| e.to_string())?;
        // Bundled OpenH264's screen-content preset can overshoot the short-term
        // budget on scene cuts. Its real-time preset responds to rate control;
        // resolution/degradation and screen identity are still set explicitly.
        let screencast = options.codec.as_deref() != Some("video/h264");
        let source = NativeVideoSource::new(VideoResolution::default(), screencast);
        let preview_source = NativeVideoSource::new(VideoResolution::default(), screencast);
        let color = options.color_space().rtc();
        if !source.set_color_space(Some(color)) || !preview_source.set_color_space(Some(color)) {
            return Err("Invalid native video color space".into());
        }
        let changed = Arc::new(crate::lifecycle::Subscription::default());
        let session = Arc::new(Self {
            // 0..0 asks the receiver to decode and present complete frames
            // immediately, without a second presentation queue. In Chromium,
            // 0..positive selects a renderer that assumes 60 FPS; a positive
            // minimum instead adds timestamp-based scheduling and late drops.
            factory,
            source,
            preview_source,
            audio: options
                .audio
                .then(|| {
                    audio::Loopback::start(
                        options.audio_sample_rate,
                        options.audio_channel_count,
                        changed.clone(),
                    )
                })
                .transpose()?,
            peers: Mutex::new(HashMap::new()),
            hardware: Mutex::new(HashMap::new()),
            encoder_id,
            latest: Mutex::new(None),
            latest_sequence: AtomicU64::new(0),
            previews: Mutex::new(Default::default()),
            last_sent: Mutex::new(Instant::now()),
            readback: Mutex::new(Readback::default()),
            conversion: Mutex::new(Default::default()),
            readback_buffers: options.readback_buffers as usize,
            options: Mutex::new(options),
            notify: Arc::new(tokio::sync::Notify::new()),
            error: Mutex::new(None),
            changed,
            closed: AtomicBool::new(false),
            cursor_visible: AtomicBool::new(true),
            started: Instant::now(),
            pipeline: Mutex::new(Default::default()),
            peer_errors: Mutex::new(Default::default()),
        });
        Self::start_capture_worker(&session);
        Ok(session)
    }

    fn frame_interval(&self) -> Duration {
        let options = self.options.lock().unwrap_or_else(|e| e.into_inner());
        Duration::from_secs_f64(1.0 / options.frame_rate as f64)
    }

    pub fn update_video_settings(&self, settings: VideoSettings) -> Result<()> {
        // Serialize peer registration and settings writes, including rollback.
        let mut current = self.options.lock().unwrap_or_else(|e| e.into_inner());
        if self.closed.load(Ordering::Acquire) {
            return Err("Native screen is no longer active".into());
        }
        let next = settings.apply(&current)?;
        let peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        for peer in peers.values() {
            if let Err(error) = Self::configure_peer(peer, &next) {
                // Preserve the last accepted settings if any sender rejects the update.
                for peer in peers.values() {
                    let _ = Self::configure_peer(peer, &current);
                }
                return Err(error);
            }
        }
        for encoder in self
            .hardware
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            encoder.update_options(next.clone());
        }
        let resize = (current.max_width, current.max_height) != (next.max_width, next.max_height);
        *current = next;
        drop(peers);
        drop(current);
        if resize {
            // Reconvert the retained original surface, including while the screen
            // is static. Scaling the old output would lose detail on an increase.
            let mut readback = self.readback.lock().unwrap_or_else(|e| e.into_inner());
            if readback.size.0 > 0 && readback.size.1 > 0 {
                readback.dirty = true;
            }
        }
        self.notify.notify_one();
        Ok(())
    }

    fn configure_peer(peer: &MediaPeer, options: &MediaOptions) -> Result<()> {
        for sender in peer.connection.senders() {
            if !matches!(sender.track(), Some(MediaStreamTrack::Video(_))) {
                continue;
            }
            let mut parameters = sender.parameters();
            for encoding in &mut parameters.encodings {
                encoding.max_bitrate = Some(options.max_bitrate);
                encoding.max_framerate = Some(options.frame_rate as f64);
            }
            parameters
                .set_degradation_preference(Self::degradation_preference(options, peer.preview));
            sender
                .set_parameters(parameters)
                .map_err(|e| e.to_string())?;
        }
        Self::configure_transport_bitrate(&peer.connection, options)
    }

    fn configure_transport_bitrate(
        connection: &PeerConnection,
        options: &MediaOptions,
    ) -> Result<()> {
        let has_audio = connection
            .senders()
            .iter()
            .any(|sender| matches!(sender.track(), Some(MediaStreamTrack::Audio(_))));
        // RTP encoding limits alone do not set the transport's probe ceiling.
        // Budget the audio sender too, without imposing a minimum or start rate.
        let maximum = options.max_bitrate + if has_audio { AUDIO_BITRATE_BPS } else { 0 };
        connection
            .set_max_bitrate(u32::try_from(maximum).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    }

    fn degradation_preference(options: &MediaOptions, preview: bool) -> DegradationPreference {
        // Compatibility preview peers preserve detail independently of remote peers.
        if preview {
            return DegradationPreference::MaintainResolution;
        }
        match options.degradation_preference.as_str() {
            "maintain-framerate" => DegradationPreference::MaintainFramerate,
            "maintain-resolution" => DegradationPreference::MaintainResolution,
            _ => DegradationPreference::Balanced,
        }
    }

    pub fn error(&self) -> Option<String> {
        self.error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .or_else(|| self.audio.as_ref().and_then(audio::Loopback::error))
    }

    fn fail(&self, error: String) {
        *self.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
        self.changed.notify();
    }

    pub(crate) fn set_changed(&self, changed: crate::lifecycle::Changed) {
        self.changed.set(changed);
        // An audio/conversion failure may have happened before the owner attached.
        if self.error().is_some() {
            self.changed.notify();
        }
    }

    fn reap_failed_encoders(&self) {
        let failed: Vec<_> = self
            .hardware
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter_map(|(id, encoder)| encoder.error().map(|error| (id.clone(), error)))
            .collect();
        for (id, error) in failed {
            // One receiver's transform is not the capture's lifetime. Closing its
            // transport activates that receiver's bounded reconnection path.
            self.close_peer(&id);
            let mut errors = self.peer_errors.lock().unwrap_or_else(|e| e.into_inner());
            if errors.len() >= 16 {
                errors.pop_front();
            }
            errors.push_back(error);
        }
    }

    pub fn pipeline_stats(&self) -> super::pipeline::PipelineStats {
        let mut report = self
            .pipeline
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot();
        report.peers = self.peers.lock().unwrap_or_else(|e| e.into_inner()).len();
        report.hardware_encoders = self
            .hardware
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len();
        report.encoders = self
            .hardware
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(peer, encoder)| encoder.statistics().snapshot(peer.clone()))
            .collect();
        report.peer_errors = self
            .peer_errors
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect();
        report
    }

    /// Called only by the local presenter after it has consumed the previous frame.
    /// No encoder, peer connection or unbounded frame queue is created for preview.
    pub fn copy_preview_frame(
        &self,
        after: u64,
        target: &mut [u8],
    ) -> Result<Option<super::preview::PreviewFrame>> {
        if self.closed.load(Ordering::Acquire) {
            return Err("Native screen is no longer active".into());
        }
        let latest = self.latest.lock().unwrap_or_else(|e| e.into_inner());
        let sequence = self.latest_sequence.load(Ordering::Relaxed);
        let Some(frame) = latest.as_ref().filter(|_| sequence != after).cloned() else {
            return Ok(None);
        };
        drop(latest);
        let buffer = &frame.buffer;
        let options = self
            .options
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let (y, u, v) = buffer.data();
        let (sy, su, sv) = buffer.strides();
        super::preview::pack_i420(
            target,
            buffer.width() as usize,
            buffer.height() as usize,
            [(y, sy as usize), (u, su as usize), (v, sv as usize)],
        )?;
        Ok(Some(super::preview::PreviewFrame {
            sequence,
            width: buffer.width(),
            height: buffer.height(),
            timestamp: self.started.elapsed().as_secs_f64() * 1000.0,
            color_space: options.color_space(),
        }))
    }

    #[cfg(test)]
    fn publish_frame(&self, frame: &VideoFrame<libwebrtc::video_frame::I420Buffer>) {
        self.publish_frame_at(frame, Some(Instant::now()));
    }

    fn publish_frame_at<T: AsRef<dyn VideoBuffer>>(
        &self,
        frame: &VideoFrame<T>,
        captured_at: Option<Instant>,
    ) {
        // Both adapters borrow the same converted pixels; capture/readback and
        // BGRA conversion still happen only once per frame.
        self.source.capture_frame(frame);
        self.preview_source.capture_frame(frame);
        let hardware = self.hardware.lock().unwrap_or_else(|e| e.into_inner());
        if !hardware.is_empty() {
            let Some(buffer) = frame.buffer.as_ref().as_i420() else {
                return;
            };
            let frame = Arc::new(mf::Frame::from_i420(buffer, captured_at));
            for encoder in hardware.values() {
                encoder.submit(frame.clone());
            }
        }
    }

    pub async fn offer(
        &self,
        id: String,
        servers: Vec<IceServer>,
        relay: bool,
        preview: bool,
    ) -> Result<String> {
        self.create_offer(id, servers, relay, preview, None, None)
            .await
    }

    pub async fn offer_trickle(
        &self,
        id: String,
        servers: Vec<IceServer>,
        relay: bool,
        preview: bool,
        candidates: CandidateHandler,
    ) -> Result<String> {
        self.create_offer(id, servers, relay, preview, Some(candidates), None)
            .await
    }

    pub async fn offer_control(
        &self,
        id: String,
        servers: Vec<IceServer>,
        relay: bool,
        candidates: Option<CandidateHandler>,
        port: Arc<dyn super::control::Port>,
    ) -> Result<String> {
        let result = self
            .create_offer(id, servers, relay, false, candidates, Some(port.clone()))
            .await;
        if result.is_err() {
            port.closed();
        }
        result
    }
    async fn create_offer(
        &self,
        id: String,
        servers: Vec<IceServer>,
        relay: bool,
        preview: bool,
        on_candidate: Option<CandidateHandler>,
        control_port: Option<Arc<dyn super::control::Port>>,
    ) -> Result<String> {
        if id.is_empty() || id.len() > 128 {
            return Err("Invalid media peer identifier".into());
        }
        let mut config = RtcConfiguration::default();
        config.continual_gathering_policy = ContinualGatheringPolicy::GatherOnce;
        config.ice_transport_type = if relay {
            IceTransportsType::Relay
        } else {
            IceTransportsType::All
        };
        config.ice_servers = servers
            .into_iter()
            .map(|s| libwebrtc::peer_connection_factory::IceServer {
                urls: s.urls,
                username: s.username,
                password: s.credential,
            })
            .collect();
        let pc = self
            .factory
            .create_peer_connection(config)
            .map_err(|e| e.to_string())?;
        let control = control_port
            .map(|port| control::Channels::connect(&pc, port))
            .transpose()
            .inspect_err(|_| {
                pc.close();
            })?;
        let gathering = Arc::new(ice::Gathering::new());
        let completed = gathering.clone();
        pc.on_ice_gathering_state_change(Some(Box::new(move |state| {
            if state == IceGatheringState::Complete {
                completed.complete();
            }
        })));
        let candidates = Arc::new(Mutex::new(Vec::new()));
        let gathered = candidates.clone();
        let trickle = on_candidate.is_some();
        // Install both observers before exposing the peer to close_peer.
        pc.on_ice_candidate(Some(Box::new(move |candidate| {
            let candidate = IceCandidate {
                candidate: candidate.to_string(),
                sdp_mid: Some(candidate.sdp_mid()),
                sdp_m_line_index: u16::try_from(candidate.sdp_mline_index()).ok(),
            };
            let mut list = gathered.lock().unwrap_or_else(|e| e.into_inner());
            if list.len() < 256 {
                list.push(candidate.clone());
                drop(list);
                if let Some(handler) = &on_candidate {
                    handler(candidate);
                }
            }
        })));
        {
            let options = self.options.lock().unwrap_or_else(|e| e.into_inner());
            // Preview keeps its own congestion feedback and encoder, at the selected
            // resolution. Use the selected hardware encoder locally too; forcing a
            // software preview can trigger CPU adaptation to tiny frame dimensions.
            let hardware = self
                .encoder_id
                .as_ref()
                .map(|id| mf::Encoder::new(id.clone(), options.clone(), preview).map(Arc::new))
                .transpose()?;
            let source = if let Some(encoder) = &hardware {
                &encoder.source
            } else if preview {
                &self.preview_source
            } else {
                &self.source
            };
            let track = self
                .factory
                .create_video_track(&format!("screen-{id}"), source.clone());
            let transceiver = pc
                .add_transceiver(
                    MediaStreamTrack::Video(track),
                    RtpTransceiverInit {
                        direction: RtpTransceiverDirection::SendOnly,
                        stream_ids: vec![id.clone()],
                        send_encodings: vec![RtpEncodingParameters {
                            max_bitrate: Some(options.max_bitrate),
                            max_framerate: Some(options.frame_rate as f64),
                            ..Default::default()
                        }],
                    },
                )
                .map_err(|e| {
                    pc.close();
                    e.to_string()
                })?;
            let configured = (|| {
                if let Some(audio) = &self.audio {
                    let track = self
                        .factory
                        .create_audio_track(&format!("screen-audio-{id}"), audio.source.clone());
                    let audio_transceiver = pc
                        .add_transceiver(
                            MediaStreamTrack::Audio(track),
                            RtpTransceiverInit {
                                direction: RtpTransceiverDirection::SendOnly,
                                stream_ids: vec![id.clone()],
                                send_encodings: vec![RtpEncodingParameters {
                                    max_bitrate: Some(AUDIO_BITRATE_BPS),
                                    ..Default::default()
                                }],
                            },
                        )
                        .map_err(|e| e.to_string())?;
                    if let Some(codec) = &options.audio_codec {
                        let mut codecs = self
                            .factory
                            .get_rtp_sender_capabilities(MediaType::Audio)
                            .codecs;
                        // Stable preference ordering keeps all negotiated fallbacks available.
                        codecs.sort_by_key(|candidate| {
                            !candidate.mime_type.eq_ignore_ascii_case(codec)
                        });
                        audio_transceiver
                            .set_codec_preferences(codecs)
                            .map_err(|e| e.to_string())?;
                    }
                }
                {
                    let codecs: Vec<_> = self
                        .factory
                        .get_rtp_sender_capabilities(MediaType::Video)
                        .codecs
                        .into_iter()
                        .filter(|c| {
                            (options
                                .codec
                                .as_ref()
                                .is_none_or(|codec| c.mime_type.eq_ignore_ascii_case(codec))
                                && (options.vp8_color_compatible()
                                    || !c.mime_type.eq_ignore_ascii_case("video/vp8"))
                                && (hardware.is_none()
                                    || options.codec.as_deref() != Some("video/h264")
                                    || c.sdp_fmtp_line
                                        .as_deref()
                                        .is_some_and(|line| line.contains("profile-level-id=42"))))
                                || matches!(
                                    c.mime_type.to_lowercase().as_str(),
                                    "video/rtx" | "video/red" | "video/ulpfec"
                                )
                        })
                        .collect();
                    transceiver
                        .set_codec_preferences(codecs)
                        .map_err(|e| e.to_string())?;
                }
                let sender = transceiver.sender();
                sender.set_video_encoder_backend(if hardware.is_some() {
                    VideoEncoderBackend::PreEncoded
                } else {
                    VideoEncoderBackend::Software
                });
                let mut parameters = sender.parameters();
                parameters
                    .set_degradation_preference(Self::degradation_preference(&options, preview));
                sender
                    .set_parameters(parameters)
                    .map_err(|e| e.to_string())?;
                Self::configure_transport_bitrate(&pc, &options)
            })();
            if let Err(error) = configured {
                pc.close();
                return Err(error);
            }
            {
                let mut peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
                if self.closed.load(Ordering::Acquire)
                    || peers.len() >= 32
                    || peers.contains_key(&id)
                {
                    pc.close();
                    return Err(
                        "Capture stopped, media peer already exists or peer limit reached".into(),
                    );
                }
                peers.insert(
                    id.clone(),
                    MediaPeer {
                        connection: pc.clone(),
                        gathering: gathering.clone(),
                        preview,
                        control,
                    },
                );
                if let Some(encoder) = hardware {
                    self.hardware
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .insert(id.clone(), encoder);
                }
            }
        }
        self.notify.notify_one();
        let result = async {
            let offer = pc
                .create_offer(OfferOptions::default())
                .await
                .map_err(|e| e.to_string())?;
            let sdp = offer.to_string();
            pc.set_local_description(offer)
                .await
                .map_err(|e| e.to_string())?;
            // STUN/TURN can be slow or unreachable. Publish SDP immediately so
            // host candidates can connect while other routes are still gathered.
            if trickle {
                return Ok(sdp);
            }
            tokio::time::timeout(Duration::from_secs(15), gathering.wait())
                .await
                .map_err(|_| "Native ICE gathering timed out".to_string())??;
            // current_local_description is null while an offer is pending.
            Ok(super::gathered_sdp(
                &sdp,
                &candidates.lock().unwrap_or_else(|e| e.into_inner()),
            ))
        }
        .await;
        if result.is_err() {
            self.close_peer(&id);
        }
        result
    }

    pub async fn answer(&self, id: &str, sdp: &str) -> Result<()> {
        if sdp.len() > 65536 {
            return Err("Media SDP too large".into());
        }
        let (connection, preview) = self
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|peer| (peer.connection.clone(), peer.preview))
            .ok_or("Media peer is no longer active")?;
        let options = self
            .options
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let sdp = super::starting_bitrate_sdp(sdp, options.max_bitrate, preview);
        let description =
            SessionDescription::parse(&sdp, SdpType::Answer).map_err(|e| e.to_string())?;
        connection
            .set_remote_description(description)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn add_ice_candidate(&self, id: &str, candidate: IceCandidate) -> Result<()> {
        if candidate.candidate.len() > 4096
            || candidate
                .sdp_mid
                .as_ref()
                .is_some_and(|mid| mid.len() > 128)
            || (candidate.sdp_mid.is_none() && candidate.sdp_m_line_index.is_none())
        {
            return Err("Invalid native ICE candidate".into());
        }
        let pc = self
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|peer| peer.connection.clone())
            .ok_or("Media peer is no longer active")?;
        let ice = libwebrtc::ice_candidate::IceCandidate::parse(
            candidate.sdp_mid.as_deref().unwrap_or(""),
            candidate.sdp_m_line_index.map(i32::from).unwrap_or(0),
            &candidate.candidate,
        )
        .map_err(|e| e.to_string())?;
        pc.add_ice_candidate(ice).await.map_err(|e| e.to_string())
    }

    pub fn set_audio_enabled(&self, enabled: bool) {
        if let Some(audio) = &self.audio {
            audio.set_enabled(enabled);
        }
    }

    pub fn close_peer(&self, id: &str) {
        let pc = self
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        if let Some(peer) = pc {
            peer.close();
        }
        let encoder = self
            .hardware
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        if let Some(encoder) = encoder {
            encoder.close();
        }
        self.notify.notify_one();
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.end_previews();
        if let Some(audio) = &self.audio {
            audio.close();
        }
        self.notify.notify_one();
        let peers = std::mem::take(&mut *self.peers.lock().unwrap_or_else(|e| e.into_inner()));
        for (_, peer) in peers {
            peer.close();
        }
        let encoders =
            std::mem::take(&mut *self.hardware.lock().unwrap_or_else(|e| e.into_inner()));
        for (_, encoder) in encoders {
            encoder.close();
        }
        self.latest.lock().unwrap_or_else(|e| e.into_inner()).take();
        *self.conversion.lock().unwrap_or_else(|e| e.into_inner()) = Default::default();
    }
}
impl Drop for MediaSession {
    fn drop(&mut self) {
        self.close();
    }
}

impl FrameSink for MediaSession {
    fn frame(&self, frame: TextureFrame<'_>) -> Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        let captured_at = Instant::now();
        self.readback
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .copy_at(&frame, captured_at)?;
        if self.has_consumers() {
            self.notify.notify_one();
        }
        Ok(())
    }
}

// Automatic selection keeps H.264 as the broadly compatible default. Explicit
// codec requests select only a matching hardware encoder, never silently change codec.
fn select_hardware_encoder(
    options: &MediaOptions,
    encoders: Vec<EncoderInfo>,
) -> Result<Option<EncoderInfo>> {
    let requested = options.codec.as_deref().unwrap_or("video/h264");
    if options.encoder == "auto" {
        Ok(encoders
            .into_iter()
            .find(|e| e.codecs.iter().any(|c| c == requested)))
    } else {
        let encoder = encoders
            .into_iter()
            .find(|e| e.id == options.encoder)
            .ok_or("Selected hardware encoder is unavailable")?;
        if options
            .codec
            .as_ref()
            .is_some_and(|c| !encoder.codecs.contains(c))
        {
            return Err("Selected hardware encoder does not support the requested codec".into());
        }
        Ok(Some(encoder))
    }
}
