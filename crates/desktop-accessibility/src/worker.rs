use crate::*;
#[cfg(not(windows))]
use serde_json::json;
use serde_json::Value;
#[cfg(windows)]
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, OnceLock,
    },
    time::{Duration, Instant},
};

#[cfg(windows)]
struct Work {
    operation: Operation,
    access: Access,
    answer: mpsc::Sender<Result<Response>>,
}
#[cfg(windows)]
enum Operation {
    Call(Request),
    BindWindow(String),
}
#[cfg(windows)]
enum Response {
    Value(Value),
    Window(BoundWindow),
}
#[derive(Default)]
pub struct Client {
    #[cfg(windows)]
    worker: OnceLock<mpsc::SyncSender<Work>>,
}
impl Client {
    /// Call from a blocking task. Timeouts cancel queued work; no unbounded thread creation.
    pub fn call(&self, request: Request, access: Access) -> Result<Value> {
        request.validate()?;
        (access.check)()?;
        #[cfg(not(windows))]
        return if matches!(request, Request::Capabilities) {
            Ok(json!({"supported":false,"backend":null,"actions":[]}))
        } else {
            Err(Error::Unsupported)
        };
        #[cfg(windows)]
        {
            match self.submit(Operation::Call(request), access)? {
                Response::Value(value) => Ok(value),
                _ => Err(Error::ProviderUnavailable),
            }
        }
    }
    pub fn bind_window(&self, element_id: String, access: Access) -> Result<BoundWindow> {
        if element_id.is_empty() || element_id.len() > 128 {
            return Err(Error::InvalidArguments);
        }
        (access.check)()?;
        #[cfg(not(windows))]
        {
            Err(Error::Unsupported)
        }
        #[cfg(windows)]
        {
            match self.submit(Operation::BindWindow(element_id), access)? {
                Response::Window(window) => Ok(window),
                _ => Err(Error::ProviderUnavailable),
            }
        }
    }
    #[cfg(windows)]
    fn submit(&self, operation: Operation, access: Access) -> Result<Response> {
        let mut access = access;
        let sender = self.worker.get_or_init(|| {
            let (tx, rx) = mpsc::sync_channel::<Work>(4);
            std::thread::Builder::new()
                .name("accessibility".into())
                .spawn(move || {
                    let mut session = None;
                    loop {
                        match rx.recv_timeout(Duration::from_secs(5)) {
                            Ok(work) => {
                                let result = (|| {
                                    (work.access.check)()?;
                                    if session.is_none() {
                                        session = Some(crate::session::Session::new(
                                            crate::windows::Windows::new()?,
                                        ));
                                    }
                                    let session = session.as_mut().unwrap();
                                    match work.operation {
                                        Operation::Call(request) => session
                                            .execute(request, work.access)
                                            .map(Response::Value),
                                        Operation::BindWindow(id) => session
                                            .bind_window(&id, work.access)
                                            .map(Response::Window),
                                    }
                                })();
                                let _ = work.answer.send(result);
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {
                                if let Some(s) = &mut session {
                                    s.purge();
                                }
                            }
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                })
                .ok();
            tx
        });
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let deadline = Instant::now() + Duration::from_secs(8);
        let check = access.check.clone();
        access.check = Arc::new(move || {
            if flag.load(Ordering::Acquire) {
                return Err(Error::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(Error::Timeout);
            }
            check()
        });
        let (answer, rx) = mpsc::channel();
        sender
            .try_send(Work {
                operation,
                access,
                answer,
            })
            .map_err(|e| match e {
                mpsc::TrySendError::Full(_) => Error::Busy,
                mpsc::TrySendError::Disconnected(_) => Error::ProviderUnavailable,
            })?;
        let result = rx
            .recv_timeout(Duration::from_secs(8))
            .map_err(|e| match e {
                mpsc::RecvTimeoutError::Timeout => Error::Timeout,
                mpsc::RecvTimeoutError::Disconnected => Error::ProviderUnavailable,
            });
        cancelled.store(true, Ordering::Release);
        result?
    }
}
