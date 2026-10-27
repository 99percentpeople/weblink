//! Thread/event-loop policy is independent of the backend and session dispatcher.
use crate::{
    session::Session,
    worker::{Operation, Response, Work},
    Backend, Result,
};
use serde_json::Value;
use std::{sync::mpsc, time::Duration};
#[cfg(test)]
mod tests;

pub(crate) enum Wake {
    Work(Work),
    Maintenance,
    Closed,
}
/// A native run loop can drive this interface without changing session semantics.
/// `next` must wake for queued work, shutdown and periodic subscription cleanup.
pub(crate) trait EventRuntime {
    fn next(&mut self) -> Wake;
}
pub(crate) struct BlockingQueue(mpsc::Receiver<Work>);
impl BlockingQueue {
    pub fn new(receiver: mpsc::Receiver<Work>) -> Self {
        Self(receiver)
    }
}
impl EventRuntime for BlockingQueue {
    fn next(&mut self) -> Wake {
        match self.0.recv_timeout(Duration::from_secs(5)) {
            Ok(work) => Wake::Work(work),
            Err(mpsc::RecvTimeoutError::Timeout) => Wake::Maintenance,
            Err(mpsc::RecvTimeoutError::Disconnected) => Wake::Closed,
        }
    }
}

/// Construct, use and drop the backend (including non-Send native objects) on this thread.
pub(crate) fn run<B: Backend>(
    mut runtime: impl EventRuntime,
    mut create: impl FnMut() -> Result<B>,
) {
    let mut session: Option<Session<B>> = None;
    loop {
        let wake = runtime.next();
        if let Some(session) = &mut session {
            session.purge();
        }
        let work = match wake {
            Wake::Work(work) => work,
            Wake::Maintenance => continue,
            Wake::Closed => break,
        };
        let result = (|| {
            if matches!(work.operation, Operation::Cleanup) {
                return Ok(Response::Value(Value::Null));
            }
            (work.access.check)()?;
            if session.is_none() {
                session = Some(Session::new(create()?));
            }
            let session = session.as_mut().unwrap();
            match work.operation {
                Operation::Call(request) => {
                    session.execute(request, work.access).map(Response::Value)
                }
                Operation::BindWindow(id) => {
                    session.bind_window(&id, work.access).map(Response::Window)
                }
                Operation::Subscribe {
                    request,
                    signal,
                    access,
                } => session
                    .subscribe(
                        &request.element_id,
                        &request.condition,
                        signal,
                        access,
                        work.access.check,
                    )
                    .map(Response::Subscribed),
                Operation::Cleanup => unreachable!(),
            }
        })();
        let _ = work.answer.send(result);
        if let Some(session) = &mut session {
            session.purge();
        }
    }
}
