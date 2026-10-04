use crate::{CaptureState, CaptureStatus, Result};
use std::collections::HashMap;

/// Return false when the consumer has gone away. Never call back into CaptureService.
pub type StatusObserver = Box<dyn Fn(CaptureStatus) -> bool + Send>;
struct Watch {
    previous: CaptureStatus,
    send: StatusObserver,
}
#[derive(Default)]
pub(crate) struct Observers(HashMap<String, Watch>);
impl Observers {
    pub fn watch(&mut self, id: String, status: CaptureStatus, send: StatusObserver) -> Result<()> {
        if self.0.contains_key(&id) || self.0.len() >= 32 {
            return Err("Capture watcher already exists or limit reached".into());
        }
        if !send(status.clone()) {
            return Err("Capture watcher closed".into());
        }
        if status.state == CaptureState::Running {
            self.0.insert(
                id,
                Watch {
                    previous: status,
                    send,
                },
            );
        }
        Ok(())
    }
    pub fn unwatch(&mut self, id: &str) {
        self.0.remove(id);
    }
    pub fn clear(&mut self) {
        self.0.clear();
    }
    pub fn notify(&mut self, status: &CaptureStatus) {
        self.0.retain(|_, watch| {
            let previous = &watch.previous;
            if previous.session_id != status.session_id {
                return true;
            }
            // Counters belong to explicit diagnostic reads, never the change stream.
            if previous.state == status.state
                && previous.backend == status.backend
                && previous.width == status.width
                && previous.height == status.height
                && previous.error == status.error
                && previous.stop_reason == status.stop_reason
            {
                return true;
            }
            watch.previous = status.clone();
            (watch.send)(status.clone()) && status.state == CaptureState::Running
        });
    }
}
