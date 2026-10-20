//! Separate WebRTC feedback and keyframe admission for each shared bitstream consumer.
use libwebrtc::{
    video_frame::{EncodedFrameType, EncodedVideoFrame},
    video_source::{native::NativeVideoSource, VideoResolution},
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

pub(super) struct Output {
    pub source: NativeVideoSource,
    state: Mutex<State>,
    keyframe_requested: Arc<AtomicBool>,
    wake: Arc<dyn Fn() + Send + Sync>,
}
struct State {
    generation: u64,
    waiting_keyframe: bool,
    last_timestamp: i64,
}
impl State {
    fn replace(&mut self) -> u64 {
        self.generation += 1;
        self.waiting_keyframe = true;
        self.generation
    }
    fn accepts(&self, generation: u64, timestamp: i64, keyframe: bool) -> bool {
        generation == self.generation
            && timestamp > self.last_timestamp
            && (!self.waiting_keyframe || keyframe)
    }
    fn delivered(&mut self, timestamp: i64) {
        self.waiting_keyframe = false;
        self.last_timestamp = timestamp;
    }
}
impl Output {
    pub fn new(
        options: &super::MediaOptions,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> crate::Result<Arc<Self>> {
        let source = NativeVideoSource::new_encoded(VideoResolution::default());
        if !source.set_color_space(Some(options.color_space().rtc())) {
            return Err("Invalid shared video color space".into());
        }
        source.set_rate_control_wakeup(Some(wake.clone()));
        Ok(Arc::new(Self {
            source,
            keyframe_requested: Arc::new(AtomicBool::new(false)),
            wake,
            state: Mutex::new(State {
                generation: 0,
                waiting_keyframe: true,
                last_timestamp: -1,
            }),
        }))
    }
    /// Safe on the WebRTC callback thread: defer native queries and pool locks.
    pub fn keyframe_requester(&self) -> crate::surface::gpu::Wake {
        let requested = self.keyframe_requested.clone();
        let wake = self.wake.clone();
        Arc::new(move || {
            requested.store(true, Ordering::Release);
            wake();
        })
    }
    pub fn take_keyframe_request(&self) -> bool {
        let requested = self.keyframe_requested.swap(false, Ordering::AcqRel);
        self.source.take_keyframe_request() || requested
    }
    pub fn replace(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace()
    }
    pub fn deliver(&self, generation: u64, frame: &EncodedVideoFrame<'_>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.accepts(
            generation,
            frame.timestamp_us,
            frame.frame_type == EncodedFrameType::Key,
        ) {
            return;
        }
        if self.source.capture_encoded_frame(frame) {
            state.delivered(frame.timestamp_us);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connected_request_is_coalesced_and_does_not_retain_the_source() {
        let output = Output::new(&super::super::MediaOptions::default(), Arc::new(|| {})).unwrap();
        let weak = Arc::downgrade(&output);
        let request = output.keyframe_requester();
        request();
        request();
        assert!(output.take_keyframe_request());
        assert!(!output.take_keyframe_request());
        drop(output);
        assert!(weak.upgrade().is_none());
        // A racing final connection notification touches only a detached flag.
        request();
    }

    #[test]
    fn group_migration_rejects_old_frames_and_waits_for_a_new_monotonic_keyframe() {
        let mut state = State {
            generation: 0,
            waiting_keyframe: true,
            last_timestamp: -1,
        };
        let first = state.replace();
        assert!(!state.accepts(first, 10, false));
        assert!(state.accepts(first, 10, true));
        state.delivered(10);
        assert!(state.accepts(first, 11, false));
        let second = state.replace();
        assert!(
            !state.accepts(first, 12, true),
            "Old worker cannot pass a racing keyframe"
        );
        assert!(
            !state.accepts(second, 9, true),
            "RTP timestamps cannot move backwards"
        );
        assert!(!state.accepts(second, 12, false));
        assert!(state.accepts(second, 12, true));
        state.delivered(12);
        assert!(
            !state.accepts(second, 12, true),
            "Duplicate timestamps must be rejected"
        );
        assert!(state.accepts(second, 13, false));
    }
}
impl Drop for Output {
    fn drop(&mut self) {
        self.source.set_rate_control_wakeup(None);
    }
}
