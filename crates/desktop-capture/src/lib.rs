//! Local capture diagnostics. GPU frames never cross this service's boundary.
use serde::Serialize;
use std::{
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

mod backend;
#[cfg(test)]
mod tests;

const LEASE: Duration = Duration::from_secs(10);
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub id: String,
    pub kind: SourceKind,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    Monitor,
    Window,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureState {
    #[default]
    Idle,
    Running,
    Stopped,
    Closed,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    User,
    SourceClosed,
    ClientDisconnected,
    Shutdown,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub session_id: Option<String>,
    pub source: Option<CaptureSource>,
    pub state: CaptureState,
    pub frames: u64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub elapsed_ms: u64,
    pub last_frame_age_ms: Option<u64>,
    pub stop_reason: Option<StopReason>,
    pub error: Option<String>,
}

#[derive(Default)]
struct Frames {
    count: u64,
    width: u32,
    height: u32,
    last: Option<Instant>,
    closed: bool,
}

trait Session {
    fn is_finished(&self) -> bool;
    /// Called on the service worker, never while holding the frame statistics lock.
    fn stop(self: Box<Self>) -> Result<()>;
}

trait Backend {
    fn supported(&self) -> bool;
    fn sources(&self) -> Result<Vec<CaptureSource>>;
    fn start(&self, source: &CaptureSource, frames: Arc<Mutex<Frames>>)
        -> Result<Box<dyn Session>>;
}

struct Active {
    session: Box<dyn Session>,
    frames: Arc<Mutex<Frames>>,
    started: Instant,
    heartbeat: Instant,
    sampled: Instant,
    sampled_count: u64,
}

struct Engine<B> {
    backend: B,
    active: Option<Active>,
    status: CaptureStatus,
    next_id: u64,
}

impl<B: Backend> Engine<B> {
    fn new(backend: B) -> Self {
        Self {
            backend,
            active: None,
            status: CaptureStatus::default(),
            next_id: 0,
        }
    }

    fn start(&mut self, source_id: &str, now: Instant) -> Result<CaptureStatus> {
        self.tick(now);
        if self.active.is_some() {
            return Err("A capture session is already running".into());
        }
        // Re-enumerate rather than accepting a caller-provided native window handle.
        let source = self
            .backend
            .sources()?
            .into_iter()
            .find(|s| s.id == source_id)
            .ok_or("The capture source is no longer available; refresh the source list")?;
        let frames = Arc::new(Mutex::new(Frames::default()));
        let session = self.backend.start(&source, frames.clone())?;
        let started = Instant::now();
        self.next_id += 1;
        self.status = CaptureStatus {
            session_id: Some(self.next_id.to_string()),
            source: Some(source),
            state: CaptureState::Running,
            ..CaptureStatus::default()
        };
        self.active = Some(Active {
            session,
            frames,
            started,
            heartbeat: started,
            sampled: started,
            sampled_count: 0,
        });
        Ok(self.status.clone())
    }

    fn sample(&mut self, now: Instant) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        let frames = active.frames.lock().unwrap_or_else(|e| e.into_inner());
        self.status.frames = frames.count;
        self.status.width = frames.width;
        self.status.height = frames.height;
        self.status.elapsed_ms = now.saturating_duration_since(active.started).as_millis() as u64;
        self.status.last_frame_age_ms = frames
            .last
            .map(|t| now.saturating_duration_since(t).as_millis() as u64);
        let seconds = now.saturating_duration_since(active.sampled).as_secs_f64();
        if seconds >= 0.5 {
            self.status.fps = (frames.count - active.sampled_count) as f64 / seconds;
            active.sampled = now;
            active.sampled_count = frames.count;
        }
    }

    fn stop_active(&mut self, reason: StopReason, now: Instant) {
        self.sample(now);
        if let Some(active) = self.active.take() {
            let result = active.session.stop();
            self.status.state = match (&result, reason) {
                (Err(_), _) => CaptureState::Failed,
                (_, StopReason::SourceClosed) => CaptureState::Closed,
                _ => CaptureState::Stopped,
            };
            self.status.error = result.err();
            self.status.stop_reason = Some(reason);
            self.status.fps = 0.0;
        }
    }

    fn tick(&mut self, now: Instant) {
        let reason = self.active.as_ref().and_then(|active| {
            let closed = active
                .frames
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .closed;
            if closed || active.session.is_finished() {
                Some(StopReason::SourceClosed)
            } else if now.saturating_duration_since(active.heartbeat) >= LEASE {
                Some(StopReason::ClientDisconnected)
            } else {
                None
            }
        });
        if let Some(reason) = reason {
            self.stop_active(reason, now);
        }
    }

    fn status(&mut self, id: &str, now: Instant) -> Result<CaptureStatus> {
        self.tick(now);
        if self.status.session_id.as_deref() != Some(id) {
            return Err("This capture session is no longer current".into());
        }
        if let Some(active) = self.active.as_mut() {
            active.heartbeat = now;
        }
        self.sample(now);
        Ok(self.status.clone())
    }

    fn stop(&mut self, id: &str, now: Instant) -> Result<CaptureStatus> {
        if self.status.session_id.as_deref() != Some(id) {
            return Err("This capture session is no longer current".into());
        }
        self.stop_active(StopReason::User, now);
        Ok(self.status.clone())
    }
}

enum Command {
    Supported(mpsc::Sender<bool>),
    Sources(mpsc::Sender<Result<Vec<CaptureSource>>>),
    Start(String, mpsc::Sender<Result<CaptureStatus>>),
    Status(String, mpsc::Sender<Result<CaptureStatus>>),
    Stop(String, mpsc::Sender<Result<CaptureStatus>>),
    Shutdown,
}

/// Serializes native operations and reaps sessions even if the UI disappears.
/// Blocking methods must be called off the UI thread. Poll `status` while owning a session.
pub struct CaptureService {
    commands: mpsc::Sender<Command>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl CaptureService {
    pub fn new() -> std::io::Result<Self> {
        let (commands, receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("weblink-capture".into())
            .spawn(move || {
                let mut engine = Engine::new(backend::NativeBackend);
                loop {
                    engine.tick(Instant::now());
                    match receiver.recv_timeout(Duration::from_millis(250)) {
                        Ok(Command::Supported(reply)) => {
                            let _ = reply.send(engine.backend.supported());
                        }
                        Ok(Command::Sources(reply)) => {
                            let _ = reply.send(engine.backend.sources());
                        }
                        Ok(Command::Start(id, reply)) => {
                            let result = engine.start(&id, Instant::now());
                            let started = result.is_ok();
                            // A cancelled start cannot leave an unowned capture running.
                            if reply.send(result).is_err() && started {
                                engine.stop_active(StopReason::ClientDisconnected, Instant::now());
                            }
                        }
                        Ok(Command::Status(id, reply)) => {
                            let _ = reply.send(engine.status(&id, Instant::now()));
                        }
                        Ok(Command::Stop(id, reply)) => {
                            let _ = reply.send(engine.stop(&id, Instant::now()));
                        }
                        Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                }
                engine.stop_active(StopReason::Shutdown, Instant::now());
            })?;
        Ok(Self {
            commands,
            worker: Mutex::new(Some(worker)),
        })
    }

    fn request<T>(&self, command: impl FnOnce(mpsc::Sender<T>) -> Command) -> Result<T> {
        let (reply, receiver) = mpsc::channel();
        self.commands
            .send(command(reply))
            .map_err(|_| "Capture service has stopped")?;
        receiver
            .recv()
            .map_err(|_| "Capture service has stopped".into())
    }

    pub fn supported(&self) -> bool {
        self.request(Command::Supported).unwrap_or(false)
    }
    pub fn sources(&self) -> Result<Vec<CaptureSource>> {
        self.request(Command::Sources)?
    }
    pub fn start(&self, source_id: String) -> Result<CaptureStatus> {
        self.request(|r| Command::Start(source_id, r))?
    }
    pub fn status(&self, session_id: String) -> Result<CaptureStatus> {
        self.request(|r| Command::Status(session_id, r))?
    }
    pub fn stop(&self, session_id: String) -> Result<CaptureStatus> {
        self.request(|r| Command::Stop(session_id, r))?
    }

    pub fn shutdown(&self) {
        let _ = self.commands.send(Command::Shutdown);
        if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = worker.join();
        }
    }
}

impl Drop for CaptureService {
    fn drop(&mut self) {
        self.shutdown();
    }
}
