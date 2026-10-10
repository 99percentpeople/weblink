//! Bounded reusable readbacks overlap GPU copies with CPU conversion. Capture keeps
//! one latest source and never waits for a staging texture to become readable.
use super::{compose, from_bgra, MediaSession};
use crate::{
    media::{cadence::CaptureCadence, pipeline::Clock, MediaOptions},
    surface::{readback::PendingReadback, Cursor, Rotation},
    Result,
};
use libwebrtc::video_frame::{VideoFrame, VideoRotation};
use std::{
    collections::VecDeque,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

#[cfg(test)]
mod tests;

const READBACK_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub(super) struct Conversion {
    pending: VecDeque<PendingFrame>,
    reusable: Vec<PendingReadback>,
    composed: Vec<u8>,
}

struct PendingFrame {
    gpu: PendingReadback,
    options: MediaOptions,
    captured_at: Option<Instant>,
    submitted_at: Instant,
    capture_wait: Option<Duration>,
    original_size: (u32, u32),
    output_size: (u32, u32),
    rotation: Rotation,
    cursor: Option<Cursor>,
    scale_fallback: Option<String>,
    timing: Clock,
}

#[derive(Default)]
pub(super) struct Work {
    pub pending: Option<Instant>,
    pub dirty: bool,
    pub has_capacity: bool,
    pub submitted_at: Option<Instant>,
    pub repeat: bool,
}

impl Work {
    fn wait(&self, cadence: &CaptureCadence, now: Instant, steady_input: bool) -> Option<Duration> {
        let scheduled = if self.dirty && self.has_capacity {
            Some(cadence.remaining(now))
        } else if self.pending.is_none() && self.repeat {
            Some(if steady_input {
                cadence.remaining(now)
            } else {
                Duration::from_millis(500)
            })
        } else {
            None
        };
        // This deadline only detects a lost/hung GPU operation. It never retries
        // Map: the slot's completion event is required for every read attempt.
        let watchdog = self
            .pending
            .map(|deadline| deadline.saturating_duration_since(now));
        match (scheduled, watchdog) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }
}

impl MediaSession {
    pub(super) fn start_capture_worker(session: &Arc<Self>) {
        let weak = Arc::downgrade(session);
        let notify = session.notify.clone();
        let steady_input = session.encoder_id.is_none();
        let interval = session.frame_interval();
        tokio::spawn(async move {
            let mut cadence = CaptureCadence::new(interval, Instant::now());
            loop {
                let Some(session) = weak.upgrade() else { break };
                if session.closed.load(Ordering::Acquire) {
                    break;
                }
                if !session.has_consumers() {
                    // Keep only the latest GPU source so resuming a static screen works.
                    session.pause_conversion(
                        &mut session.conversion.lock().unwrap_or_else(|e| e.into_inner()),
                    );
                    let interval = session.frame_interval();
                    drop(session);
                    notify.notified().await;
                    cadence.reset(interval, Instant::now());
                    continue;
                }
                let now = Instant::now();
                cadence.set_interval(session.frame_interval(), now);
                let admit = cadence.ready(now);
                // One worker operation at a time. GPU events never wait in Map;
                // CPU conversion runs off the async executor and capture mutex.
                let result = tokio::task::spawn_blocking(move || session.capture_step(admit)).await;
                let work = match result {
                    Ok(Ok(work)) => work,
                    error => {
                        if let Some(session) = weak.upgrade() {
                            let message = match error {
                                Ok(Err(error)) => error,
                                Err(error) => error.to_string(),
                                _ => unreachable!(),
                            };
                            *session.error.lock().unwrap_or_else(|e| e.into_inner()) =
                                Some(message);
                            session.close();
                        }
                        break;
                    }
                };
                cadence.complete(work.submitted_at);
                if let Some(wait) = work.wait(&cadence, Instant::now(), steady_input) {
                    let _ = tokio::time::timeout(wait, notify.notified()).await;
                } else {
                    notify.notified().await;
                }
            }
        });
    }

    pub(super) fn capture_step(&self, admit: bool) -> Result<Work> {
        let mut conversion = self.conversion.lock().unwrap_or_else(|e| e.into_inner());
        self.reap_failed_encoders();
        if self.closed.load(Ordering::Acquire) {
            *conversion = Conversion::default();
            return Ok(Work::default());
        }
        if !self.has_consumers() {
            self.pause_conversion(&mut conversion);
            return Ok(Work::default());
        }
        let mut published = false;
        let mut submitted_at = None;
        // Prefer the newest completed copy. Old completed frames need not be
        // encoded in a burst when the GPU or worker has been delayed.
        let Conversion {
            pending, composed, ..
        } = &mut *conversion;
        for index in (0..pending.len()).rev() {
            let frame = &mut pending[index];
            let Some(bgra) = frame.gpu.try_map()? else {
                if frame.submitted_at.elapsed() >= READBACK_TIMEOUT {
                    return Err("GPU readback timed out".into());
                }
                continue;
            };
            // Map timing includes the asynchronous GPU wait, not just the last
            // successful read. Overlapped stages must not be summed as throughput.
            frame.timing.mark(2);
            let (raw_width, raw_height) = frame.output_size;
            let (width, height) = match frame.rotation {
                Rotation::Clockwise90 | Rotation::Clockwise270 => (raw_height, raw_width),
                _ => (raw_width, raw_height),
            };
            let cursor = frame
                .cursor
                .as_ref()
                .filter(|_| self.cursor_visible.load(Ordering::Acquire));
            let needs_compose =
                frame.rotation != Rotation::Identity || cursor.is_some_and(|c| c.visible);
            if needs_compose {
                compose::compose_with_cursor_scale(
                    bgra.bytes(),
                    bgra.stride() as usize,
                    raw_width,
                    raw_height,
                    frame.rotation,
                    cursor,
                    (
                        raw_width as f64 / frame.original_size.0 as f64,
                        raw_height as f64 / frame.original_size.1 as f64,
                    ),
                    composed,
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
            frame.timing.mark(3);
            let mut buffer = from_bgra(bytes, stride, width, height, &frame.options);
            drop(bgra);
            frame.timing.mark(4);
            let (scaled_width, scaled_height) = frame.options.dimensions(width, height);
            if (width, height) != (scaled_width, scaled_height) {
                buffer = buffer.scale(scaled_width as i32, scaled_height as i32);
            }
            frame.timing.mark(5);
            if self.closed.load(Ordering::Acquire) {
                return Ok(Work::default());
            }
            let pixels = Arc::new(VideoFrame::new(VideoRotation::VideoRotation0, buffer));
            self.publish_frame_at(&pixels, frame.captured_at);
            *self.last_sent.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
            let mut latest = self.latest.lock().unwrap_or_else(|e| e.into_inner());
            if self.closed.load(Ordering::Acquire) {
                return Ok(Work::default());
            }
            *latest = Some(pixels);
            let sequence = self.latest_sequence.fetch_add(1, Ordering::Release) + 1;
            drop(latest);
            self.notify_previews(sequence);
            frame.timing.mark(6);
            let mut pipeline = self.pipeline.lock().unwrap_or_else(|e| e.into_inner());
            pipeline.input_size = frame.original_size;
            pipeline.readback_size = frame.output_size;
            pipeline.scale_fallback = frame.scale_fallback.clone();
            pipeline.record(frame.timing.stages);
            if let Some(wait) = frame.capture_wait {
                pipeline.capture_wait.record(wait);
            }
            drop(pipeline);
            for _ in 0..=index {
                let finished = conversion.pending.pop_front().unwrap();
                conversion.reusable.push(finished.gpu);
            }
            published = true;
            break;
        }

        let mut timing = Clock::new();
        let mut readback = self.readback.lock().unwrap_or_else(|e| e.into_inner());
        timing.mark(0);
        if admit && readback.dirty && conversion.pending.len() < self.readback_buffers {
            let options = self
                .options
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let original_size = readback.size;
            let requested = if readback.rotation == Rotation::Identity {
                options.dimensions(original_size.0, original_size.1)
            } else {
                original_size
            };
            let captured_at = readback.captured_at.take();
            let capture_wait = captured_at.map(|at| at.elapsed());
            let admitted_at = Instant::now();
            let gpu = readback.submit_notifying(
                requested,
                conversion.reusable.pop(),
                self.notify.clone(),
            )?;
            timing.mark(1);
            conversion.pending.push_back(PendingFrame {
                gpu,
                options,
                captured_at,
                capture_wait,
                submitted_at: Instant::now(),
                original_size,
                output_size: readback.output_size,
                rotation: readback.rotation,
                cursor: readback.cursor.clone(),
                scale_fallback: readback.scale_error.clone(),
                timing,
            });
            // New arrivals and settings changes can mark the retained source
            // dirty while these independent staging copies are still in flight.
            readback.dirty = false;
            submitted_at = Some(admitted_at);
        }
        let mut work = Work {
            pending: conversion
                .pending
                .front()
                .map(|frame| frame.submitted_at + READBACK_TIMEOUT),
            dirty: readback.dirty,
            has_capacity: conversion.pending.len() < self.readback_buffers,
            submitted_at,
            repeat: self.latest_sequence.load(Ordering::Acquire) > 0,
        };
        drop(readback);
        if admit && !published && work.pending.is_none() && !work.dirty {
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
                    work.submitted_at = Some(Instant::now());
                    self.publish_frame_at(frame, None);
                    *sent = Instant::now();
                }
            }
        }
        Ok(work)
    }

    fn pause_conversion(&self, conversion: &mut Conversion) {
        if !conversion.pending.is_empty() {
            // A submitted copy cleared dirty, but has not been published yet.
            // Re-admit the retained source when a consumer returns, even if the
            // desktop stays static and there will be no further frame event.
            self.readback
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .dirty = true;
        }
        *conversion = Conversion::default();
    }
}
