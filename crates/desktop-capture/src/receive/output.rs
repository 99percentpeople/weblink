//! Decoded output for one logical media source, independent of the ICE/DTLS transport.
use super::Events;
use crate::Result;
use libwebrtc::{
    audio_stream::native::{NativeAudioStream, NativeAudioStreamOptions},
    media_stream_track::MediaStreamTrack,
    video_frame::BoxVideoFrame,
    video_stream::native::NativeVideoStream,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tokio::{sync::watch, task::JoinHandle};
use tokio_stream::StreamExt;

pub(super) struct Pixels {
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
pub(super) struct Presentation {
    pub(super) pixels: Option<Arc<Pixels>>,
    audio: VecDeque<Vec<i16>>,
    frame_pending: bool,
    audio_pending: bool,
    visible: bool,
    sequence: u64,
}

pub struct MediaOutput {
    pub gpu: Option<Arc<crate::presentation::Source>>,
    upload: Mutex<crate::presentation::upload::Upload>,
    events: Events,
    closed: watch::Sender<bool>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    pub(super) presentation: Mutex<Presentation>,
    has_video: AtomicBool,
    has_audio: AtomicBool,
}

impl MediaOutput {
    pub(crate) fn new(events: Events, gpu: bool) -> Arc<Self> {
        Arc::new(Self {
            gpu: gpu.then(|| Arc::new(crate::presentation::Source::default())),
            upload: Mutex::new(Default::default()),
            events,
            closed: watch::channel(false).0,
            tasks: Mutex::new(Vec::new()),
            presentation: Mutex::new(Presentation {
                pixels: None,
                audio: VecDeque::new(),
                frame_pending: false,
                audio_pending: false,
                visible: true,
                sequence: 0,
            }),
            has_video: AtomicBool::new(false),
            has_audio: AtomicBool::new(false),
        })
    }
    pub(crate) fn attach(
        self: &Arc<Self>,
        runtime: &tokio::runtime::Handle,
        track: MediaStreamTrack,
    ) {
        if *self.closed.borrow() {
            return;
        }
        let mut closed = self.closed.subscribe();
        let weak = Arc::downgrade(self);
        let task = match track {
            MediaStreamTrack::Video(track) => {
                if self.has_video.swap(true, Ordering::AcqRel) {
                    return;
                }
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
                if self.has_audio.swap(true, Ordering::AcqRel) {
                    return;
                }
                let mut stream = NativeAudioStream::with_options(
                    track,
                    48000,
                    2,
                    NativeAudioStreamOptions {
                        queue_size_frames: Some(4),
                    },
                );
                self.emit(json!({"type":"audio-track"}));
                runtime.spawn(async move {
                    loop {
                        tokio::select! {
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
                        }
                    }
                })
            }
        };
        let mut tasks = self.tasks.lock().unwrap();
        if *self.closed.borrow() {
            task.abort();
        } else {
            tasks.push(task);
        }
    }
    fn emit(&self, value: Value) {
        if !*self.closed.borrow() {
            (self.events)(value);
        }
    }
    pub(super) fn video(&self, frame: BoxVideoFrame) -> Result<()> {
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
    pub(super) fn latest_frame(&self, after: u64) -> Option<Arc<Pixels>> {
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

    pub fn close(&self) {
        if self.closed.send_replace(true) {
            return;
        }
        if let Some(source) = &self.gpu {
            source.close();
        }
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
        let mut p = self.presentation.lock().unwrap();
        p.pixels = None;
        p.audio.clear();
    }
}
impl Drop for MediaOutput {
    fn drop(&mut self) {
        self.close();
    }
}
