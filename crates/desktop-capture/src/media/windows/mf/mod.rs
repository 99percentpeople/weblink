//! One hardware encoder per receiver, with bounded latest-frame delivery.
mod events;
mod transform;
use super::super::{
    bitrate::{BitrateController, FrameBudget},
    MediaOptions,
};
use crate::media::latency::{CodecControl, Distribution, EncoderPipelineStats};
use crate::Result;
use libwebrtc::{
    native::yuv_helper::i420_to_nv12,
    video_frame::{EncodedFrameType, EncodedVideoFrame, I420Buffer, VideoBuffer},
    video_source::{native::NativeVideoSource, VideoResolution},
};
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
pub use transform::detect;

pub struct Frame {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    captured_at: Option<Instant>,
    ready_at: Instant,
}
impl Frame {
    pub fn from_i420(buffer: &I420Buffer, captured_at: Option<Instant>) -> Self {
        let (width, height) = (buffer.width() as usize, buffer.height() as usize);
        // MediaOptions::dimensions normalizes capture output for NV12.
        assert!(width.is_multiple_of(2) && height.is_multiple_of(2));
        let (y, u, v) = buffer.data();
        let (sy, su, sv) = buffer.strides();
        let mut bytes = vec![0; width * height * 3 / 2];
        let (dst_y, dst_uv) = bytes.split_at_mut(width * height);
        // libyuv uses optimized native routines; a Rust per-pixel UV loop
        // consumes almost the entire 60 FPS budget at 1440p in debug builds.
        i420_to_nv12(
            y,
            sy,
            u,
            su,
            v,
            sv,
            dst_y,
            width as u32,
            dst_uv,
            width as u32,
            width as i32,
            height as i32,
        );
        Self {
            bytes,
            width: width as u32,
            height: height as u32,
            captured_at,
            ready_at: Instant::now(),
        }
    }
}

#[derive(Default)]
struct Pending {
    frame: Option<Arc<Frame>>,
    options: Option<MediaOptions>,
    stopped: bool,
    wake: bool,
}
pub struct Encoder {
    pub source: NativeVideoSource,
    pending: Arc<(Mutex<Pending>, Condvar)>,
    error: Arc<Mutex<Option<String>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    statistics: Arc<Mutex<EncodeStatistics>>,
}

#[derive(Clone, Default)]
pub struct EncodeStatistics {
    pub frames: u64,
    pub seconds: f64,
    pub bitrate: Option<u32>,
    pub queue: Distribution,
    pub capture_to_encode: Distribution,
    encode: Distribution,
    replaced_inputs: u64,
    rate_limited_inputs: u64,
    encoded_bytes: u64,
    in_flight: usize,
    max_in_flight: usize,
    controls: Vec<CodecControl>,
}
impl EncodeStatistics {
    pub fn snapshot(&self, peer: String) -> EncoderPipelineStats {
        EncoderPipelineStats {
            peer,
            frames: self.frames,
            fresh_frames: self.capture_to_encode.count,
            replaced_inputs: self.replaced_inputs,
            rate_limited_inputs: self.rate_limited_inputs,
            encoded_bytes: self.encoded_bytes,
            in_flight: self.in_flight,
            max_in_flight: self.max_in_flight,
            queue: self.queue.snapshot(),
            encode: self.encode.snapshot(),
            capture_to_encode: self.capture_to_encode.snapshot(),
            controls: self.controls.clone(),
        }
    }
}
struct InputTiming {
    submitted_at: Instant,
    ready_at: Instant,
    captured_at: Option<Instant>,
}

// The source owns the notification, which only weakly references Pending.
// Clear it on every worker exit, including transform initialization failures.
struct RateControlSubscription(NativeVideoSource);
impl Drop for RateControlSubscription {
    fn drop(&mut self) {
        self.0.set_rate_control_wakeup(None);
    }
}
impl Encoder {
    pub fn new(id: String, options: MediaOptions, preview: bool) -> Result<Self> {
        let source = NativeVideoSource::new_encoded(VideoResolution::default());
        let pending = Arc::new((Mutex::new(Pending::default()), Condvar::new()));
        let error = Arc::new(Mutex::new(None));
        let output = source.clone();
        let work = pending.clone();
        let failure = error.clone();
        let statistics = Arc::new(Mutex::new(EncodeStatistics::default()));
        let measured = statistics.clone();
        let worker = thread::Builder::new()
            .name("weblink-hardware-encoder".into())
            .spawn(move || {
                if let Err(error) = run(id, options, preview, output, work, measured) {
                    *failure.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            source,
            pending,
            error,
            worker: Mutex::new(Some(worker)),
            statistics,
        })
    }
    pub fn statistics(&self) -> EncodeStatistics {
        self.statistics
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn submit(&self, frame: Arc<Frame>) {
        let mut pending = self.pending.0.lock().unwrap_or_else(|e| e.into_inner());
        if pending.stopped {
            return;
        }
        if pending.frame.replace(frame).is_some() {
            self.statistics
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .replaced_inputs += 1;
        }
        self.pending.1.notify_one();
    }
    pub fn error(&self) -> Option<String> {
        self.error.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn update_options(&self, options: MediaOptions) {
        let mut pending = self.pending.0.lock().unwrap_or_else(|e| e.into_inner());
        if !pending.stopped {
            pending.options = Some(options);
            self.pending.1.notify_one();
        }
    }
    pub fn close(&self) {
        {
            let mut pending = self.pending.0.lock().unwrap_or_else(|e| e.into_inner());
            pending.stopped = true;
            pending.frame = None;
        }
        self.pending.1.notify_one();
        if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Encoder {
    fn drop(&mut self) {
        self.close();
    }
}
fn run(
    id: String,
    mut options: MediaOptions,
    preview: bool,
    output: NativeVideoSource,
    work: Arc<(Mutex<Pending>, Condvar)>,
    statistics: Arc<Mutex<EncodeStatistics>>,
) -> Result<()> {
    let _runtime = transform::Runtime::new().map_err(|e| e.to_string())?;
    let mut encoder: Option<transform::Transform> = None;
    let mut latest: Option<Arc<Frame>> = None;
    let started = Instant::now();
    let mut rate_control = if preview {
        BitrateController::with_start(options.max_bitrate as u32, options.max_bitrate as u32)
    } else {
        BitrateController::new(options.max_bitrate as u32)
    };
    let mut frame_budget = FrameBudget::new(rate_control.current());
    // Capture owns the FPS cap. Do not add a second, independently phased clock
    // or feed libwebrtc's observed static FPS back into capture cadence.
    let weak_work = Arc::downgrade(&work);
    let wake: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        if let Some(work) = weak_work.upgrade() {
            work.0.lock().unwrap_or_else(|e| e.into_inner()).wake = true;
            work.1.notify_one();
        }
    });
    let _rate_subscription = RateControlSubscription(output.clone());
    output.set_rate_control_wakeup(Some(wake.clone()));
    let mut keyframe = true;
    // Bound outstanding timings to the transform's accepted inputs. Reconfiguration
    // discards outstanding frames; cumulative completed-frame counters survive it.
    let mut in_flight = HashMap::<i64, InputTiming>::new();
    loop {
        let (next_options, next_input) = {
            let mut pending = work.0.lock().unwrap_or_else(|e| e.into_inner());
            pending.wake = false;
            if pending.stopped {
                break;
            }
            (pending.options.take(), pending.frame.take())
        };
        // Shutdown may wait for an MFT callback, which also signals this work
        // mutex. Never drop a transform while holding the producer lock.
        {
            if let Some(next) = next_options {
                rate_control.set_limit(next.max_bitrate as u32);
                if next.frame_rate != options.frame_rate || next.max_bitrate != options.max_bitrate
                {
                    // Frame rate and HRD capacity can be fixed at initialization.
                    // Reopen only on explicit setting changes, never BWE feedback;
                    // keep the source, RTP sender and audio alive.
                    encoder = None;
                    in_flight.clear();
                    statistics
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .in_flight = 0;
                    keyframe = true;
                }
                options = next;
            }
            if let Some(frame) = next_input {
                if latest.replace(frame).is_some() {
                    statistics
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .replaced_inputs += 1;
                }
            }
        }
        keyframe |= output.take_keyframe_request();
        if let Some(rate) = output.take_rate_control_request() {
            rate_control.observe(rate.target_bitrate_bps);
        }
        if let Some(bitrate) = rate_control.poll(started.elapsed()) {
            frame_budget.set_bitrate(bitrate, started.elapsed());
            // MF requires a positive target; zero pauses admission instead.
            // Request an IDR on resume if frames in flight were transport-dropped.
            if bitrate == 0 {
                keyframe = true;
            } else if let Some(encoder) = &mut encoder {
                encoder.set_bitrate(bitrate)?;
                // Fixed controls are read once when the transform opens. Avoid
                // repeated driver queries on the rate-feedback path.
                statistics.lock().unwrap_or_else(|e| e.into_inner()).bitrate = Some(bitrate);
            }
        }
        if let Some(frame) = latest.as_ref().filter(|_| rate_control.current() > 0) {
            if encoder.as_ref().is_none_or(|encoder| {
                (encoder.width, encoder.height) != (frame.width, frame.height)
            }) {
                // Driver transforms are recreated on resolution changes; no old packets survive.
                drop(encoder.take());
                in_flight.clear();
                encoder = Some(transform::Transform::open(
                    &id,
                    frame.width,
                    frame.height,
                    options.frame_rate,
                    rate_control.current(),
                    options.max_bitrate as u32,
                    wake.clone(),
                )?);
                let controls = encoder.as_ref().unwrap().control_status();
                let mut stats = statistics.lock().unwrap_or_else(|e| e.into_inner());
                stats.bitrate = Some(rate_control.current());
                stats.controls = controls;
                keyframe = true;
            }
        }
        if let Some(encoder) = &mut encoder {
            for packet in encoder
                .poll()
                .map_err(|e| format!("Hardware encoder output failed: {e}"))?
            {
                if !packet.bytes.is_empty() {
                    frame_budget.record_output(packet.bytes.len(), started.elapsed());
                    statistics
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .encoded_bytes += packet.bytes.len() as u64;
                    if let Some(input_at) = in_flight.remove(&packet.timestamp_us) {
                        let mut stats = statistics.lock().unwrap_or_else(|e| e.into_inner());
                        stats.frames += 1;
                        let now = Instant::now();
                        let encode = now.duration_since(input_at.submitted_at);
                        stats.seconds += encode.as_secs_f64();
                        stats.encode.record(encode);
                        stats
                            .queue
                            .record(input_at.submitted_at.duration_since(input_at.ready_at));
                        if let Some(captured) = input_at.captured_at {
                            stats.capture_to_encode.record(now.duration_since(captured));
                        }
                        stats.in_flight = in_flight.len();
                    }
                    output.capture_encoded_frame(&EncodedVideoFrame {
                        codec: encoder.codec,
                        payload: &packet.bytes,
                        timestamp_us: packet.timestamp_us,
                        frame_type: if packet.keyframe {
                            EncodedFrameType::Key
                        } else {
                            EncodedFrameType::Delta
                        },
                        resolution: VideoResolution {
                            width: encoder.width,
                            height: encoder.height,
                        },
                        frame_metadata: None,
                    });
                }
            }
            if encoder.ready() {
                if let Some(frame) = latest.take() {
                    // MF drivers can exceed their accepted bitrate target. Skip raw
                    // inputs before encoding so the emitted reference chain stays intact.
                    if !frame_budget.can_encode(started.elapsed()) {
                        statistics
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .rate_limited_inputs += 1;
                        continue;
                    }
                    if keyframe {
                        encoder.request_keyframe()?;
                        keyframe = false;
                    }
                    let timestamp = started.elapsed().as_micros() as i64;
                    let input_at = Instant::now();
                    encoder
                        .input(&frame.bytes, timestamp)
                        .map_err(|e| format!("Hardware encoder input failed: {e}"))?;
                    // A driver may discard input without output; never retain an
                    // unbounded diagnostic history in a long-running share.
                    if in_flight.len() >= 256 {
                        in_flight
                            .retain(|_, at| at.submitted_at.elapsed() < Duration::from_secs(2));
                        if in_flight.len() >= 256 {
                            in_flight.clear();
                        }
                    }
                    in_flight.insert(
                        timestamp,
                        InputTiming {
                            submitted_at: input_at,
                            ready_at: frame.ready_at,
                            captured_at: frame.captured_at,
                        },
                    );
                    {
                        let mut stats = statistics.lock().unwrap_or_else(|e| e.into_inner());
                        stats.in_flight = in_flight.len();
                        stats.max_in_flight = stats.max_in_flight.max(in_flight.len());
                    }
                }
            }
        }
        // Synchronize the predicate with every producer, including the MFT
        // callback: a notification between poll() and wait() cannot be lost.
        let pending = work.0.lock().unwrap_or_else(|e| e.into_inner());
        if pending.stopped || pending.wake || pending.frame.is_some() || pending.options.is_some() {
            continue;
        }
        if let Some(delay) = rate_control.next_update_in(started.elapsed()) {
            drop(
                work.1
                    .wait_timeout(pending, delay)
                    .unwrap_or_else(|e| e.into_inner()),
            );
        } else {
            drop(work.1.wait(pending).unwrap_or_else(|e| e.into_inner()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_peer_encoder_does_not_end_capture_or_another_encoder() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let media = super::super::MediaSession::new(MediaOptions {
                encoder: "software".into(),
                ..Default::default()
            })
            .unwrap();
            for cycle in 0..4 {
                // No frames or real capture: inject a worker failure before a
                // transform is opened, then exercise the production recovery path.
                let failed =
                    Arc::new(Encoder::new("test".into(), MediaOptions::default(), false).unwrap());
                let retained =
                    Arc::new(Encoder::new("test".into(), MediaOptions::default(), false).unwrap());
                *failed.error.lock().unwrap() = Some(format!("controlled encoder failure {cycle}"));
                {
                    let mut encoders = media.hardware.lock().unwrap();
                    encoders.insert("failed".into(), failed.clone());
                    encoders.insert("retained".into(), retained.clone());
                }
                media.reap_failed_encoders();
                assert!(media.error().is_none());
                assert!(!media.closed.load(std::sync::atomic::Ordering::Acquire));
                assert!(!media.hardware.lock().unwrap().contains_key("failed"));
                assert!(media.hardware.lock().unwrap().contains_key("retained"));
                assert!(failed.worker.lock().unwrap().is_none());
                assert!(retained.worker.lock().unwrap().is_some());
                media.close_peer("retained");
            }
            assert_eq!(media.pipeline_stats().peer_errors.len(), 4);
            media.close();
        });
    }

    #[test]
    fn event_driven_encoder_reconfigures_and_keeps_static_repeats_out_of_capture_latency() {
        for info in detect().unwrap() {
            for _ in 0..2 {
                let mut options = MediaOptions {
                    frame_rate: 60,
                    ..Default::default()
                };
                let encoder = Encoder::new(info.id.clone(), options.clone(), false).unwrap();
                let pending = Arc::downgrade(&encoder.pending);
                // Include ceiling-only changes: drivers can ignore HRD writes on a
                // running transform, so the new budget must reach a reopened encoder.
                for (fps, ceiling) in [
                    (60, 8_000_000),
                    (60, 1_500_000),
                    (60, 12_000_000),
                    (30, 12_000_000),
                    (60, 8_000_000),
                ] {
                    options.frame_rate = fps;
                    options.max_bitrate = ceiling;
                    encoder.update_options(options.clone());
                    for _ in 0..3 {
                        let start = encoder.statistics().frames;
                        let deadline = Instant::now() + Duration::from_secs(5);
                        let buffer = I420Buffer::new_black(if fps == 60 { 320 } else { 640 }, 180);
                        encoder.submit(Arc::new(Frame::from_i420(&buffer, Some(Instant::now()))));
                        while encoder.statistics().frames == start && Instant::now() < deadline {
                            thread::sleep(Duration::from_millis(5));
                            assert!(encoder.error().is_none(), "{:?}", encoder.error());
                        }
                        assert!(encoder.statistics().frames > start);
                    }
                    let stats = encoder.statistics();
                    let buffer = stats
                        .controls
                        .iter()
                        .find(|c| c.name == "bufferBytes")
                        .unwrap();
                    assert_eq!(buffer.requested, (ceiling as u32).div_ceil(8 * fps));
                    assert_eq!(stats.in_flight, 0);
                }
                // Every fresh input has completed; now repeat only cached pixels.
                let fresh = encoder.statistics().capture_to_encode.count;
                let before = encoder.statistics().frames;
                for _ in 0..10 {
                    encoder.submit(Arc::new(Frame::from_i420(
                        &I420Buffer::new_black(320, 180),
                        None,
                    )));
                    thread::sleep(Duration::from_millis(20));
                }
                assert!(encoder.statistics().frames > before);
                assert_eq!(encoder.statistics().capture_to_encode.count, fresh);
                let stats = encoder.statistics();
                assert_eq!(stats.queue.count, stats.frames);
                encoder.close();
                drop(encoder);
                assert!(
                    pending.upgrade().is_none(),
                    "MFT callback retained the encoder worker"
                );
            }
        }
    }

    #[test]
    fn packs_luma_and_interleaved_chroma_without_copying_stride_padding() {
        let mut buffer = I420Buffer::with_strides(4, 2, 8, 4, 4);
        let (y, u, v) = buffer.data_mut();
        y.copy_from_slice(&[1, 2, 3, 4, 99, 99, 99, 99, 5, 6, 7, 8, 99, 99, 99, 99]);
        u.copy_from_slice(&[10, 11, 99, 99]);
        v.copy_from_slice(&[20, 21, 99, 99]);
        let frame = Frame::from_i420(&buffer, None);
        assert_eq!((frame.width, frame.height), (4, 2));
        assert_eq!(frame.bytes, [1, 2, 3, 4, 5, 6, 7, 8, 10, 20, 11, 21]);
    }
}
