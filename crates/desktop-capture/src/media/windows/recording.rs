//! A local transport fed by an existing encoder. Its rate control never reaches
//! the borrowed sender; only keyframe requests cross that boundary.
use super::{mf, MediaOptions};
use crate::media::RecordingEnded;
use crate::Result;
use libwebrtc::{
    peer_connection::{PeerConnection, PeerConnectionState},
    video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame},
    video_source::{native::NativeVideoSource, VideoResolution},
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::RecvTimeoutError,
        Arc, Weak,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub(super) struct Reuse {
    pub encoder: Arc<mf::Encoder>,
    pub sender: PeerConnection,
    pub ended: RecordingEnded,
}

pub(super) struct RecordingRelay {
    pub source: NativeVideoSource,
    stopped: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl RecordingRelay {
    pub fn new(reuse: Reuse, connection: PeerConnection, options: &MediaOptions) -> Result<Self> {
        let source = NativeVideoSource::new_encoded(VideoResolution::default());
        if !source.set_color_space(Some(options.color_space().rtc())) {
            return Err("Invalid native recording color space".into());
        }
        let encoder = Arc::downgrade(&reuse.encoder);
        let request = encoder.clone();
        // Consume ONLY the recording peer's keyframe bit. Never forward its BWE,
        // bitrate, frame rate or adaptation to the original encoder.
        let weak_source = source.clone();
        source.set_rate_control_wakeup(Some(Arc::new(move || {
            if weak_source.take_keyframe_request() {
                if let Some(encoder) = request.upgrade() {
                    encoder.request_recording_keyframe();
                }
            }
            let _ = weak_source.take_rate_control_request();
        })));
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let output = source.clone();
        let worker = thread::Builder::new()
            .name("weblink-recording-relay".into())
            .spawn(move || {
                let result = relay(encoder, &reuse.sender, &connection, &output, &stop);
                output.set_rate_control_wakeup(None);
                if !stop.load(Ordering::Acquire) {
                    (reuse.ended)(result.err());
                }
            })
            .map_err(|e| {
                source.set_rate_control_wakeup(None);
                e.to_string()
            })?;
        Ok(Self {
            source,
            stopped,
            worker: Some(worker),
        })
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.source.set_rate_control_wakeup(None);
    }
}
impl Drop for RecordingRelay {
    fn drop(&mut self) {
        self.stop();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn relay(
    encoder: Weak<mf::Encoder>,
    sender: &PeerConnection,
    connection: &PeerConnection,
    output: &NativeVideoSource,
    stopped: &AtomicBool,
) -> Result<()> {
    let started = Instant::now();
    while connection.connection_state() != PeerConnectionState::Connected {
        if stopped.load(Ordering::Acquire) {
            return Ok(());
        }
        if sender.connection_state() != PeerConnectionState::Connected {
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(20) {
            return Err("Native recording connection timed out".into());
        }
        thread::sleep(Duration::from_millis(10));
    }
    let Some(owner) = encoder.upgrade() else {
        return Ok(());
    };
    let tap = owner.recording.clone();
    let subscription = tap.subscribe()?;
    owner.request_recording_keyframe();
    drop(owner);
    let mut dimensions = None;
    let mut source_ended = false;
    let result = loop {
        if stopped.load(Ordering::Acquire) {
            break Ok(());
        }
        if !source_ended && sender.connection_state() != PeerConnectionState::Connected {
            // Stop admitting new data, then forward the already accepted prefix.
            tap.unsubscribe(&subscription);
            source_ended = true;
        }
        match subscription.receive(Duration::from_millis(50)) {
            Ok(packet) => {
                let crate::media::recording::PacketKind::Video {
                    codec,
                    width,
                    height,
                } = packet.kind
                else {
                    continue;
                };
                let size = (width, height);
                if dimensions.is_some_and(|previous| previous != size) {
                    // Save the existing file; never splice different formats into it.
                    break Ok(());
                }
                dimensions = Some(size);
                output.capture_encoded_frame(&EncodedVideoFrame {
                    codec: if codec == 1 {
                        EncodedVideoCodec::H264
                    } else {
                        EncodedVideoCodec::H265
                    },
                    payload: &packet.bytes,
                    timestamp_us: packet.timestamp_us,
                    frame_type: if packet.keyframe {
                        EncodedFrameType::Key
                    } else {
                        EncodedFrameType::Delta
                    },
                    resolution: VideoResolution { width, height },
                    frame_metadata: None,
                });
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break subscription.error().map_or(Ok(()), Err),
        }
    };
    tap.unsubscribe(&subscription);
    result
}
