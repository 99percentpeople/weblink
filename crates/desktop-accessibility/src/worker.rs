use crate::*;
#[cfg(not(windows))]
use serde_json::json;
use serde_json::Value;
use std::time::Duration;
#[cfg(windows)]
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, OnceLock,
    },
    time::Instant,
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
    Subscribe {
        request: WaitRequest,
        signal: Arc<WaitSignal>,
        access: Access,
    },
    Cleanup,
}
#[cfg(windows)]
enum Response {
    Value(Value),
    Window(BoundWindow),
    Subscribed(Access),
}
#[derive(Default)]
pub struct Client {
    #[cfg(windows)]
    worker: OnceLock<mpsc::SyncSender<Work>>,
}
#[cfg(windows)]
struct WaitCleanup<'a> {
    client: &'a Client,
    signal: Arc<WaitSignal>,
    access: Access,
}
#[cfg(windows)]
impl Drop for WaitCleanup<'_> {
    fn drop(&mut self) {
        self.signal.cancel();
        if let Some(sender) = self.client.worker.get() {
            // Never block a completed/expired call on a hung provider. If the queue is
            // full, an already queued request will purge the cancelled subscription.
            let (answer, _) = mpsc::channel();
            let _ = sender.try_send(Work {
                operation: Operation::Cleanup,
                access: self.access.clone(),
                answer,
            });
        }
    }
}
impl Client {
    /// Call from a blocking task. Timeouts cancel queued work; no unbounded thread creation.
    pub fn call(&self, request: Request, access: Access) -> Result<Value> {
        request.validate()?;
        #[cfg(not(windows))]
        if matches!(request, Request::Wait(_)) {
            return Err(Error::Unsupported);
        }
        if let Request::Wait(wait) = request {
            return self.wait(wait, access, Arc::new(WaitSignal::default()));
        }
        let result = self.call_bounded(request, access.clone(), Duration::from_secs(8))?;
        Ok(crate::observation::complete(result, |request| {
            self.call_bounded(request, access, Duration::from_secs(8))
        }))
    }
    /// Subscribe before the first observation. Only UIA/authority events wake another read.
    pub fn wait(
        &self,
        request: WaitRequest,
        access: Access,
        signal: Arc<WaitSignal>,
    ) -> Result<Value> {
        request.validate()?;
        (access.check)()?;
        #[cfg(not(windows))]
        {
            let _ = signal;
            Err(Error::Unsupported)
        }
        #[cfg(windows)]
        {
            let start = Instant::now();
            let _cleanup = WaitCleanup {
                client: self,
                signal: signal.clone(),
                access: access.clone(),
            };
            if signal.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let response = self.submit(
                Operation::Subscribe {
                    request: request.clone(),
                    signal: signal.clone(),
                    access: access.clone(),
                },
                access,
                Duration::from_millis(request.timeout_ms),
            )?;
            let Response::Subscribed(access) = response else {
                return Err(Error::ProviderUnavailable);
            };
            crate::wait::run(&request, &access, &signal, start, |remaining| {
                self.call_bounded(
                    Request::Inspect {
                        element_id: request.element_id.clone(),
                        options: request.condition.read_options(),
                        refresh_when: Some(request.condition.clone()),
                    },
                    access.clone(),
                    remaining,
                )
            })
        }
    }
    fn call_bounded(&self, request: Request, access: Access, timeout: Duration) -> Result<Value> {
        request.validate()?;
        (access.check)()?;
        #[cfg(not(windows))]
        {
            let _ = timeout;
            return if matches!(request, Request::Capabilities) {
                Ok(json!({"supported":false,"backend":null,"actions":[]}))
            } else {
                Err(Error::Unsupported)
            };
        }
        #[cfg(windows)]
        {
            match self.submit(Operation::Call(request), access, timeout)? {
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
            match self.submit(
                Operation::BindWindow(element_id),
                access,
                Duration::from_secs(8),
            )? {
                Response::Window(window) => Ok(window),
                _ => Err(Error::ProviderUnavailable),
            }
        }
    }
    #[cfg(windows)]
    fn submit(&self, operation: Operation, access: Access, timeout: Duration) -> Result<Response> {
        let timeout = timeout.min(Duration::from_secs(8));
        if timeout.is_zero() {
            return Err(Error::Timeout);
        }
        let mut access = access;
        let sender = self.worker.get_or_init(|| {
            let (tx, rx) = mpsc::sync_channel::<Work>(4);
            std::thread::Builder::new()
                .name("accessibility".into())
                .spawn(move || {
                    let mut session: Option<crate::session::Session<crate::windows::Windows>> =
                        None;
                    loop {
                        match rx.recv_timeout(Duration::from_secs(5)) {
                            Ok(work) => {
                                if let Some(s) = &mut session {
                                    s.purge();
                                }
                                let result = (|| {
                                    if matches!(&work.operation, Operation::Cleanup) {
                                        return Ok(Response::Value(Value::Null));
                                    }
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
                                if let Some(s) = &mut session {
                                    s.purge();
                                }
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
        let deadline = Instant::now() + timeout;
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
        let result = rx.recv_timeout(timeout).map_err(|e| match e {
            mpsc::RecvTimeoutError::Timeout => Error::Timeout,
            mpsc::RecvTimeoutError::Disconnected => Error::ProviderUnavailable,
        });
        cancelled.store(true, Ordering::Release);
        result?
    }
}
