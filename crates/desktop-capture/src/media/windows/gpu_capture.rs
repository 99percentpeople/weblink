//! GPU admission runs independently of CPU readback/conversion and preview consumers.
use super::{
    capture::{Work, STATIC_REFRESH_INTERVAL},
    mf, MediaSession,
};
use crate::media::cadence::CaptureCadence;
use std::{
    sync::{atomic::Ordering, Arc},
    time::Instant,
};

#[derive(Default)]
pub(super) struct State {
    pool: Option<mf::gpu::CapturePool>,
    latest: Option<Arc<mf::gpu::Captured>>,
    generation: u64,
    sent: Option<Instant>,
}
impl MediaSession {
    pub(super) fn wake_capture(&self) {
        self.notify.notify_one();
        self.gpu_notify.notify_one();
    }
    pub(super) fn start_gpu_worker(session: &Arc<Self>) {
        let weak = Arc::downgrade(session);
        let notify = session.gpu_notify.clone();
        let mut cadence = CaptureCadence::new(session.frame_interval(), Instant::now());
        tokio::spawn(async move {
            loop {
                let Some(session) = weak.upgrade() else { break };
                if session.closed.load(Ordering::Acquire) {
                    break;
                }
                cadence.set_interval(session.frame_interval(), Instant::now());
                let admit = cadence.ready(Instant::now());
                let result = tokio::task::spawn_blocking(move || session.gpu_step(admit)).await;
                let work = match result {
                    Ok(work) => work,
                    Err(error) => {
                        if let Some(session) = weak.upgrade() {
                            session.fallback_gpu(format!("GPU capture worker failed: {error}"));
                        }
                        // A failed blocking operation falls back current peers. Keep
                        // admission alive for future peers and replacement devices.
                        Work::default()
                    }
                };
                cadence.complete(work.submitted_at);
                if let Some(wait) = work.wait(&cadence, Instant::now()) {
                    let _ = tokio::time::timeout(wait, notify.notified()).await;
                } else {
                    notify.notified().await;
                }
            }
        });
    }
    fn fallback_gpu(&self, reason: String) {
        for encoder in self
            .hardware
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            if !encoder.needs_readback() {
                encoder.use_readback(reason.clone());
            }
        }
    }
    fn gpu_step(&self, admit: bool) -> Work {
        self.reap_failed_encoders();
        let encoders: Vec<_> = self
            .hardware
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|e| !e.needs_readback())
            .cloned()
            .collect();
        let mut state = self.gpu_capture.lock().unwrap_or_else(|e| e.into_inner());
        if self.closed.load(Ordering::Acquire) || encoders.is_empty() {
            *state = State::default();
            return Work::default();
        }
        let options = self
            .options
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let readback = self.readback.lock().unwrap_or_else(|e| e.into_inner());
        let Some(frame) = readback.frame() else {
            return Work::default();
        };
        let dirty = state.latest.is_none() || state.generation != readback.generation;
        let repeat = state.sent.map(|at| at + STATIC_REFRESH_INTERVAL);
        if !admit || (!dirty && repeat.is_some_and(|at| at > Instant::now())) {
            return Work {
                dirty,
                has_capacity: true,
                repeat,
                ..Default::default()
            };
        }
        if dirty {
            if state.pool.as_ref().is_none_or(|pool| !pool.matches(&frame)) {
                let notify = self.gpu_notify.clone();
                state.pool = Some(mf::gpu::CapturePool::new(
                    &frame,
                    Arc::new(move || notify.notify_one()),
                ));
            }
            match state
                .pool
                .as_ref()
                .unwrap()
                .capture(&frame, self.cursor_visible.load(Ordering::Acquire))
            {
                Ok(Some(frame)) => state.latest = Some(frame),
                Ok(None) => return Work::default(), // A lease release wakes admission; no busy polling.
                Err(error) => {
                    drop(readback);
                    drop(state);
                    self.fallback_gpu(format!("GPU capture texture unavailable: {error}"));
                    return Work::default();
                }
            }
            state.generation = readback.generation;
        }
        let captured_at = if dirty { readback.captured_at } else { None };
        drop(readback);
        let frame = Arc::new(mf::Frame::from_gpu(
            state.latest.as_ref().unwrap().clone(),
            &options,
            captured_at,
        ));
        for encoder in encoders {
            encoder.submit(frame.clone());
        }
        let now = Instant::now();
        state.sent = Some(now);
        Work {
            submitted_at: Some(now),
            repeat: Some(now + STATIC_REFRESH_INTERVAL),
            ..Default::default()
        }
    }
}
