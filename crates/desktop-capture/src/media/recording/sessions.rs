//! Recording lifetime independent of the capture/transport session implementation.
use super::source::{RecordingInputs, RecordingSource};
use crate::media::RecordingInfo;
use crate::Result;
use std::sync::{Arc, Mutex};

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;

#[derive(Default)]
struct State {
    active: Option<(String, Arc<RecordingSource>)>,
    closed: bool,
}

#[derive(Default)]
pub(crate) struct RecordingSessions {
    state: Mutex<State>,
}
impl RecordingSessions {
    /// Select only after checking ownership, so a duplicate open never borrows
    /// another encoder, observer or audio tap.
    pub fn open(
        &self,
        id: String,
        encoded_audio: bool,
        select: impl FnOnce() -> Result<Option<RecordingInputs>>,
    ) -> Result<Option<RecordingInfo>> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return Ok(None);
        }
        if state.active.is_some() {
            return Err("A native recording is already active".into());
        }
        let Some(inputs) = select()? else {
            return Ok(None);
        };
        let source = Arc::new(RecordingSource::new(inputs, encoded_audio)?);
        let info = source.info.clone();
        state.active = Some((id, source));
        Ok(Some(info))
    }

    fn source(&self, id: &str) -> Result<Arc<RecordingSource>> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active
            .as_ref()
            .filter(|(current, _)| current == id)
            .map(|(_, source)| source.clone())
            .ok_or_else(|| "Native recording has ended".into())
    }
    pub fn read(&self, id: &str) -> Result<Vec<u8>> {
        Ok(self.source(id)?.read())
    }
    pub fn control(&self, id: &str, active: bool, segment: u32) -> Result<()> {
        self.source(id)?.control(active, segment)
    }
    pub fn close(&self, id: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .active
            .as_ref()
            .is_some_and(|(current, _)| current == id)
        {
            if let Some((_, source)) = state.active.take() {
                // Release even when an in-flight reader still holds an Arc. A
                // late reader/drop must not disable the next recording's tap.
                source.close();
            }
        }
    }
    pub fn shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        if let Some((_, source)) = state.active.take() {
            source.close();
        }
    }
}
impl Drop for RecordingSessions {
    fn drop(&mut self) {
        self.shutdown();
    }
}
