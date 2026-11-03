//! One receive-only media connection. Only bounded decoded data reaches the UI;
//! RTP, loss recovery, decoder configuration and data channels remain native.
use crate::{
    media::{control::*, IceCandidate, IceServer},
    Result,
};
use libwebrtc::{
    data_channel::{DataChannel, DataChannelState},
    peer_connection::{AnswerOptions, PeerConnection},
    peer_connection_factory::{
        ContinualGatheringPolicy, IceTransportsType, PeerConnectionFactory, RtcConfiguration,
    },
    session_description::{SdpType, SessionDescription},
    MediaType,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};

pub const FRAME_CAPACITY: usize = 3840 * 2160 * 3 / 2;
pub type Events = Arc<dyn Fn(Value) -> bool + Send + Sync>;
mod output;
pub use output::{Frame, MediaOutput};
pub struct Receiver {
    pub pc: PeerConnection,
    output: Arc<MediaOutput>,
    _factory: PeerConnectionFactory,
    events: Events,
    closed: AtomicBool,
    channels: Mutex<HashMap<String, DataChannel>>,
    started: Instant,
}

pub fn codecs() -> Vec<String> {
    let factory = PeerConnectionFactory::for_screen_receive();
    [MediaType::Video, MediaType::Audio]
        .into_iter()
        .flat_map(|kind| factory.get_rtp_receiver_capabilities(kind).codecs)
        .map(|c| c.mime_type.to_lowercase())
        .filter(|c| {
            matches!(
                c.as_str(),
                "video/h265"
                    | "video/h264"
                    | "video/vp8"
                    | "video/vp9"
                    | "video/av1"
                    | "audio/opus"
                    | "audio/g722"
                    | "audio/pcmu"
                    | "audio/pcma"
            )
        })
        .collect()
}
pub(crate) fn configuration(servers: Vec<IceServer>, relay: bool) -> Result<RtcConfiguration> {
    if servers.len() > 32
        || servers
            .iter()
            .any(|s| s.urls.len() > 32 || s.urls.iter().any(|u| u.len() > 4096))
    {
        return Err("Invalid receiver ICE configuration".into());
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
    Ok(config)
}

pub(crate) fn ice_candidate(c: IceCandidate) -> Result<libwebrtc::ice_candidate::IceCandidate> {
    if c.candidate.len() > 4096 || c.sdp_mid.as_ref().is_some_and(|v| v.len() > 128) {
        return Err("Invalid receiver ICE candidate".into());
    }
    let ice = libwebrtc::ice_candidate::IceCandidate::parse(
        c.sdp_mid.as_deref().unwrap_or(""),
        i32::from(c.sdp_m_line_index.unwrap_or(0)),
        &c.candidate,
    )
    .map_err(|e| e.to_string())?;
    Ok(ice)
}

impl Receiver {
    pub fn new(servers: Vec<IceServer>, relay: bool, events: Events) -> Result<Arc<Self>> {
        Self::new_with_presentation(servers, relay, events, false)
    }
    pub fn new_with_presentation(
        servers: Vec<IceServer>,
        relay: bool,
        events: Events,
        gpu: bool,
    ) -> Result<Arc<Self>> {
        let factory = if gpu {
            PeerConnectionFactory::for_screen_receive_gpu()
        } else {
            PeerConnectionFactory::for_screen_receive()
        };
        let config = configuration(servers, relay)?;
        let pc = factory
            .create_peer_connection(config)
            .map_err(|e| e.to_string())?;
        let this = Arc::new(Self {
            pc,
            output: MediaOutput::new(events.clone(), gpu),
            _factory: factory,
            events,
            closed: AtomicBool::new(false),
            channels: Mutex::new(HashMap::new()),
            started: Instant::now(),
        });
        let weak = Arc::downgrade(&this);
        this.pc.on_ice_candidate(Some(Box::new(move |c| {
            if let Some(s) = weak.upgrade() {
                s.emit(json!({"type":"candidate","candidate":{
                "candidate":c.to_string(),"sdpMid":c.sdp_mid(),"sdpMLineIndex":c.sdp_mline_index()
            }}));
            }
        })));
        let weak = Arc::downgrade(&this);
        this.pc
            .on_connection_state_change(Some(Box::new(move |state| {
                if let Some(s) = weak.upgrade() {
                    s.emit(json!({"type":"state","state":format!("{state:?}").to_lowercase()}));
                }
            })));
        let weak = Arc::downgrade(&this);
        this.pc.on_data_channel(Some(Box::new(move |channel| {
            if let Some(s) = weak.upgrade() {
                s.channel(channel);
            } else {
                channel.close();
            }
        })));
        let weak = Arc::downgrade(&this);
        let runtime = tokio::runtime::Handle::current();
        this.pc.on_track(Some(Box::new(move |event| {
            let Some(s) = weak.upgrade() else { return };
            s.output.attach(&runtime, event.track);
        })));
        Ok(this)
    }
    fn emit(&self, value: Value) {
        if !self.closed.load(Ordering::Acquire) {
            (self.events)(value);
        }
    }
    pub async fn answer(&self, sdp: &str) -> Result<String> {
        if sdp.len() > 65536
            || sdp.matches("\nm=video ").count() > 1
            || sdp.matches("\nm=audio ").count() > 1
        {
            return Err("Invalid single-video offer".into());
        }
        self.pc
            .set_remote_description(
                SessionDescription::parse(sdp, SdpType::Offer).map_err(|e| e.to_string())?,
            )
            .await
            .map_err(|e| e.to_string())?;
        let answer = self
            .pc
            .create_answer(AnswerOptions::default())
            .await
            .map_err(|e| e.to_string())?;
        let sdp = answer.to_string();
        self.pc
            .set_local_description(answer)
            .await
            .map_err(|e| e.to_string())?;
        Ok(sdp)
    }
    pub async fn candidate(&self, c: IceCandidate) -> Result<()> {
        let ice = ice_candidate(c)?;
        self.pc
            .add_ice_candidate(ice)
            .await
            .map_err(|e| e.to_string())
    }
    pub async fn stats(&self) -> Result<Value> {
        let raw = self.pc.get_stats_json().await.map_err(|e| e.to_string())?;
        let mut reports: Vec<Value> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        for report in &mut reports {
            report["timestamp"] = json!(self.started.elapsed().as_secs_f64() * 1000.0);
        }
        Ok(json!(reports))
    }
    fn channel(self: &Arc<Self>, channel: DataChannel) {
        let label = channel.label();
        let movement = label == MOVEMENT_LABEL;
        if (label != RELIABLE_LABEL && !movement)
            || channel.protocol() != label
            || channel.ordered() == movement
            || channel.max_retransmit_time() != -1
            || channel.max_retransmits() != if movement { 0 } else { -1 }
        {
            channel.close();
            return;
        }
        {
            let mut channels = self.channels.lock().unwrap();
            if channels.contains_key(&label) {
                channel.close();
                return;
            }
            channels.insert(label.clone(), channel.clone());
        }
        let weak = Arc::downgrade(self);
        let name = label.clone();
        channel.on_state_change(Some(Box::new(move |state| {
            if let Some(s) = weak.upgrade() {s.emit(json!({"type":"channel","label":name,"state":format!("{state:?}").to_lowercase()}));}
        })));
        let weak = Arc::downgrade(self);
        let name = label.clone();
        channel.on_message(Some(Box::new(move |data| {
            if data.binary || data.data.len() > MAX_OUTBOUND_BYTES {
                return;
            }
            if let (Some(s), Ok(data)) = (weak.upgrade(), std::str::from_utf8(data.data)) {
                s.emit(json!({"type":"message","label":name,"data":data}));
            }
        })));
        // Avoid querying channel state while executing its native observer lock.
        self.emit(json!({"type":"channel","label":label,"state":format!("{:?}", channel.state()).to_lowercase()}));
    }
    pub fn send(&self, label: &str, data: &str) -> Result<()> {
        if data.len() > MAX_BYTES {
            return Err("Native control packet too large".into());
        }
        let channel = self
            .channels
            .lock()
            .unwrap()
            .get(label)
            .cloned()
            .ok_or("Native control channel closed")?;
        if channel.state() != DataChannelState::Open || channel.buffered_amount() > HIGH_WATER {
            return Err("Native control channel unavailable".into());
        }
        channel
            .send(data.as_bytes(), false)
            .map_err(|e| e.to_string())
    }
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.output.close();
        self.pc.on_track(None);
        self.pc.on_data_channel(None);
        self.pc.on_ice_candidate(None);
        self.pc.on_connection_state_change(None);
        for (_, channel) in self.channels.lock().unwrap().drain() {
            channel.on_state_change(None);
            channel.on_message(None);
            channel.close();
        }
        self.pc.close();
    }
}
impl std::ops::Deref for Receiver {
    type Target = MediaOutput;
    fn deref(&self) -> &MediaOutput {
        &self.output
    }
}
impl Drop for Receiver {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libwebrtc::video_frame::{NV12Buffer, VideoFrame, VideoRotation};
    #[test]
    fn slow_presenter_retains_only_its_snapshot_and_does_not_block_new_arrivals() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let notices = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let output = notices.clone();
            let receiver = Receiver::new(
                vec![],
                false,
                Arc::new(move |event| {
                    if event["type"] == "frame" {
                        output.fetch_add(1, Ordering::Relaxed);
                    }
                    true
                }),
            )
            .unwrap();
            let publish = |value| {
                let mut pixels = NV12Buffer::new(4, 2);
                pixels.data_mut().0.fill(value);
                receiver
                    .video(VideoFrame::new(
                        VideoRotation::VideoRotation0,
                        Box::new(pixels) as Box<dyn libwebrtc::video_frame::VideoBuffer>,
                    ))
                    .unwrap();
            };
            publish(1);
            // A busy pixel consumer holds a resource reference, never the slot lock.
            let held = receiver.latest_frame(0).unwrap();
            let old = Arc::downgrade(&held);
            assert!(receiver.presentation.try_lock().is_ok());
            publish(2);
            let replaced = Arc::downgrade(
                receiver
                    .presentation
                    .lock()
                    .unwrap()
                    .pixels
                    .as_ref()
                    .unwrap(),
            );
            for value in 3..=100 {
                publish(value);
            }
            assert!(
                replaced.upgrade().is_none(),
                "Intermediate frames must not queue"
            );
            assert_eq!(notices.load(Ordering::Relaxed), 2);
            assert_eq!(held.frame.buffer.as_nv12().unwrap().data().0[0], 1);
            let mut target = [0; 12];
            assert_eq!(
                receiver
                    .copy_frame(held.info.sequence, &mut target)
                    .unwrap()
                    .unwrap()
                    .sequence,
                100
            );
            assert_eq!(target[0], 100);
            receiver.close();
            assert!(
                old.upgrade().is_some(),
                "An in-flight snapshot remains valid after close"
            );
            drop(held);
            assert!(old.upgrade().is_none());
        });
    }
    #[test]
    fn failed_and_cancelled_startup_release_the_receiver_and_callback() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            for attempt in 0..6 {
                let observer = Arc::new(());
                let captured = observer.clone();
                let receiver = Receiver::new(
                    vec![],
                    false,
                    Arc::new(move |_| {
                        let _ = &captured;
                        true
                    }),
                )
                .unwrap();
                let weak = Arc::downgrade(&receiver);
                if attempt % 2 == 0 {
                    assert!(receiver.answer("invalid SDP").await.is_err());
                }
                receiver.close();
                drop(receiver);
                assert!(weak.upgrade().is_none());
                assert_eq!(Arc::strong_count(&observer), 1);
            }
        });
    }
    #[test]
    fn presentation_keeps_latest_crops_stride_and_releases_on_close() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let events = Arc::new(Mutex::new(Vec::new()));
            let output = events.clone();
            let receiver = Receiver::new(
                vec![],
                false,
                Arc::new(move |event| {
                    output.lock().unwrap().push(event);
                    true
                }),
            )
            .unwrap();
            for value in 1..=20 {
                let mut pixels = NV12Buffer::with_strides(4, 2, 8, 8);
                pixels.data_mut().0.fill(value);
                pixels.data_mut().1.fill(128);
                receiver
                    .video(VideoFrame::new(
                        VideoRotation::VideoRotation0,
                        Box::new(pixels) as Box<dyn libwebrtc::video_frame::VideoBuffer>,
                    ))
                    .unwrap();
            }
            assert_eq!(
                events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|e| e["type"] == "frame")
                    .count(),
                1
            );
            assert!(receiver.copy_frame(0, &mut [0; 4]).is_err());
            let mut data = [0; 12];
            let frame = receiver.copy_frame(0, &mut data).unwrap().unwrap();
            assert_eq!(frame.sequence, 20);
            assert_eq!(data, [20, 20, 20, 20, 20, 20, 20, 20, 128, 128, 128, 128]);
            assert!(receiver
                .copy_frame(frame.sequence, &mut data)
                .unwrap()
                .is_none());
            receiver.visible(false);
            assert!(receiver.copy_frame(0, &mut data).unwrap().is_none());
            receiver.visible(true);
            assert!(receiver.copy_frame(0, &mut data).unwrap().is_some());
            receiver.close();
            receiver.close();
            assert!(receiver.copy_frame(0, &mut data).unwrap().is_none());
            assert!(receiver.audio().is_empty());
            assert!(receiver.send(RELIABLE_LABEL, "closed").is_err());
        });
    }
}
