//! Native actor. No Tauri IPC or network handler is exposed by this module.
mod device;
mod environment;
mod pan;
mod safety;
mod session;
mod touch;
use crate::{
    authorization::{Binding, Grant, RequestResult},
    engine::{Engine, Status, TrustedTarget},
    input::{Error, Event, Geometry},
    mailbox::Mailbox,
    protocol::Signal,
};
use device::WindowsDevice;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

static RUNNING: AtomicBool = AtomicBool::new(false);
/// Read-only availability check shared by the host and focused controller capture.
pub fn input_desktop_available() -> bool {
    environment::desktop_available()
}
struct Exclusive;
impl Drop for Exclusive {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}
type LocalCall = Box<dyn FnOnce(&mut Engine<WindowsDevice>) + Send>;
enum Command {
    Local(LocalCall),
    Input {
        grant: Box<Grant>,
        event: Event,
        queued: Instant,
    },
}
/// One per native process; the registered emergency hotkey also prevents parallel instances.
/// Dropping the owner closes the queue and joins after releasing injected keys/buttons.
pub struct Worker {
    queue: Arc<Mailbox<Command>>,
    status: Arc<Mutex<Status>>,
    thread: Option<JoinHandle<()>>,
}
impl Worker {
    /// Local host only. `test_window` restricts injection to a foreground window owned by this process.
    /// Production room/media bindings must be resolved by the native composition layer (R3).
    pub fn start(test_window: Option<usize>) -> Result<Self, Error> {
        if RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(Error::Unavailable);
        }
        let exclusive = Exclusive;
        let queue = Arc::new(Mailbox::default());
        let status = Arc::new(Mutex::new(Status {
            input_suspended: false,
            pan_supported: false,
            touch_supported: false,
            pending_consent: None,
            grant: None,
            failure: None,
            closed: false,
            submitted: 0,
        }));
        let (ready, initialized) = mpsc::sync_channel(1);
        let q = queue.clone();
        let s = status.clone();
        let worker = thread::Builder::new()
            .name("weblink-input".into())
            .spawn(move || {
                let _exclusive = exclusive;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let safety = match safety::Safety::new(test_window) {
                        Ok(s) => s,
                        Err(e) => {
                            let _ = ready.send(Err(e));
                            return;
                        }
                    };
                    let observations = safety.observations.clone();
                    let touch = touch::TouchDevice::new();
                    let mut engine =
                        Engine::new(WindowsDevice(safety, touch, pan::PanDevice::new()));
                    let _ = ready.send(Ok(()));
                    loop {
                        let signals = observations.signals();
                        if signals & safety::INVALIDATED != 0 {
                            q.close(Error::Unavailable);
                        }
                        if signals & safety::EMERGENCY != 0 {
                            q.clear();
                            engine.revoke();
                        }
                        if let Some(error) = q.failure() {
                            if error == Error::Closed {
                                engine.shutdown();
                            } else {
                                engine.fail(error);
                            }
                            break;
                        }
                        engine.tick(Instant::now());
                        if engine.status().closed {
                            break;
                        }
                        let command = q.pop();
                        let idle = command.is_none();
                        if let Some(command) = command {
                            match command {
                                Command::Local(call) => call(&mut engine),
                                Command::Input {
                                    grant,
                                    event,
                                    queued,
                                } => {
                                    let _ =
                                        engine.queued_input(&grant, event, queued, Instant::now());
                                }
                            }
                        }
                        *s.lock().unwrap_or_else(|e| e.into_inner()) = engine.status();
                        if engine.status().closed {
                            break;
                        }
                        if idle {
                            thread::park_timeout(Duration::from_millis(2));
                        }
                    }
                    engine.shutdown();
                    *s.lock().unwrap_or_else(|e| e.into_inner()) = engine.status();
                }));
                if result.is_err() {
                    let mut status = s.lock().unwrap_or_else(|e| e.into_inner());
                    status.closed = true;
                    status.grant = None;
                    status.failure = Some(Error::Injection);
                }
                let failure = s.lock().unwrap_or_else(|e| e.into_inner()).failure;
                q.close(failure.unwrap_or(Error::Closed));
            })
            .map_err(|_| Error::Unavailable)?;
        match initialized.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => (),
            other => {
                queue.close(Error::Closed);
                worker.thread().unpark();
                let _ = worker.join();
                return Err(match other {
                    Ok(Err(error)) => error,
                    _ => Error::Timeout,
                });
            }
        };
        let handle = Self {
            queue,
            status,
            thread: Some(worker),
        };

        Ok(handle)
    }
    fn wake(&self) {
        if let Some(t) = &self.thread {
            t.thread().unpark();
        }
    }
    fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Engine<WindowsDevice>) -> T + Send + 'static,
    ) -> Result<T, Error> {
        self.call_with_priority(false, f)
    }
    fn call_with_priority<T: Send + 'static>(
        &self,
        priority: bool,
        f: impl FnOnce(&mut Engine<WindowsDevice>) -> T + Send + 'static,
    ) -> Result<T, Error> {
        let (tx, rx) = mpsc::sync_channel(1);
        let command = Command::Local(Box::new(move |engine| {
            let _ = tx.send(f(engine));
        }));
        if priority {
            self.queue.priority(command)?;
        } else {
            self.queue.push(command, false)?;
        }
        self.wake();
        rx.recv_timeout(Duration::from_secs(2)).map_err(|error| {
            if matches!(error, mpsc::RecvTimeoutError::Timeout) {
                self.queue.close(Error::Timeout);
                self.wake();
                Error::Timeout
            } else {
                self.status()
                    .failure
                    .or_else(|| self.queue.failure())
                    .unwrap_or(Error::Cancelled)
            }
        })
    }
    pub fn register(&self, target: TrustedTarget) -> Result<bool, Error> {
        self.call(move |e| e.register(target))
    }
    pub fn register_until(
        &self,
        target: TrustedTarget,
        invalidated: Arc<AtomicBool>,
    ) -> Result<bool, Error> {
        self.call(move |e| e.register_until(target, invalidated))
    }
    pub fn request(&self, media: String, signal: Signal) -> Result<Option<RequestResult>, Error> {
        self.call(move |e| e.request(&media, &signal, Instant::now()))
    }
    pub fn approve(&self, consent: String) -> Result<Option<Signal>, Error> {
        self.call(move |e| e.approve(&consent, Instant::now()))
    }
    pub fn decline(&self, consent: String) -> Result<Option<Signal>, Error> {
        self.call(move |e| e.decline(&consent))
    }
    pub fn renew(&self, grant: Grant) -> Result<bool, Error> {
        self.call(move |e| e.renew(&grant, Instant::now()))
    }
    pub fn receive_end(&self, media: String, signal: Signal) -> Result<bool, Error> {
        self.call(move |e| e.receive_end(&media, &signal))
    }
    pub fn invalidate(&self, binding: Binding) -> Result<(), Error> {
        self.call(move |e| e.invalidate(&binding))
    }
    pub fn interrupt(&self) -> Result<(), Error> {
        self.queue
            .discard(|command| matches!(command, Command::Input { .. }));
        self.call(|e| {
            e.interrupt();
            e.status().failure.map_or(Ok(()), Err)
        })?
    }
    pub fn revoke(&self) -> Result<(), Error> {
        self.call_with_priority(true, |e| {
            e.revoke();
            e.status().failure.map_or(Ok(()), Err)
        })?
    }
    /// Success means queued, not executed. `status.submitted` counts complete OS submissions.
    pub fn input(&self, grant: Grant, event: Event) -> Result<(), Error> {
        if matches!(&event,Event::Text(text) if text.len()>256) {
            return Err(Error::Invalid);
        }
        let movement = matches!(event, Event::Move(_));
        let result = self.queue.push(
            Command::Input {
                grant: Box::new(grant),
                event,
                queued: Instant::now(),
            },
            movement,
        );
        self.wake();
        result
    }
    /// Barrier for native tests/local owner, never waits for remote delivery or application rendering.
    pub fn flush(&self) -> Result<Status, Error> {
        self.call(|e| e.status())
    }
    pub fn status(&self) -> Status {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn shutdown(&mut self) {
        self.queue.close(Error::Closed);
        self.wake();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Query on a DPI-aware local owner thread. Never accepts a remote coordinate/monitor handle.
pub fn physical_displays() -> Result<Vec<Geometry>, Error> {
    let _dpi = environment::InputDpi::new()?;
    environment::layout().map(|l| {
        l.monitors
            .iter()
            .map(|m| Geometry {
                display: m.1,
                desktop: l.desktop,
            })
            .collect()
    })
}
