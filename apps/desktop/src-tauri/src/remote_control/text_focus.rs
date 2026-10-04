//! A session-scoped focus stream. Only changed snapshots enter the control channel.
use serde::Serialize;
use std::{
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use weblink_desktop_input::authorization::Grant;

#[cfg(windows)]
mod windows;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(super) enum Focus {
    Unknown,
    None,
    Editable { id: String },
}
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Watch {
    pub grant: Grant,
    pub epoch: String,
    pub id: String,
}
pub(super) struct Update {
    pub watch: Watch,
    pub sequence: u32,
    pub focus: Focus,
}
#[derive(Default)]
struct State {
    closed: bool,
    watch: Option<Watch>,
    update: Option<Update>,
    revision: u64,
}
pub(super) struct Monitor {
    state: Arc<(Mutex<State>, Condvar)>,
    thread: Option<JoinHandle<()>>,
}
impl Default for Monitor {
    fn default() -> Self {
        Self::new(|| {
            #[cfg(windows)]
            {
                let mut detector = windows::Detector::new();
                Box::new(move || detector.as_mut().map_or(Focus::Unknown, |d| d.focus()))
            }
            #[cfg(not(windows))]
            Box::new(|| Focus::Unknown)
        })
    }
}
impl Monitor {
    // COM references are created, used and released on this dedicated MTA thread.
    pub(super) fn new(
        factory: impl FnOnce() -> Box<dyn FnMut() -> Focus> + Send + 'static,
    ) -> Self {
        let state = Arc::new((Mutex::new(State::default()), Condvar::new()));
        let shared = state.clone();
        let thread = thread::Builder::new()
            .name("weblink-text-focus".into())
            .spawn(move || {
                let (lock, wake) = &*shared;
                let mut detector = None;
                let mut factory = Some(factory);
                let mut revision = 0;
                let mut previous = None;
                let mut sequence = 0u32;
                let mut next = Instant::now();
                loop {
                    let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
                    while !state.closed && state.watch.is_none() {
                        state = wake.wait(state).unwrap_or_else(|e| e.into_inner());
                    }
                    if state.closed {
                        break;
                    }
                    if revision != state.revision {
                        revision = state.revision;
                        previous = None;
                        sequence = 0;
                        // A refreshed watch follows an injected tap on the ordered channel.
                        next = Instant::now() + Duration::from_millis(100);
                    }
                    let remaining = next.saturating_duration_since(Instant::now());
                    if !remaining.is_zero() {
                        drop(
                            wake.wait_timeout(state, remaining)
                                .unwrap_or_else(|e| e.into_inner()),
                        );
                        continue;
                    }
                    let watch = state.watch.clone().unwrap();
                    drop(state);
                    let detect = detector.get_or_insert_with(|| factory.take().unwrap()());
                    let started = Instant::now();
                    let mut focus = detect();
                    // A slow or failed provider is uncertainty, never proof of blur.
                    if started.elapsed() > Duration::from_secs(1) {
                        focus = Focus::Unknown;
                    }
                    let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
                    if !state.closed
                        && revision == state.revision
                        && previous.as_ref() != Some(&focus)
                    {
                        sequence = sequence.saturating_add(1);
                        previous = Some(focus.clone());
                        state.update = Some(Update {
                            watch,
                            sequence,
                            focus,
                        });
                    }
                    next = Instant::now() + Duration::from_millis(200);
                }
            })
            .ok();
        Self { state, thread }
    }
    pub(super) fn watch(&self, watch: Watch) {
        if self.thread.is_none() {
            return;
        }
        let mut state = self.state.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.watch.as_ref() == Some(&watch) {
            return;
        }
        state.revision = state.revision.wrapping_add(1);
        state.watch = Some(watch);
        state.update = None;
        self.state.1.notify_one();
    }
    pub(super) fn take(&self) -> Option<Update> {
        self.state
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .update
            .take()
    }
    pub(super) fn cancel(&self) {
        let mut state = self.state.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.watch.take().is_some() {
            state.revision = state.revision.wrapping_add(1);
        }
        state.update = None;
        self.state.1.notify_one();
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        self.state
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .closed = true;
        self.state.1.notify_one();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
