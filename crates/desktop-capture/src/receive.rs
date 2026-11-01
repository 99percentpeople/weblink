//! One receive-only media connection. Only bounded decoded data reaches the UI;
//! RTP, loss recovery, decoder configuration and data channels remain native.
use crate::{
    media::{control::*, IceCandidate, IceServer},
    Result,
};
use libwebrtc::{
    audio_stream::native::{NativeAudioStream, NativeAudioStreamOptions},
    data_channel::{DataChannel, DataChannelState},
    media_stream_track::MediaStreamTrack,
    peer_connection::{AnswerOptions, PeerConnection},
    peer_connection_factory::{
        ContinualGatheringPolicy, IceTransportsType, PeerConnectionFactory, RtcConfiguration,
    },
    session_description::{SdpType, SessionDescription},
    video_frame::BoxVideoFrame,
    video_stream::native::NativeVideoStream,
    MediaType,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tokio::{sync::watch, task::JoinHandle};
use tokio_stream::StreamExt;

pub const FRAME_CAPACITY: usize = 3840 * 2160 * 3 / 2;
pub type Events = Arc<dyn Fn(Value) -> bool + Send + Sync>;
struct Pixels {
    pub info: Frame,
    pub frame: BoxVideoFrame,
    ready: Instant,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub format: &'static str,
    pub color_space: Option<Value>,
    /// Native decoded output (including decoder readback) to shared-copy start.
    pub decoded_queue_ms: f64,
    pub pixel_copy_ms: f64,
}
struct Presentation {
    pixels: Option<Arc<Pixels>>,
    audio: VecDeque<Vec<i16>>,
    frame_pending: bool,
    audio_pending: bool,
    visible: bool,
    sequence: u64,
}
pub struct Receiver {
    pub pc: PeerConnection,
    pub gpu: Option<Arc<crate::presentation::Source>>,
    upload: Mutex<crate::presentation::upload::Upload>,
    _factory: PeerConnectionFactory,
    events: Events,
    closed: watch::Sender<bool>,
    channels: Mutex<HashMap<String, DataChannel>>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    presentation: Mutex<Presentation>,
    started: Instant,
    has_video: AtomicBool,
    has_audio: AtomicBool,
}

pub fn codecs() -> Vec<String> {
    PeerConnectionFactory::for_screen_receive()
        .get_rtp_receiver_capabilities(MediaType::Video)
        .codecs
        .into_iter()
        .map(|c| c.mime_type.to_lowercase())
        .filter(|c| {
            matches!(
                c.as_str(),
                "video/h265" | "video/h264" | "video/vp8" | "video/vp9" | "video/av1"
            )
        })
        .collect()
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
        if servers.len() > 32
            || servers
                .iter()
                .any(|s| s.urls.len() > 32 || s.urls.iter().any(|u| u.len() > 4096))
        {
            return Err("Invalid receiver ICE configuration".into());
        }
        let factory = if gpu {
            PeerConnectionFactory::for_screen_receive_gpu()
        } else {
            PeerConnectionFactory::for_screen_receive()
        };
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
        let pc = factory
            .create_peer_connection(config)
            .map_err(|e| e.to_string())?;
        let this = Arc::new(Self {
            pc,
            gpu: gpu.then(|| Arc::new(crate::presentation::Source::default())),
            upload: Mutex::new(Default::default()),
            _factory: factory,
            events,
            closed: watch::channel(false).0,
            channels: Mutex::new(HashMap::new()),
            tasks: Mutex::new(Vec::new()),
            presentation: Mutex::new(Presentation {
                pixels: None,
                audio: VecDeque::new(),
                frame_pending: false,
                audio_pending: false,
                visible: true,
                sequence: 0,
            }),
            started: Instant::now(),
            has_video: AtomicBool::new(false),
            has_audio: AtomicBool::new(false),
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
            if *s.closed.borrow() {return;}
            let mut closed = s.closed.subscribe();
            let weak = Arc::downgrade(&s);
            let task = match event.track {
                MediaStreamTrack::Video(track) => {
                    if s.has_video.swap(true, Ordering::AcqRel) { return; }
                    let mut stream = NativeVideoStream::new(track);
                    runtime.spawn(async move {
                        loop { tokio::select! {
                            _ = closed.changed() => break,
                            frame = stream.next() => {
                                let (Some(s), Some(frame)) = (weak.upgrade(), frame) else {break};
                                if let Err(error) = s.video(frame) { s.emit(json!({"type":"error","error":error})); break; }
                            }
                        }}
                    })
                }
                MediaStreamTrack::Audio(track) => {
                    if s.has_audio.swap(true, Ordering::AcqRel) {return;}
                    let mut stream = NativeAudioStream::with_options(track, 48000, 2, NativeAudioStreamOptions { queue_size_frames: Some(4) });
                    s.emit(json!({"type":"audio-track"}));
                    runtime.spawn(async move {
                        loop { tokio::select! {
                            _ = closed.changed() => break,
                            frame = stream.next() => {
                                let (Some(s), Some(frame)) = (weak.upgrade(), frame) else {break};
                                let notify = {
                                    let mut p = s.presentation.lock().unwrap();
                                    if *s.closed.borrow() {break;}
                                    if p.audio.len() >= 4 {p.audio.pop_front();}
                                    p.audio.push_back(frame.data.into_owned());
                                    !std::mem::replace(&mut p.audio_pending, true)
                                };
                                if notify { s.emit(json!({"type":"audio"})); }
                            }
                        }}
                    })
                }
            };
            s.tasks.lock().unwrap().push(task);
        })));
        Ok(this)
    }
    fn emit(&self, value: Value) {
        if !*self.closed.borrow() {
            (self.events)(value);
        }
    }
    pub async fn answer(&self, sdp: &str) -> Result<String> {
        if sdp.len() > 65536
            || sdp.matches("\nm=video ").count() > 1
            || sdp.matches("\nm=audio ").count() > 1
        {
            return Err("Invalid single-screen offer".into());
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
        if c.candidate.len() > 4096 || c.sdp_mid.as_ref().is_some_and(|v| v.len() > 128) {
            return Err("Invalid receiver ICE candidate".into());
        }
        let ice = libwebrtc::ice_candidate::IceCandidate::parse(
            c.sdp_mid.as_deref().unwrap_or(""),
            i32::from(c.sdp_m_line_index.unwrap_or(0)),
            &c.candidate,
        )
        .map_err(|e| e.to_string())?;
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
    fn video(&self, frame: BoxVideoFrame) -> Result<()> {
        let (width, height) = (frame.buffer.width(), frame.buffer.height());
        if width < 2
            || height < 2
            || width % 2 != 0
            || height % 2 != 0
            || width > 3840
            || height > 2160
        {
            return Err("Native receive frame exceeds presentation limits".into());
        }
        let format = if frame.buffer.as_nv12().is_some() {
            "NV12"
        } else {
            "I420"
        };
        let color_space = frame.buffer.color_space().map(|c| {
            let mut color = serde_json::Map::new();
            if c[0] == 1 {
                color.insert("primaries".into(), json!("bt709"));
            }
            if let Some(value) = match c[1] {
                1 => Some("bt709"),
                13 => Some("iec61966-2-1"),
                6 => Some("smpte170m"),
                _ => None,
            } {
                color.insert("transfer".into(), json!(value));
            }
            if let Some(value) = match c[2] {
                1 => Some("bt709"),
                5 | 6 => Some("smpte170m"),
                _ => None,
            } {
                color.insert("matrix".into(), json!(value));
            }
            if matches!(c[3], 1 | 2) {
                color.insert("fullRange".into(), json!(c[3] == 2));
            }
            Value::Object(color)
        });
        let notify = {
            let mut p = self.presentation.lock().unwrap();
            if *self.closed.borrow() {
                return Ok(());
            }
            p.sequence += 1;
            p.pixels = Some(Arc::new(Pixels {
                info: Frame {
                    sequence: p.sequence,
                    width,
                    height,
                    format,
                    color_space,
                    decoded_queue_ms: 0.0,
                    pixel_copy_ms: 0.0,
                },
                frame,
                ready: Instant::now(),
            }));
            p.visible && !std::mem::replace(&mut p.frame_pending, true)
        };
        if let Some(source) = &self.gpu {
            // Close may clear the latest frame after publication above.
            let Some(pixels) = self.presentation.lock().unwrap().pixels.clone() else {
                return Ok(());
            };
            let texture = if let Some(native) = pixels.frame.buffer.as_native() {
                use windows_core::Interface;
                // This receiver was exclusively created with for_screen_receive_gpu.
                // Retain the entire immutable frame until the compositor's GPU query completes.
                let resource = unsafe { native.d3d11_resource() };
                let texture = unsafe {
                    windows::Win32::Graphics::Direct3D11::ID3D11Texture2D::from_raw_borrowed(
                        &resource.texture,
                    )
                }
                .ok_or("Native decoder returned a null texture")?
                .clone();
                let color = pixels.frame.buffer.color_space().unwrap_or([1, 1, 1, 1]);
                crate::presentation::Texture {
                    cpu_upload: false,
                    texture,
                    subresource: resource.subresource,
                    crop: (resource.crop_x, resource.crop_y),
                    size: (width, height),
                    bt709: color[2] == 1,
                    full_range: color[3] == 2,
                    owner: pixels.clone(),
                }
            } else {
                let Some(texture) = self.upload.lock().unwrap().frame(&pixels.frame)? else {
                    return Ok(());
                };
                texture
            };
            source.publish(texture);
        } else if notify {
            self.emit(json!({"type":"frame"}));
        }
        Ok(())
    }
    fn latest_frame(&self, after: u64) -> Option<Arc<Pixels>> {
        let mut p = self.presentation.lock().unwrap();
        p.frame_pending = false;
        if !p.visible {
            return None;
        }
        p.pixels
            .as_ref()
            .filter(|frame| frame.info.sequence > after)
            .cloned()
    }
    pub fn copy_frame(&self, after: u64, target: &mut [u8]) -> Result<Option<Frame>> {
        // Like capture preview, retain only the selected immutable frame while
        // packing. The latest slot and audio must remain writable during a slow
        // WebView copy/conversion. A racing arrival rearms one notification.
        let Some(frame) = self.latest_frame(after) else {
            return Ok(None);
        };
        let copying = Instant::now();
        let decoded_queue_ms = frame.ready.elapsed().as_secs_f64() * 1000.0;
        let (width, height) = (frame.info.width as usize, frame.info.height as usize);
        if target.len() < width * height * 3 / 2 {
            return Err("Receive buffer too small".into());
        }
        if let Some(nv12) = frame.frame.buffer.as_nv12() {
            let (y, uv) = nv12.data();
            let (sy, suv) = nv12.strides();
            let mut offset = 0;
            for (data, stride, rows) in [(y, sy, height), (uv, suv, height / 2)] {
                for row in 0..rows {
                    target[offset..offset + width].copy_from_slice(
                        &data[row * stride as usize..row * stride as usize + width],
                    );
                    offset += width;
                }
            }
        } else {
            let i420 = frame.frame.buffer.to_i420();
            let (y, u, v) = i420.data();
            let (sy, su, sv) = i420.strides();
            crate::media::preview::pack_i420(
                target,
                width,
                height,
                [(y, sy as usize), (u, su as usize), (v, sv as usize)],
            )?;
        }
        let mut info = frame.info.clone();
        info.decoded_queue_ms = decoded_queue_ms;
        info.pixel_copy_ms = copying.elapsed().as_secs_f64() * 1000.0;
        Ok(Some(info))
    }
    pub fn decoded_frames(&self) -> u64 {
        self.presentation.lock().unwrap().sequence
    }
    pub fn visible(&self, visible: bool) {
        let notify = {
            let mut p = self.presentation.lock().unwrap();
            p.visible = visible;
            p.frame_pending = false;
            visible && p.pixels.is_some()
        };
        if notify {
            self.emit(json!({"type":"frame"}));
        }
    }
    pub fn audio(&self) -> Vec<u8> {
        let mut p = self.presentation.lock().unwrap();
        p.audio_pending = false;
        p.audio
            .drain(..)
            .flatten()
            .flat_map(i16::to_le_bytes)
            .collect()
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
        if let Some(source) = &self.gpu {
            source.close();
        }
        if self.closed.send_replace(true) {
            return;
        }
        self.pc.on_track(None);
        self.pc.on_data_channel(None);
        self.pc.on_ice_candidate(None);
        self.pc.on_connection_state_change(None);
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
        for (_, channel) in self.channels.lock().unwrap().drain() {
            channel.on_state_change(None);
            channel.on_message(None);
            channel.close();
        }
        self.pc.close();
        let mut p = self.presentation.lock().unwrap();
        p.pixels = None;
        p.audio.clear();
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
