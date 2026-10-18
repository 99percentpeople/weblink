//! Shared hardware worker: bounded input, VFR, transport and recording delivery.
mod backend;
#[cfg(test)]
mod color_probe;
pub(super) mod gpu;
use super::super::{
    bitrate::{BitrateController, FrameBudget},
    MediaOptions,
};
use super::mf::transform;
use crate::damage::Damage;
use crate::media::latency::{
    CodecControl, Distribution, EncoderPipelineStats, HardwareEncoderSelection,
};
use crate::media::recording::{EncodedRecordingTap, Packet, PacketKind};
use crate::media::webrtc::clock_us;
use crate::Result;
pub use backend::detect;
use libwebrtc::{
    native::yuv_helper::i420_to_nv12,
    video_frame::{EncodedFrameType, EncodedVideoFrame, I420Buffer, VideoBuffer},
    video_source::{native::NativeVideoSource, VideoResolution},
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub struct Frame {
    input: Input,
    width: u32,
    height: u32,
    captured_at: Option<Instant>,
    ready_at: Instant,
    damage: Damage,
}
enum Input {
    Memory(Vec<u8>),
    Texture(Arc<gpu::Captured>),
}
impl Frame {
    pub fn from_gpu(
        frame: Arc<gpu::Captured>,
        options: &MediaOptions,
        captured_at: Option<Instant>,
    ) -> Self {
        let (width, height) = frame.size();
        let (width, height) = options.dimensions(width, height);
        Self {
            damage: frame.damage((width, height)),
            input: Input::Texture(frame),
            width,
            height,
            captured_at,
            ready_at: Instant::now(),
        }
    }
    fn device(&self) -> Option<&windows::Win32::Graphics::Direct3D11::ID3D11Device> {
        match &self.input {
            Input::Texture(frame) => Some(&frame.device),
            Input::Memory(_) => None,
        }
    }
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
            input: Input::Memory(bytes),
            damage: Damage::default(),
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
    damage: Damage,
    options: Option<MediaOptions>,
    stopped: bool,
    wake: bool,
    keyframe: bool,
    #[cfg(test)]
    fail_nvenc: bool,
}
impl Pending {
    fn replace_frame(&mut self, frame: Arc<Frame>) -> bool {
        if self
            .frame
            .as_ref()
            .is_some_and(|old| (old.width, old.height) != (frame.width, frame.height))
        {
            self.damage = Damage::default();
        }
        self.damage.merge(&frame.damage);
        self.frame.replace(frame).is_some()
    }
    fn take_input(&mut self) -> (Option<Arc<Frame>>, Damage) {
        (self.frame.take(), self.damage.take())
    }
}
pub struct Encoder {
    pub source: NativeVideoSource,
    pending: Arc<(Mutex<Pending>, Condvar)>,
    error: Arc<Mutex<Option<String>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    statistics: Arc<Mutex<EncodeStatistics>>,
    pub recording: Arc<EncodedRecordingTap>,
    fallback: Arc<Fallback>,
}

struct Fallback {
    cpu: AtomicBool,
    wake: crate::surface::gpu::Wake,
}
impl Fallback {
    fn activate(&self, reason: String, statistics: &Mutex<EncodeStatistics>) {
        statistics
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .gpu_fallback = Some(reason);
        self.cpu.store(true, Ordering::Release);
        (self.wake)();
    }
}

#[derive(Clone, Default)]
pub struct EncodeStatistics {
    pub implementation: &'static str,
    pub frames: u64,
    pub gpu_inputs: u64,
    pub cpu_inputs: u64,
    pub gpu_fallback: Option<String>,
    pub selection: Option<HardwareEncoderSelection>,
    pub seconds: f64,
    pub bitrate: Option<u32>,
    pub queue: Distribution,
    pub capture_to_encode: Distribution,
    encode: Distribution,
    pub(super) replaced_inputs: u64,
    pub(super) rate_limited_inputs: u64,
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
            gpu_inputs: self.gpu_inputs,
            cpu_inputs: self.cpu_inputs,
            gpu_fallback: self.gpu_fallback.clone(),
            selection: self.selection.clone(),
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
    #[cfg(test)]
    pub fn new(id: String, options: MediaOptions, preview: bool) -> Result<Self> {
        Self::with_fallback(id, options, preview, Arc::new(|| {}))
    }
    pub fn with_fallback(
        id: String,
        options: MediaOptions,
        preview: bool,
        wake: crate::surface::gpu::Wake,
    ) -> Result<Self> {
        let source = NativeVideoSource::new_encoded(VideoResolution::default());
        if !source.set_color_space(Some(options.color_space().rtc())) {
            return Err("Invalid hardware video color space".into());
        }
        let pending = Arc::new((Mutex::new(Pending::default()), Condvar::new()));
        let error = Arc::new(Mutex::new(None));
        let output = source.clone();
        let work = pending.clone();
        let failure = error.clone();
        let statistics = Arc::new(Mutex::new(EncodeStatistics::default()));
        let measured = statistics.clone();
        let recording = Arc::new(EncodedRecordingTap::default());
        let tap = recording.clone();
        let fallback = Arc::new(Fallback {
            cpu: AtomicBool::new(false),
            wake,
        });
        let input_mode = fallback.clone();
        let worker = thread::Builder::new()
            .name("weblink-hardware-encoder".into())
            .spawn(move || {
                if let Err(error) = run(
                    id,
                    options,
                    preview,
                    output,
                    work,
                    measured,
                    &tap,
                    &input_mode,
                ) {
                    *failure.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
                }
                tap.end();
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            source,
            pending,
            error,
            worker: Mutex::new(Some(worker)),
            statistics,
            recording,
            fallback,
        })
    }
    pub fn needs_readback(&self) -> bool {
        self.fallback.cpu.load(Ordering::Acquire)
    }
    pub fn use_readback(&self, reason: String) {
        self.fallback.activate(reason, &self.statistics);
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
        if pending.replace_frame(frame) {
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
    pub fn request_recording_keyframe(&self) {
        let mut pending = self.pending.0.lock().unwrap_or_else(|e| e.into_inner());
        if !pending.stopped {
            pending.keyframe = true;
            self.pending.1.notify_one();
        }
    }
    #[cfg(test)]
    pub fn fail_nvenc_output(&self) {
        let mut pending = self.pending.0.lock().unwrap();
        pending.fail_nvenc = true;
        pending.wake = true;
        self.pending.1.notify_one();
    }
    pub fn update_options(&self, options: MediaOptions) {
        let mut pending = self.pending.0.lock().unwrap_or_else(|e| e.into_inner());
        if !pending.stopped {
            pending.options = Some(options);
            self.pending.1.notify_one();
        }
    }
    pub fn close(&self) {
        self.recording.end();
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
    recording: &EncodedRecordingTap,
    fallback: &Fallback,
) -> Result<()> {
    let _runtime = transform::Runtime::new().map_err(|e| e.to_string())?;
    let mut selection = backend::Selection::new(id, options.encoder == "auto");
    let mut encoder: Option<backend::Encoder> = None;
    let mut converter: Option<gpu::Converter> = None;
    let mut latest: Option<Arc<Frame>> = None;
    // Independent of the latest-frame slot: discarded/rate-limited inputs must
    // remain in the damage baseline until this receiver's MFT accepts a frame.
    let mut damage = Damage::default();
    let started = Instant::now();
    let recording_origin = clock_us();
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
        let (next_options, next_input, next_damage) = {
            let mut pending = work.0.lock().unwrap_or_else(|e| e.into_inner());
            pending.wake = false;
            if pending.stopped {
                break;
            }
            #[cfg(test)]
            if std::mem::take(&mut pending.fail_nvenc) {
                encoder.as_mut().unwrap().fail_nvenc_output();
            }
            keyframe |= std::mem::take(&mut pending.keyframe);
            let (frame, damage) = pending.take_input();
            (pending.options.take(), frame, damage)
        };
        // Shutdown may wait for an MFT callback, which also signals this work
        // mutex. Never drop a transform while holding the producer lock.
        {
            if let Some(next) = next_options {
                damage = Damage::default();
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
            if let Some(frame) = next_input
                .filter(|frame| frame.device().is_none() || !fallback.cpu.load(Ordering::Acquire))
            {
                if latest
                    .as_ref()
                    .is_some_and(|old| (old.width, old.height) != (frame.width, frame.height))
                {
                    damage = Damage::default();
                }
                damage.merge(&next_damage);
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
            } else if let Some(active) = &mut encoder {
                if let Err(error) = active.set_bitrate(bitrate) {
                    if !selection.reject_nvenc(&error) {
                        return Err(error);
                    }
                    encoder = None;
                    in_flight.clear();
                    keyframe = true;
                    damage = Damage::default();
                    continue;
                }
                // Fixed controls are read once when the transform opens. Avoid
                // repeated driver queries on the rate-feedback path.
                statistics.lock().unwrap_or_else(|e| e.into_inner()).bitrate = Some(bitrate);
            }
        }
        if let Some(frame) = latest.as_ref().filter(|_| rate_control.current() > 0) {
            if encoder.as_ref().is_none_or(|encoder| {
                (encoder.width, encoder.height) != (frame.width, frame.height)
                    || encoder.device.as_ref() != frame.device()
            }) {
                // Driver transforms are recreated on resolution changes; no old packets survive.
                drop(encoder.take());
                in_flight.clear();
                let opened = (|| -> Result<backend::Encoder> {
                    if let Input::Texture(texture) = &frame.input {
                        // Retain the real capture adapter even if GPU conversion fails
                        // before a transform can open and requests memory fallback.
                        selection.capture_device(&texture.device);
                        if converter
                            .as_ref()
                            .is_none_or(|c| !c.matches(texture, (frame.width, frame.height)))
                        {
                            converter = Some(
                                gpu::Converter::new(
                                    &texture.device,
                                    (frame.width, frame.height),
                                    wake.clone(),
                                )
                                .map_err(|e| format!("GPU NV12 conversion unavailable: {e}"))?,
                            );
                        }
                    }
                    selection.open(
                        frame.width,
                        frame.height,
                        options.frame_rate,
                        rate_control.current(),
                        options.max_bitrate as u32,
                        options.color_space(),
                        wake.clone(),
                        frame.device(),
                    )
                })();
                match opened {
                    Ok(transform) => encoder = Some(transform),
                    Err(error) if frame.device().is_some() => {
                        fallback.activate(error, &statistics);
                        converter = None;
                        latest = None;
                        continue;
                    }
                    Err(error) => return Err(error),
                }
                let controls = encoder.as_ref().unwrap().control_status();
                let mut stats = statistics.lock().unwrap_or_else(|e| e.into_inner());
                stats.implementation = encoder.as_ref().unwrap().implementation();
                stats.bitrate = Some(rate_control.current());
                stats.selection = selection.report.clone();
                stats.controls = controls;
                stats.in_flight = 0;
                keyframe = true;
            }
        }
        let packets = match encoder.as_mut().map(|encoder| encoder.poll()).transpose() {
            Ok(packets) => packets.unwrap_or_default(),
            Err(error) if selection.reject_nvenc(&error) => {
                encoder = None;
                // Capture already owns the retained desktop and will refresh it.
                // Holding another raw snapshot per peer can exhaust its pool.
                in_flight.clear();
                keyframe = true;
                damage = Damage::default();
                continue;
            }
            Err(error) if encoder.as_ref().is_some_and(|e| e.device.is_some()) => {
                fallback.activate(format!("GPU encoder output failed: {error}"), &statistics);
                encoder = None;
                converter = None;
                latest = None;
                in_flight.clear();
                keyframe = true;
                continue;
            }
            Err(error) => return Err(format!("Hardware encoder output failed: {error}")),
        };
        if let Some(active) = &mut encoder {
            for packet in packets {
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
                        codec: active.codec,
                        payload: &packet.bytes,
                        timestamp_us: packet.timestamp_us,
                        frame_type: if packet.keyframe {
                            EncodedFrameType::Key
                        } else {
                            EncodedFrameType::Delta
                        },
                        resolution: VideoResolution {
                            width: active.width,
                            height: active.height,
                        },
                        frame_metadata: None,
                    });
                    // Publish to the original transport first. Move the existing
                    // packet allocation into a bounded, non-waiting recording queue.
                    recording.publish(Packet {
                        bytes: packet.bytes,
                        timestamp_us: recording_origin + packet.timestamp_us,
                        keyframe: packet.keyframe,
                        kind: PacketKind::Video {
                            codec: match active.codec {
                                libwebrtc::video_frame::EncodedVideoCodec::H264 => 1,
                                libwebrtc::video_frame::EncodedVideoCodec::H265 => 2,
                                _ => 0, // A future codec must negotiate its own recording adapter.
                            },
                            width: active.width,
                            height: active.height,
                        },
                        segment: 0,
                    });
                }
            }
            if active.ready() {
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
                        active.request_keyframe()?;
                        damage = Damage::default();
                        keyframe = false;
                    }
                    let timestamp = started.elapsed().as_micros() as i64;
                    let input_at = Instant::now();
                    let input = match &frame.input {
                        Input::Memory(bytes) => active.input(bytes, timestamp, damage.rects()),
                        Input::Texture(texture) => {
                            match converter.as_mut().unwrap().convert(texture, &options) {
                                Ok(Some(surface)) => {
                                    active.input_gpu(surface, timestamp, damage.rects())
                                }
                                Ok(None) => {
                                    // All surfaces are still owned by MF. Keep only the newest
                                    // input and wait for an output or final sample-release wake.
                                    latest = Some(frame);
                                    continue_wait(&work, &rate_control, started, active.watchdog());
                                    continue;
                                }
                                Err(error) => Err(error.to_string()),
                            }
                        }
                    };
                    if let Err(error) = input {
                        if selection.reject_nvenc(&error) {
                            encoder = None;
                            latest = Some(frame);
                            in_flight.clear();
                            keyframe = true;
                            damage = Damage::default();
                            continue;
                        }
                        if frame.device().is_none() {
                            return Err(format!("Hardware encoder input failed: {error}"));
                        }
                        fallback
                            .activate(format!("GPU encoder input failed: {error}"), &statistics);
                        encoder = None;
                        converter = None;
                        latest = None;
                        in_flight.clear();
                        keyframe = true;
                        continue;
                    }
                    if input == Ok(false) {
                        latest = Some(frame);
                        continue_wait(
                            &work,
                            &rate_control,
                            started,
                            Some(Duration::from_millis(2)),
                        );
                        continue;
                    }
                    damage.take();
                    if active.take_controls_changed() {
                        statistics
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .controls = active.control_status();
                    }
                    {
                        let mut stats = statistics.lock().unwrap_or_else(|e| e.into_inner());
                        if frame.device().is_some() {
                            stats.gpu_inputs += 1;
                        } else {
                            stats.cpu_inputs += 1;
                        }
                    }
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
        continue_wait(
            &work,
            &rate_control,
            started,
            encoder.as_ref().and_then(|e| e.watchdog()),
        );
    }
    Ok(())
}

fn continue_wait(
    work: &Arc<(Mutex<Pending>, Condvar)>,
    rate_control: &BitrateController,
    started: Instant,
    watchdog: Option<Duration>,
) {
    // Synchronize the predicate with every producer, including the MFT
    // callback: a notification between poll() and wait() cannot be lost.
    let pending = work.0.lock().unwrap_or_else(|e| e.into_inner());
    if pending.stopped
        || pending.wake
        || pending.keyframe
        || pending.frame.is_some()
        || pending.options.is_some()
    {
        return;
    }
    if let Some(delay) = rate_control
        .next_update_in(started.elapsed())
        .into_iter()
        .chain(watchdog)
        .min()
    {
        drop(
            work.1
                .wait_timeout(pending, delay)
                .unwrap_or_else(|e| e.into_inner()),
        );
    } else {
        drop(work.1.wait(pending).unwrap_or_else(|e| e.into_inner()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latest_input_replacement_keeps_damage_until_a_receiver_accepts_it() {
        use crate::damage::DirtyRect;
        let buffer = I420Buffer::new_black(320, 180);
        let a = [DirtyRect {
            left: 2,
            top: 4,
            right: 6,
            bottom: 8,
        }];
        let b = [DirtyRect {
            left: 100,
            top: 40,
            right: 120,
            bottom: 60,
        }];
        let make = |regions: &[DirtyRect]| {
            let mut frame = Frame::from_i420(&buffer, None);
            frame.damage = Damage::from_rects(Some(regions), (320, 180));
            Arc::new(frame)
        };
        let mut pending = Pending::default();
        pending.replace_frame(make(&a));
        assert_eq!(
            pending.take_input().1.rects(),
            None,
            "A new receiver needs a full baseline"
        );
        let mut worker_damage = Damage::unchanged();
        pending.replace_frame(make(&a));
        assert!(pending.replace_frame(make(&b)));
        let (latest, damage) = pending.take_input();
        assert_eq!(latest.unwrap().damage.rects(), Some(b.as_slice()));
        worker_damage.merge(&damage);
        // An input dropped by FrameBudget does not clear the worker's baseline.
        pending.replace_frame(make(&[]));
        worker_damage.merge(&pending.take_input().1);
        assert_eq!(worker_damage.rects(), Some([a[0], b[0]].as_slice()));
        worker_damage.take(); // Only successful ProcessInput acknowledges changes.
        pending.replace_frame(make(&b));
        worker_damage.merge(&pending.take_input().1);
        assert_eq!(worker_damage.rects(), Some(b.as_slice()));
    }

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
        for info in super::super::mf::detect().unwrap() {
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
        let Input::Memory(bytes) = frame.input else {
            panic!("expected memory input")
        };
        assert_eq!(bytes, [1, 2, 3, 4, 5, 6, 7, 8, 10, 20, 11, 21]);
    }
}
