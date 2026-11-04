//! One full-duplex WebRTC endpoint for a remote room member.
use crate::{
    media::{webrtc::update_sender_parameters, IceCandidate, IceServer},
    receive::{configuration, ice_candidate, Events, MediaOutput},
    Result,
};
use libwebrtc::{
    media_stream_track::MediaStreamTrack,
    peer_connection::{AnswerOptions, OfferOptions, PeerConnection, SignalingState, TrackEvent},
    peer_connection_factory::PeerConnectionFactory,
    rtp_transceiver::{RtpTransceiver, RtpTransceiverDirection},
    session_description::{SdpType, SessionDescription},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
};

pub(crate) mod bandwidth;
mod channels;
mod source;
use channels::Channels;
pub use channels::{ChannelOptions, MessageSink};
pub use source::CaptureSource;

struct CaptureSender {
    track: RtpTransceiver,
    budget: bandwidth::SenderBudget,
}

struct RemoteTrack {
    track_id: String,
    media: MediaStreamTrack,
    streams: Vec<String>,
    output: Option<(u32, Arc<MediaOutput>)>,
}
pub struct RoomPeer {
    pc: PeerConnection,
    factory: PeerConnectionFactory,
    channels: Arc<Channels>,
    events: Events,
    incoming: Mutex<HashMap<String, RemoteTrack>>,
    outgoing: Mutex<HashMap<String, CaptureSender>>,
    bandwidth: Arc<bandwidth::RoomBandwidth>,
    screens: Mutex<HashMap<String, std::sync::Weak<crate::media::MediaSession>>>,
    receive_allowed: AtomicBool,
    next_track: AtomicU32,
    closed: AtomicBool,
    runtime: tokio::runtime::Handle,
    negotiation: tokio::sync::Mutex<()>,
    started: std::time::Instant,
}

impl RoomPeer {
    pub fn open(
        servers: Vec<IceServer>,
        relay: bool,
        events: Events,
        messages: MessageSink,
    ) -> Result<Arc<Self>> {
        // Only attach_room can advertise external H.265. It verifies an encoder before
        // creating a sender; ordinary camera transceivers exclude passthrough-only formats.
        let factory = PeerConnectionFactory::for_windows_room(true);
        let pc = factory
            .create_peer_connection(configuration(servers, relay)?)
            .map_err(|e| e.to_string())?;
        // Either side can initiate a data-only meeting. The polite side leaves
        // initial SCTP creation to its peer and still needs a bundled ICE transport.
        for kind in [libwebrtc::MediaType::Video, libwebrtc::MediaType::Audio] {
            pc.add_transceiver_for_media(
                kind,
                libwebrtc::rtp_transceiver::RtpTransceiverInit {
                    direction: RtpTransceiverDirection::RecvOnly,
                    stream_ids: vec![],
                    send_encodings: vec![],
                },
            )
            .map_err(|e| e.to_string())?;
        }
        let peer = Arc::new(Self {
            channels: Channels::new(events.clone(), messages),
            bandwidth: bandwidth::RoomBandwidth::new(pc.clone()),
            pc,
            factory,
            events,
            incoming: Mutex::new(HashMap::new()),
            outgoing: Default::default(),
            screens: Default::default(),
            receive_allowed: AtomicBool::new(false),
            next_track: AtomicU32::new(1),
            closed: AtomicBool::new(false),
            runtime: tokio::runtime::Handle::current(),
            negotiation: Default::default(),
            started: std::time::Instant::now(),
        });
        let weak = Arc::downgrade(&peer);
        peer.pc.on_ice_candidate(Some(Box::new(move |c| {
            if let Some(p) = weak.upgrade() { p.emit(json!({"type":"candidate", "candidate":{
                "candidate": c.to_string(), "sdpMid":c.sdp_mid(), "sdpMLineIndex":c.sdp_mline_index()
            }})); }
        })));
        let weak = Arc::downgrade(&peer);
        peer.pc
            .on_connection_state_change(Some(Box::new(move |state| {
                if let Some(p) = weak.upgrade() {
                    p.emit(json!({"type":"state","state":format!("{state:?}").to_lowercase()}));
                }
            })));
        let weak = Arc::downgrade(&peer);
        peer.pc
            .on_ice_connection_state_change(Some(Box::new(move |state| {
                if let Some(p) = weak.upgrade() {
                    p.emit(json!({"type":"ice","state":format!("{state:?}").to_lowercase()}));
                }
            })));
        let weak = Arc::downgrade(&peer);
        peer.pc.on_negotiation_needed(Some(Box::new(move |_| {
            if let Some(p) = weak.upgrade() {
                p.emit(json!({"type":"negotiation"}));
            }
        })));
        let weak = Arc::downgrade(&peer);
        peer.pc.on_track(Some(Box::new(move |track| {
            if let Some(p) = weak.upgrade() {
                p.attach(track);
            }
        })));
        let channels = Arc::downgrade(&peer.channels);
        peer.pc.on_data_channel(Some(Box::new(move |dc| {
            if let Some(c) = channels.upgrade() {
                c.accept(dc);
            } else {
                dc.close();
            }
        })));
        Ok(peer)
    }
    fn emit(&self, event: Value) {
        if !self.closed.load(Ordering::Acquire) {
            (self.events)(event);
        }
    }
    fn attach(&self, event: TrackEvent) {
        let Some(mid) = event.transceiver.mid() else {
            return;
        };
        let streams = event.receiver.stream_ids();
        let track_id = event.track.id();
        let mut tracks = self.incoming.lock().unwrap();
        if self.closed.load(Ordering::Acquire) {
            return;
        }
        if tracks
            .get(&mid)
            .is_some_and(|t| t.track_id == track_id && t.streams == streams)
        {
            return;
        }
        if let Some(old) = tracks.remove(&mid) {
            self.remove(old);
        }
        let track = tracks.entry(mid.clone()).or_insert(RemoteTrack {
            track_id,
            media: event.track,
            streams,
            output: None,
        });
        if self.receive_allowed.load(Ordering::Acquire) {
            let (output, media) = self.prepare_output(&mid, track);
            drop(tracks);
            output.attach(&self.runtime, media);
        }
    }
    fn prepare_output(
        &self,
        mid: &str,
        track: &mut RemoteTrack,
    ) -> (Arc<MediaOutput>, MediaStreamTrack) {
        let video = matches!(&track.media, MediaStreamTrack::Video(_));
        let key = self.next_track.fetch_add(1, Ordering::Relaxed);
        let events = self.events.clone();
        let output = MediaOutput::new(
            Arc::new(move |event| events(json!({"type":"media","key":key,"event":event}))),
            video,
        );
        track.output = Some((key, output.clone()));
        self.emit(json!({"type":"track","streams":track.streams,"key":key,"mid":mid,"kind":if video{"video"}else{"audio"}}));
        (output, track.media.clone())
    }
    fn stop_output(&self, track: &mut RemoteTrack) {
        if let Some((key, output)) = track.output.take() {
            output.close();
            self.emit(json!({"type":"untrack","key":key}));
        }
    }
    fn remove(&self, mut track: RemoteTrack) {
        self.stop_output(&mut track);
    }
    /// Revoke native pixels and PCM immediately while retaining the peer's authenticated channels.
    pub fn receive_allowed(&self, allowed: bool) {
        let mut tracks = self.incoming.lock().unwrap();
        if self.closed.load(Ordering::Acquire)
            || self.receive_allowed.swap(allowed, Ordering::AcqRel) == allowed
        {
            return;
        }
        let mut pending = Vec::new();
        for (mid, track) in tracks.iter_mut() {
            if allowed {
                pending.push(self.prepare_output(mid, track));
            } else {
                self.stop_output(track)
            }
        }
        drop(tracks);
        for (output, media) in pending {
            output.attach(&self.runtime, media);
        }
    }
    /// The SDK's on-track callback reports additions. An accepted answer supplies the
    /// authoritative direction for removals even when the receiver track stays live.
    fn reconcile(&self) {
        let receiving: HashSet<_> = self
            .pc
            .transceivers()
            .into_iter()
            .filter(|t| {
                matches!(
                    t.current_direction(),
                    Some(RtpTransceiverDirection::RecvOnly | RtpTransceiverDirection::SendRecv)
                )
            })
            .filter_map(|t| t.mid())
            .collect();
        let removed = {
            let mut tracks = self.incoming.lock().unwrap();
            let ended: Vec<_> = tracks
                .keys()
                .filter(|mid| !receiving.contains(*mid))
                .cloned()
                .collect();
            ended
                .iter()
                .filter_map(|mid| tracks.remove(mid))
                .collect::<Vec<_>>()
        };
        for track in removed {
            self.remove(track);
        }
    }
    pub fn output(&self, key: u32) -> Option<Arc<MediaOutput>> {
        self.incoming
            .lock()
            .unwrap()
            .values()
            .filter_map(|t| t.output.as_ref())
            .find(|(id, _)| *id == key)
            .map(|(_, o)| o.clone())
    }
    pub fn add_capture(
        &self,
        id: &str,
        capture: &CaptureSource,
        streams: Vec<String>,
    ) -> Result<()> {
        use libwebrtc::rtp_transceiver::RtpTransceiverInit;
        if streams.len() > 32
            || streams
                .iter()
                .any(|s| s.is_empty() || s.len() > 128 || s.bytes().any(|c| !c.is_ascii_graphic()))
        {
            return Err("Invalid room stream IDs".into());
        }
        let mut outgoing = self.outgoing.lock().unwrap();
        if self.closed.load(Ordering::Acquire)
            || id.is_empty()
            || id.len() > 128
            || outgoing.len() >= 32
            || outgoing.contains_key(id)
        {
            return Err("Invalid or duplicate room media source".into());
        }
        let transceiver = self
            .pc
            .add_transceiver(
                capture.track(&self.factory, id),
                RtpTransceiverInit {
                    direction: RtpTransceiverDirection::SendOnly,
                    stream_ids: streams,
                    send_encodings: vec![Default::default()],
                },
            )
            .map_err(|e| e.to_string())?;
        if matches!(capture, CaptureSource::Video(_)) {
            let formats = self
                .factory
                .get_rtp_sender_capabilities(libwebrtc::MediaType::Video)
                .codecs
                .into_iter()
                .filter(|c| !c.mime_type.eq_ignore_ascii_case("video/h265"))
                .collect();
            if let Err(error) = transceiver.set_codec_preferences(formats) {
                let _ = transceiver.stop();
                return Err(error.to_string());
            }
        }
        let budget = match self
            .bandwidth
            .capture(matches!(capture, CaptureSource::Video(_)))
        {
            Ok(budget) => budget,
            Err(error) => {
                let _ = transceiver.stop();
                return Err(error);
            }
        };
        outgoing.insert(
            id.to_owned(),
            CaptureSender {
                track: transceiver,
                budget,
            },
        );
        Ok(())
    }
    pub fn attach_screen(
        &self,
        media: &Arc<crate::media::MediaSession>,
        id: &str,
        codecs: &crate::media::SendCodecs,
        port: Option<Arc<dyn crate::media::control::Port>>,
    ) -> Result<()> {
        let mut screens = self.screens.lock().unwrap();
        if self.closed.load(Ordering::Acquire) || screens.len() >= 16 || screens.contains_key(id) {
            return Err("Room screen limit or duplicate ID".into());
        }
        media.attach_room(id, &self.factory, &self.pc, &self.bandwidth, codecs, port)?;
        screens.insert(id.to_string(), Arc::downgrade(media));
        Ok(())
    }
    pub fn detach_screen(&self, id: &str) {
        let media = self
            .screens
            .lock()
            .unwrap()
            .remove(id)
            .and_then(|weak| weak.upgrade());
        if let Some(media) = media {
            media.close_peer(id);
        }
    }
    pub fn screen_ready(&self, id: &str) {
        if let Some(media) = self
            .screens
            .lock()
            .unwrap()
            .get(id)
            .and_then(|w| w.upgrade())
        {
            media.room_keyframe(id);
        }
    }
    pub fn set_codecs(&self, id: &str, preferred: &[String]) -> Result<()> {
        let outgoing = self.outgoing.lock().unwrap();
        let t = &outgoing.get(id).ok_or("Room sender removed")?.track;
        let track = t.sender().track().ok_or("Room source removed")?;
        let kind = if matches!(track, MediaStreamTrack::Video(_)) {
            libwebrtc::MediaType::Video
        } else {
            libwebrtc::MediaType::Audio
        };
        let mut codecs = self.factory.get_rtp_sender_capabilities(kind).codecs;
        // External HEVC supply is exclusive to verified native screen encoders.
        codecs.retain(|c| {
            !c.mime_type.eq_ignore_ascii_case("video/h265")
                && (preferred.is_empty()
                    || preferred
                        .iter()
                        .any(|p| p.eq_ignore_ascii_case(&c.mime_type)))
        });
        codecs.sort_by_key(|c| {
            preferred
                .iter()
                .position(|p| p.eq_ignore_ascii_case(&c.mime_type))
                .unwrap_or(usize::MAX)
        });
        if codecs.is_empty() {
            return Err("No common room media codec".into());
        }
        t.set_codec_preferences(codecs).map_err(|e| e.to_string())
    }
    pub fn set_limits(
        &self,
        id: &str,
        bitrate: Option<u64>,
        fps: Option<f64>,
        scale: Option<f64>,
        degradation: Option<&str>,
    ) -> Result<()> {
        let outgoing = self.outgoing.lock().unwrap();
        let capture = outgoing.get(id).ok_or("Room source removed")?;
        let sender = capture.track.sender();
        let previous = capture.budget.set_limit(bitrate)?;
        let result = update_sender_parameters(&sender, |params| {
            for e in &mut params.encodings {
                e.max_bitrate = bitrate;
                e.max_framerate = fps;
                e.scale_resolution_down_by = scale;
            }
            if let Some(d) = degradation {
                use libwebrtc::rtp_parameters::DegradationPreference::*;
                params.set_degradation_preference(match d {
                    "maintain-framerate" => MaintainFramerate,
                    "maintain-resolution" => MaintainResolution,
                    _ => Balanced,
                });
            }
        });
        if result.is_err() {
            let _ = capture.budget.set_limit(Some(previous));
        }
        result
    }
    pub fn remove_capture(&self, id: &str) -> Result<()> {
        let entry = self.outgoing.lock().unwrap().remove(id);
        if let Some(t) = entry {
            t.track.stop().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    pub fn mids(&self) -> HashMap<String, String> {
        self.outgoing
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(id, t)| t.track.mid().map(|mid| (id.clone(), mid)))
            .collect()
    }
    pub async fn local_description(&self) -> Result<Value> {
        let _guard = self.negotiation.lock().await;
        let desc = match self.pc.signaling_state() {
            SignalingState::Stable => {
                self.pc
                    .create_offer(OfferOptions {
                        offer_to_receive_video: None,
                        offer_to_receive_audio: None,
                        ..Default::default()
                    })
                    .await
            }
            SignalingState::HaveRemoteOffer => {
                self.pc.create_answer(AnswerOptions::default()).await
            }
            _ => return Err("Unexpected native local description state".into()),
        }
        .map_err(|e| e.to_string())?;
        let kind = desc.sdp_type();
        let sdp = if kind == SdpType::Offer {
            let screens = !self.screens.lock().unwrap().is_empty();
            crate::media::capture_time_offer::set_local_offer(&self.pc, desc, screens).await?
        } else {
            let sdp = desc.to_string();
            self.pc
                .set_local_description(desc)
                .await
                .map_err(|e| e.to_string())?;
            sdp
        };
        let result = json!({"type":kind.to_string(),"sdp":sdp});
        if kind == SdpType::Answer {
            self.reconcile();
        }
        Ok(result)
    }
    pub async fn remote_description(&self, kind: &str, sdp: &str) -> Result<()> {
        let kind = match kind {
            "offer" => SdpType::Offer,
            "answer" => SdpType::Answer,
            _ => return Err("Invalid native SDP type".into()),
        };
        if sdp.len() > 512 * 1024 || sdp.lines().filter(|line| line.starts_with("m=")).count() > 65
        {
            return Err("Native room SDP limit exceeded".into());
        }
        let _guard = self.negotiation.lock().await;
        if kind == SdpType::Offer && self.pc.signaling_state() == SignalingState::HaveLocalOffer {
            // Validate before giving up our offer. Rollback may unassign its MIDs.
            SessionDescription::parse(sdp, kind).map_err(|e| e.to_string())?;
            self.pc
                .set_local_description(
                    SessionDescription::parse("", SdpType::Rollback).map_err(|e| e.to_string())?,
                )
                .await
                .map_err(|e| e.to_string())?;
        }
        let screens = self.bandwidth.screen_limits();
        let adjusted =
            (!screens.is_empty()).then(|| crate::media::room_starting_bitrate_sdp(sdp, &screens));
        let desc = SessionDescription::parse(adjusted.as_deref().unwrap_or(sdp), kind)
            .map_err(|e| e.to_string())?;
        self.pc
            .set_remote_description(desc)
            .await
            .map_err(|e| e.to_string())?;
        if kind == SdpType::Answer {
            self.reconcile();
        }
        Ok(())
    }
    pub fn configure(&self, servers: Vec<IceServer>, relay: bool) -> Result<()> {
        self.pc
            .set_configuration(configuration(servers, relay)?)
            .map_err(|e| e.to_string())
    }
    pub async fn candidate(&self, candidate: IceCandidate) -> Result<()> {
        self.pc
            .add_ice_candidate(ice_candidate(candidate)?)
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn stats(&self) -> Result<Value> {
        let raw = self.pc.get_stats_json().await.map_err(|e| e.to_string())?;
        let mut reports: Vec<Value> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let timestamp = self.started.elapsed().as_secs_f64() * 1000.0;
        for report in &mut reports {
            report["timestamp"] = json!(timestamp);
        }
        Ok(json!(reports))
    }
    pub fn create_channel(&self, key: u32, options: ChannelOptions) -> Result<()> {
        self.channels.create(&self.pc, key, options)
    }
    pub fn write(&self, key: u32, data: &[u8], binary: bool) -> Result<()> {
        self.channels.write(key, data, binary)
    }
    pub fn close_channel(&self, key: u32) {
        self.channels.close_one(key);
    }
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.pc.on_track(None);
        self.pc.on_data_channel(None);
        self.pc.on_negotiation_needed(None);
        self.pc.on_ice_candidate(None);
        self.pc.on_connection_state_change(None);
        self.pc.on_ice_connection_state_change(None);
        self.channels.close();
        self.outgoing.lock().unwrap().clear();
        let screens = std::mem::take(&mut *self.screens.lock().unwrap());
        for (id, weak) in screens {
            if let Some(media) = weak.upgrade() {
                media.close_peer(&id);
            }
        }
        for (_, track) in self.incoming.lock().unwrap().drain() {
            self.remove(track);
        }
        self.pc.close();
    }
}
impl Drop for RoomPeer {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests;
