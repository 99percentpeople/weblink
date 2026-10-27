use crate::*;
use serde_json::{json, Value};
#[cfg(test)]
mod tests;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, OnceLock,
    },
    time::{Duration, Instant},
};

pub(crate) struct Work {
    pub operation: Operation,
    pub access: Access,
    pub answer: mpsc::Sender<Result<Response>>,
}
pub(crate) enum Operation {
    Call(Request),
    BindWindow(String),
    Subscribe {
        request: WaitRequest,
        signal: Arc<WaitSignal>,
        access: Access,
    },
    Cleanup,
}
pub(crate) enum Response {
    Value(Value),
    Window(BoundWindow),
    Subscribed(Access),
}
/// Native event loops use this to wake after enqueue and disconnect; the MTA queue wakes itself.
/// Implementations must be nonblocking and must not panic, including during shutdown.
pub(crate) type Notify = Arc<dyn Fn() + Send + Sync>;
struct Connection {
    sender: Option<mpsc::SyncSender<Work>>,
    notify: Notify,
}
impl Connection {
    fn send(&self, work: Work) -> Result<()> {
        self.sender
            .as_ref()
            .unwrap()
            .try_send(work)
            .map_err(|e| match e {
                mpsc::TrySendError::Full(_) => Error::Busy,
                mpsc::TrySendError::Disconnected(_) => Error::ProviderUnavailable,
            })?;
        (self.notify)();
        Ok(())
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.sender.take();
        (self.notify)();
    }
}
pub struct Client {
    worker: OnceLock<Result<Connection>>,
    capabilities: Capabilities,
    start: fn(mpsc::Receiver<Work>) -> Result<Notify>,
}
impl Default for Client {
    fn default() -> Self {
        Self {
            worker: OnceLock::new(),
            capabilities: capabilities(),
            start: crate::platform::start,
        }
    }
}
struct WaitCleanup<'a> {
    client: &'a Client,
    signal: Arc<WaitSignal>,
    access: Access,
}
impl Drop for WaitCleanup<'_> {
    fn drop(&mut self) {
        self.signal.cancel();
        if let Some(Ok(sender)) = self.client.worker.get() {
            // A full queue will purge the cancelled subscription when its next request runs.
            let (answer, _) = mpsc::channel();
            let _ = sender.send(Work {
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
        if let Request::Wait(wait) = request {
            return self.wait(wait, access, Arc::new(WaitSignal::default()));
        }
        let result = self.call_bounded(request, access.clone(), Duration::from_secs(8))?;
        Ok(crate::observation::complete(result, |request| {
            self.call_bounded(request, access, Duration::from_secs(8))
        }))
    }
    /// Subscribe before the first observation. Only native/authority events wake another read.
    pub fn wait(
        &self,
        request: WaitRequest,
        access: Access,
        signal: Arc<WaitSignal>,
    ) -> Result<Value> {
        request.validate()?;
        (access.check)()?;
        if !self.capabilities.features.is_some_and(|f| f.supports_wait) {
            return Err(Error::Unsupported);
        }
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
    fn call_bounded(&self, request: Request, access: Access, timeout: Duration) -> Result<Value> {
        request.validate()?;
        (access.check)()?;
        if !self.capabilities.supported {
            return if matches!(request, Request::Capabilities) {
                Ok(json!(self.capabilities))
            } else {
                Err(Error::Unsupported)
            };
        }
        match self.submit(Operation::Call(request), access, timeout)? {
            Response::Value(value) => Ok(value),
            _ => Err(Error::ProviderUnavailable),
        }
    }
    pub fn bind_window(&self, element_id: String, access: Access) -> Result<BoundWindow> {
        if element_id.is_empty() || element_id.len() > 128 {
            return Err(Error::InvalidArguments);
        }
        (access.check)()?;
        if !self
            .capabilities
            .features
            .is_some_and(|f| f.supports_window_binding)
        {
            return Err(Error::Unsupported);
        }
        match self.submit(
            Operation::BindWindow(element_id),
            access,
            Duration::from_secs(8),
        )? {
            Response::Window(window) => Ok(window),
            _ => Err(Error::ProviderUnavailable),
        }
    }
    fn submit(
        &self,
        operation: Operation,
        mut access: Access,
        timeout: Duration,
    ) -> Result<Response> {
        let timeout = timeout.min(Duration::from_secs(8));
        if timeout.is_zero() {
            return Err(Error::Timeout);
        }
        let sender = self
            .worker
            .get_or_init(|| {
                let (tx, rx) = mpsc::sync_channel(4);
                let notify = (self.start)(rx)?;
                Ok(Connection {
                    sender: Some(tx),
                    notify,
                })
            })
            .as_ref()
            .map_err(|e| *e)?;
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
        sender.send(Work {
            operation,
            access,
            answer,
        })?;
        let result = rx.recv_timeout(timeout).map_err(|e| match e {
            mpsc::RecvTimeoutError::Timeout => Error::Timeout,
            mpsc::RecvTimeoutError::Disconnected => Error::ProviderUnavailable,
        });
        cancelled.store(true, Ordering::Release);
        result?
    }
}
