use super::{CandidateHandler, EncoderInfo, IceCandidate, IceServer, MediaOptions, VideoSettings};
mod audio;
mod compose;
mod mf;
mod statistics;
#[cfg(test)]
mod tests;
use crate::surface::readback::Readback;
use crate::surface::{FrameSink, Rotation, TextureFrame};
use crate::Result;
use libwebrtc::{
    media_stream_track::MediaStreamTrack,
    native::yuv_helper::argb_to_i420,
    peer_connection::{IceGatheringState, OfferOptions, PeerConnection, PeerConnectionState},
    peer_connection_factory::{
        native::PeerConnectionFactoryExt, ContinualGatheringPolicy, IceTransportsType,
        PeerConnectionFactory, RtcConfiguration,
    },
    prelude::VideoBuffer,
    rtp_parameters::{DegradationPreference, RtpEncodingParameters},
    rtp_sender::VideoEncoderBackend,
    rtp_transceiver::{RtpTransceiverDirection, RtpTransceiverInit},
    session_description::{SdpType, SessionDescription},
    video_frame::{I420Buffer, VideoFrame, VideoRotation},
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
    latest: Mutex<Option<Arc<VideoFrame<I420Buffer>>>>,
    latest_sequence: AtomicU64,
    last_sent: Mutex<Instant>,
    readback: Mutex<Readback>,
    options: Mutex<MediaOptions>,
    notify: Arc<tokio::sync::Notify>,
    error: Mutex<Option<String>>,
    closed: AtomicBool,
    started: Instant,
    pipeline: Mutex<super::pipeline::Timings>,
}

#[derive(Clone)]
struct MediaPeer {
    connection: PeerConnection,
    preview: bool,
}

impl MediaSession {
    pub fn encoders() -> Result<Vec<EncoderInfo>> {
        let mut encoders = vec![EncoderInfo {
            id: "software".into(),
            name: "Software".into(),
            hardware: false,
            codecs: Self::codecs(),
        }];
        encoders.extend(mf::detect().unwrap_or_default());
        Ok(encoders)
    }
    pub fn codecs() -> Vec<String> {
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

    pub fn new(mut options: MediaOptions) -> Result<Arc<Self>> {
        options.validate()?;
        let encoder_id = if options.encoder == "software"
            || (options.encoder == "auto"
                && options
                    .codec
                    .as_deref()
                    .is_some_and(|codec| codec != "video/h264"))
        {
            None
        } else {
            let encoders = if options.encoder == "auto" {
                mf::detect().unwrap_or_default()
            } else {
                mf::detect()?
            };
            if options.encoder == "auto" {
                encoders.first().map(|encoder| encoder.id.clone())
            } else {
                Some(
                    encoders
                        .into_iter()
                        .find(|encoder| encoder.id == options.encoder)
                        .ok_or("Selected hardware encoder is unavailable")?
                        .id,
                )
            }
        };
        if encoder_id.is_some() {
            if options
                .codec
                .as_deref()
                .is_some_and(|codec| codec != "video/h264")
            {
                return Err("Selected hardware encoder only supports H.264".into());
            }
            options.codec = Some("video/h264".into());
        }
        if options
            .codec
            .as_ref()
            .is_some_and(|codec| !Self::codecs().contains(codec))
        {
            return Err("Selected native video codec is unavailable".into());
        }
        // Bundled OpenH264's screen-content preset can overshoot the short-term
        // budget on scene cuts. Its real-time preset responds to rate control;
        // resolution/degradation and screen identity are still set explicitly.
        let screencast = options.codec.as_deref() != Some("video/h264");
        let session = Arc::new(Self {
            // A zero minimum with a positive maximum selects Chromium's low
            // latency renderer, which still assumes 60 FPS. Use the smallest
            // positive RTP delay unit so high-FPS streams keep timestamp-based
            // scheduling, while retaining the 50 ms receiver timing hint.
            factory: PeerConnectionFactory::with_video_send_options(
                libwebrtc::peer_connection_factory::VideoSendOptions {
                    min_playout_delay_ms: 10,
                    max_playout_delay_ms: Some(50),
                    pacing_factor: Some(1.5),
                    software_h264_external_frame_dropper: true,
                },
            )
            .map_err(|e| e.to_string())?,
            source: NativeVideoSource::new(VideoResolution::default(), screencast),
            preview_source: NativeVideoSource::new(VideoResolution::default(), screencast),
            audio: options.audio.then(audio::Loopback::start).transpose()?,
            peers: Mutex::new(HashMap::new()),
            hardware: Mutex::new(HashMap::new()),
            encoder_id,
            latest: Mutex::new(None),
            latest_sequence: AtomicU64::new(0),
            last_sent: Mutex::new(Instant::now()),
            readback: Mutex::new(Readback::default()),
            options: Mutex::new(options),
            notify: Arc::new(tokio::sync::Notify::new()),
            error: Mutex::new(None),
            closed: AtomicBool::new(false),
            started: Instant::now(),
            pipeline: Mutex::new(Default::default()),
        });
        let weak = Arc::downgrade(&session);
        let notify = session.notify.clone();
        let interval = session.frame_interval();
        let steady_input = session.encoder_id.is_none();
        tokio::spawn(async move {
            let mut cadence = tokio::time::interval(interval);
            cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut capture_deadline = tokio::time::Instant::now();
            loop {
                // Software rate control estimates FPS from incoming frames. Sending
                // static content at 2 FPS gives the first moving frames an excessive
                // per-frame budget. Reuse cached pixels at the selected cadence.
                // MF uses an explicit frame rate and can retain sparse static input.
                if !steady_input {
                    let _ =
                        tokio::time::timeout(Duration::from_millis(500), notify.notified()).await;
                }
                let Some(session) = weak.upgrade() else { break };
                if session.closed.load(Ordering::Acquire) {
                    break;
                }
                let interval = session.frame_interval();
                if cadence.period() != interval {
                    cadence = tokio::time::interval(interval);
                    cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    capture_deadline = tokio::time::Instant::now();
                }
                drop(session);
                // Keep an absolute cadence: resetting the deadline to now on
                // every wake accumulates timer overshoot (notably on Windows).
                if steady_input {
                    cadence.tick().await;
                } else {
                    // Start promptly on arrival after idle; rate-limit subsequent
                    // arrivals on this one clock. Hardware has no second FPS gate.
                    let now = tokio::time::Instant::now();
                    if now >= capture_deadline + interval {
                        capture_deadline = now;
                    }
                    tokio::time::sleep_until(capture_deadline).await;
                    capture_deadline += interval;
                }
                let Some(session) = weak.upgrade() else { break };
                // CPU conversion and GPU Map must not block Tauri's async executor.
                // Await every conversion: only one can run or be queued at a time.
                let result = tokio::task::spawn_blocking(move || {
                    if let Err(error) = session.flush() {
                        *session.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
                        session.close();
                    }
                })
                .await;
                if let Err(error) = result {
                    if let Some(session) = weak.upgrade() {
                        *session.error.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some(error.to_string());
                        session.close();
                    }
                    break;
                }
            }
        });
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
        Ok(())
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
            .or_else(|| {
                self.hardware
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .values()
                    .find_map(|encoder| encoder.error())
            })
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
        report
    }

    fn flush(&self) -> Result<()> {
        let mut timing = super::pipeline::Clock::new();
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut readback = self.readback.lock().unwrap_or_else(|e| e.into_inner());
        timing.mark(0);
        if !readback.dirty {
            drop(readback);
            let latest = self
                .latest
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let mut sent = self.last_sent.lock().unwrap_or_else(|e| e.into_inner());
            if !self.closed.load(Ordering::Acquire)
                && (self.encoder_id.is_none() || sent.elapsed() >= Duration::from_millis(500))
            {
                if let Some(frame) = latest.as_ref() {
                    self.publish_frame_at(frame, None);
                    *sent = Instant::now();
                }
            }
            return Ok(());
        }
        let options = self
            .options
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        // Live settings may reprocess a retained static texture. Consume its
        // arrival once so that reprocessing is not counted as delayed capture.
        let captured_at = readback.captured_at.take();
        let capture_wait = captured_at.map(|at| at.elapsed());
        let original_size = readback.size;
        let rotation = readback.rotation;
        let requested = if rotation == Rotation::Identity {
            options.dimensions(original_size.0, original_size.1)
        } else {
            original_size
        };
        readback.prepare(requested)?;
        let (raw_width, raw_height) = readback.output_size;
        let scale_fallback = readback.scale_error.clone();
        timing.mark(1);
        let cursor = readback.cursor.clone();
        let mut composed = std::mem::take(&mut readback.composed);
        let bgra = readback.map()?;
        timing.mark(2);
        let (width, height) = match rotation {
            Rotation::Clockwise90 | Rotation::Clockwise270 => (raw_height, raw_width),
            _ => (raw_width, raw_height),
        };
        let needs_compose =
            rotation != Rotation::Identity || cursor.as_ref().is_some_and(|c| c.visible);
        if needs_compose {
            compose::compose_with_cursor_scale(
                bgra.bytes(),
                bgra.stride() as usize,
                raw_width,
                raw_height,
                rotation,
                cursor.as_ref(),
                (
                    raw_width as f64 / original_size.0 as f64,
                    raw_height as f64 / original_size.1 as f64,
                ),
                &mut composed,
            );
        }
        let bytes = if needs_compose {
            &composed[..]
        } else {
            bgra.bytes()
        };
        let stride = if needs_compose {
            width * 4
        } else {
            bgra.stride()
        };
        timing.mark(3);
        let mut buffer = I420Buffer::new(width, height);
        let (sy, su, sv) = buffer.strides();
        let (y, u, v) = buffer.data_mut();
        // libyuv ARGB means BGRA byte order on little-endian Windows.
        argb_to_i420(
            bytes,
            stride,
            y,
            sy,
            u,
            su,
            v,
            sv,
            width as i32,
            height as i32,
        );
        drop(bgra);
        readback.composed = composed;
        readback.dirty = false;
        drop(readback);
        timing.mark(4);
        let (scaled_width, scaled_height) = options.dimensions(width, height);
        if (width, height) != (scaled_width, scaled_height) {
            buffer = buffer.scale(scaled_width as i32, scaled_height as i32);
        }
        timing.mark(5);
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        let frame = Arc::new(VideoFrame::new(VideoRotation::VideoRotation0, buffer));
        self.publish_frame_at(&frame, captured_at);
        *self.last_sent.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
        let mut latest = self.latest.lock().unwrap_or_else(|e| e.into_inner());
        if self.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        *latest = Some(frame);
        self.latest_sequence.fetch_add(1, Ordering::Relaxed);
        drop(latest);
        timing.mark(6);
        let mut pipeline = self.pipeline.lock().unwrap_or_else(|e| e.into_inner());
        pipeline.input_size = original_size;
        pipeline.readback_size = (raw_width, raw_height);
        pipeline.scale_fallback = scale_fallback;
        pipeline.record(timing.stages);
        if let Some(wait) = capture_wait {
            pipeline.capture_wait.record(wait);
        }
        Ok(())
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
        }))
    }

    #[cfg(test)]
    fn publish_frame(&self, frame: &VideoFrame<I420Buffer>) {
        self.publish_frame_at(frame, Some(Instant::now()));
    }

    fn publish_frame_at(&self, frame: &VideoFrame<I420Buffer>, captured_at: Option<Instant>) {
        // Both adapters borrow the same converted pixels; capture/readback and
        // BGRA conversion still happen only once per frame.
        self.source.capture_frame(frame);
        self.preview_source.capture_frame(frame);
        let hardware = self.hardware.lock().unwrap_or_else(|e| e.into_inner());
        if !hardware.is_empty() {
            let frame = Arc::new(mf::Frame::from_i420(&frame.buffer, captured_at));
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
        self.create_offer(id, servers, relay, preview, None).await
    }

    pub async fn offer_trickle(
        &self,
        id: String,
        servers: Vec<IceServer>,
        relay: bool,
        preview: bool,
        candidates: CandidateHandler,
    ) -> Result<String> {
        self.create_offer(id, servers, relay, preview, Some(candidates))
            .await
    }

    async fn create_offer(
        &self,
        id: String,
        servers: Vec<IceServer>,
        relay: bool,
        preview: bool,
        on_candidate: Option<CandidateHandler>,
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
                    pc.add_transceiver(
                        MediaStreamTrack::Audio(track),
                        RtpTransceiverInit {
                            direction: RtpTransceiverDirection::SendOnly,
                            stream_ids: vec![id.clone()],
                            send_encodings: vec![RtpEncodingParameters {
                                max_bitrate: Some(128_000),
                                ..Default::default()
                            }],
                        },
                    )
                    .map_err(|e| e.to_string())?;
                }
                if let Some(codec) = options.codec.as_ref() {
                    let codecs = self
                        .factory
                        .get_rtp_sender_capabilities(MediaType::Video)
                        .codecs
                        .into_iter()
                        .filter(|c| {
                            (c.mime_type.eq_ignore_ascii_case(codec)
                                && (hardware.is_none()
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
                sender.set_parameters(parameters).map_err(|e| e.to_string())
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
                        preview,
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
        let candidates = Arc::new(Mutex::new(Vec::new()));
        let gathered = candidates.clone();
        let trickle = on_candidate.is_some();
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
            tokio::time::timeout(Duration::from_secs(15), async {
                while pc.ice_gathering_state() != IceGatheringState::Complete {
                    if self.closed.load(Ordering::Acquire)
                        || pc.connection_state() == PeerConnectionState::Closed
                    {
                        return Err("Native media connection closed".to_string());
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                // current_local_description is null while an offer is pending.
                Ok(super::gathered_sdp(
                    &sdp,
                    &candidates.lock().unwrap_or_else(|e| e.into_inner()),
                ))
            })
            .await
            .map_err(|_| "Native ICE gathering timed out".to_string())?
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
        let peer = self
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
            .ok_or("Media peer is no longer active")?;
        let options = self
            .options
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let sdp = super::starting_bitrate_sdp(sdp, options.max_bitrate, peer.preview);
        let description =
            SessionDescription::parse(&sdp, SdpType::Answer).map_err(|e| e.to_string())?;
        peer.connection
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
            let pc = peer.connection;
            pc.on_ice_candidate(None);
            pc.close();
        }
        let encoder = self
            .hardware
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        if let Some(encoder) = encoder {
            encoder.close();
        }
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Some(audio) = &self.audio {
            audio.close();
        }
        self.notify.notify_one();
        let peers = std::mem::take(&mut *self.peers.lock().unwrap_or_else(|e| e.into_inner()));
        for (_, peer) in peers {
            let pc = peer.connection;
            pc.on_ice_candidate(None);
            pc.close();
        }
        let encoders =
            std::mem::take(&mut *self.hardware.lock().unwrap_or_else(|e| e.into_inner()));
        for (_, encoder) in encoders {
            encoder.close();
        }
        self.latest.lock().unwrap_or_else(|e| e.into_inner()).take();
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
        self.notify.notify_one();
        Ok(())
    }
}
