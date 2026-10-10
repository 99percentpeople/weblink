//! Native screen capture. Streaming pixels stay in Rust; picker snapshots are bounded PNGs.
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

mod backend;
mod cursor;
// Production event producers are Windows-only until another native backend exists.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
mod lifecycle;
mod observers;
pub use observers::StatusObserver;
pub mod geometry;
pub mod media;
#[cfg(windows)]
pub mod surface;
#[cfg(test)]
mod tests;

const MAX_SESSIONS: usize = 16;
const MAX_RETIRED_SESSIONS: usize = 32;
// Renderer pauses must not destroy an explicitly active share after a few missed
// lease renewals. Explicit stop/window teardown still release immediately.
const LEASE: Duration = Duration::from_secs(60);
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

/// Capture selection is independent of encoding and transport.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureMethod {
    #[default]
    Auto,
    Wgc,
    Dxgi,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureOptions {
    pub backend: CaptureMethod,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureBackendInfo {
    pub id: CaptureMethod,
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCapabilities {
    pub screen: Vec<CaptureBackendInfo>,
    pub window: Vec<CaptureBackendInfo>,
}
impl CaptureCapabilities {
    fn methods(&self, kind: SourceKind) -> &[CaptureBackendInfo] {
        match kind {
            SourceKind::Monitor => &self.screen,
            SourceKind::Window => &self.window,
        }
    }
    fn resolve(&self, kind: SourceKind, requested: CaptureMethod) -> Result<CaptureMethod> {
        self.methods(kind)
            .iter()
            .find(|method| requested == CaptureMethod::Auto || requested == method.id)
            .map(|method| method.id)
            .ok_or_else(|| "Selected capture backend is unavailable for this source type".into())
    }
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
    pub backend: Option<CaptureMethod>,
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
    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    changed: lifecycle::Changed,
    /// Apply before capture starts, so queued startup frames cannot contain a cursor.
    cursor_hidden: bool,
    media: Option<Arc<media::MediaSession>>,
    #[cfg(windows)]
    sink: Option<Arc<dyn surface::FrameSink>>,
    /// Picker snapshots must not introduce WGC's capture indicator.
    #[cfg(windows)]
    thumbnail: bool,
}

#[cfg(any(windows, test))]
impl Frames {
    fn arrived(&mut self, width: u32, height: u32, now: Instant) {
        self.count += 1;
        self.last = Some(now);
        if (self.width, self.height) != (width, height) {
            (self.width, self.height) = (width, height);
            self.changed.notify();
        }
    }
    fn finish(&mut self) {
        if !std::mem::replace(&mut self.closed, true) {
            self.changed.notify();
        }
    }
}

trait Session {
    fn is_finished(&self) -> bool;
    fn cursor_visibility_supported(&self) -> bool {
        false
    }
    fn set_cursor_visible(&self, _: bool) -> Result<()> {
        Err("Cursor visibility is unavailable for this capture".into())
    }
    /// Publish a retained startup frame after attaching a replacement session's sink.
    fn flush_pending_frame(&self) -> Result<()> {
        Ok(())
    }
    /// Called on the service worker, never while holding the frame statistics lock.
    fn stop(self: Box<Self>) -> Result<()>;
}

trait Backend {
    fn supported(&self) -> bool;
    /// Reuse the engine's running backend rather than probing an already-owned resource.
    fn capabilities(&self, running: Option<CaptureMethod>) -> CaptureCapabilities;

    fn display_refresh_rates(&self) -> Vec<u32> {
        Vec::new()
    }
    fn sources(&self) -> Result<Vec<CaptureSource>>;
    fn displays(&self) -> Result<Vec<geometry::DisplayGeometry>> {
        Err("Display geometry is unavailable on this platform".into())
    }
    #[cfg(windows)]
    fn thumbnail(&self, _: &CaptureSource) -> Result<Vec<u8>> {
        Err("This backend does not provide source snapshots".into())
    }
    fn start(
        &self,
        source: &CaptureSource,
        method: CaptureMethod,
        frames: Arc<Mutex<Frames>>,
    ) -> Result<Box<dyn Session>>;
}

struct Active {
    status: CaptureStatus,
    /// Preserve the user's choice separately from the currently running backend.
    requested_backend: CaptureMethod,
    session: Box<dyn Session>,
    frames: Arc<Mutex<Frames>>,
    started: Instant,
    heartbeat: Instant,
    sampled: Instant,
    sampled_count: u64,
}

struct Opened {
    session: Box<dyn Session>,
    source: CaptureSource,
    method: CaptureMethod,
}

struct Engine<B> {
    backend: B,
    active: HashMap<String, Active>,
    stopped: VecDeque<CaptureStatus>,
    next_id: u64,
    layout: geometry::LayoutTracker,
    observers: observers::Observers,
    changed: lifecycle::Changed,
}

impl<B: Backend> Engine<B> {
    fn new(backend: B) -> Self {
        Self {
            backend,
            active: HashMap::new(),
            stopped: VecDeque::new(),
            next_id: 0,
            layout: geometry::LayoutTracker::default(),
            observers: Default::default(),
            changed: Default::default(),
        }
    }

    fn capabilities(&self) -> CaptureCapabilities {
        // The retained status also describes stopped sessions. Only an owned,
        // active session is evidence that its backend is currently available.
        let running = self.active.values().filter_map(|a| a.status.backend);
        let running = running
            .clone()
            .find(|method| *method == CaptureMethod::Dxgi)
            .or_else(|| running.clone().next());
        self.backend.capabilities(running)
    }

    fn supported(&self) -> bool {
        !self.active.is_empty() || self.backend.supported()
    }

    fn display_layout(&mut self) -> Result<geometry::DisplayLayout> {
        match self.backend.displays() {
            Ok(displays) => self.layout.update(displays),
            Err(error) => {
                self.layout.invalidate();
                Err(error)
            }
        }
    }

    fn display_geometry(&mut self, id: &str, now: Instant) -> Result<geometry::DisplayLayout> {
        self.tick(now);
        let source = self
            .active
            .get(id)
            .and_then(|active| active.status.source.as_ref())
            .filter(|source| source.kind == SourceKind::Monitor)
            .ok_or("No active display capture for this session")?
            .id
            .clone();
        let layout = self.display_layout()?;
        if !layout
            .displays
            .iter()
            .any(|display| display.source_id == source)
        {
            return Err("Captured display disconnected".into());
        }
        Ok(layout)
    }

    #[cfg(test)]
    fn start(&mut self, source_id: &str, now: Instant) -> Result<CaptureStatus> {
        self.start_media(source_id, now, None, CaptureOptions::default(), None)
    }

    fn start_media(
        &mut self,
        source_id: &str,
        now: Instant,
        media: Option<Arc<media::MediaSession>>,
        options: CaptureOptions,
        sink: Option<CaptureSink>,
    ) -> Result<CaptureStatus> {
        self.tick(now);
        if self.active.len() >= MAX_SESSIONS {
            return Err("Native capture session limit reached".into());
        }
        #[cfg(windows)]
        let sink = sink.or_else(|| media.clone().map(|media| media as CaptureSink));
        #[cfg(not(windows))]
        let _ = sink;
        let frames = Arc::new(Mutex::new(Frames {
            #[cfg(windows)]
            sink,
            media,
            changed: self.changed.clone(),
            ..Frames::default()
        }));
        let Opened {
            session,
            source,
            method,
        } = self.open(source_id, options, frames.clone())?;
        if let Some(media) = &frames.lock().unwrap_or_else(|e| e.into_inner()).media {
            media.set_changed(self.changed.clone());
        }
        let started = Instant::now();
        self.next_id += 1;
        let id = self.next_id.to_string();
        let status = CaptureStatus {
            session_id: Some(id.clone()),
            source: Some(source),
            backend: Some(method),
            state: CaptureState::Running,
            ..CaptureStatus::default()
        };
        self.active.insert(
            id,
            Active {
                status: status.clone(),
                requested_backend: options.backend,
                session,
                frames,
                started,
                heartbeat: started,
                sampled: started,
                sampled_count: 0,
            },
        );
        Ok(status)
    }

    fn open(
        &self,
        source_id: &str,
        options: CaptureOptions,
        frames: Arc<Mutex<Frames>>,
    ) -> Result<Opened> {
        // Re-enumerate rather than accepting a caller-provided native window handle.
        let source = self
            .backend
            .sources()?
            .into_iter()
            .find(|s| s.id == source_id)
            .ok_or("The capture source is no longer available; refresh the source list")?;
        let capabilities = self.capabilities();
        let mut method = capabilities.resolve(source.kind, options.backend)?;
        let mut result = self.backend.start(&source, method, frames.clone());
        if options.backend == CaptureMethod::Auto && result.is_err() {
            // Global discovery can find DXGI on one GPU while another display
            // cannot be duplicated. Auto may try this source's other methods.
            for fallback in capabilities.methods(source.kind).iter().skip(1) {
                method = fallback.id;
                result = self.backend.start(&source, method, frames.clone());
                if result.is_ok() {
                    break;
                }
            }
        }
        Ok(Opened {
            session: result?,
            source,
            method,
        })
    }

    #[cfg(windows)]
    fn thumbnail(&self, source_id: &str, _: CaptureOptions) -> Result<Vec<u8>> {
        // Snapshots have their own path, independent of streaming backend settings.
        // Re-enumerate to reject stale sources and caller-provided raw handles.
        let source = self
            .backend
            .sources()?
            .into_iter()
            .find(|s| s.id == source_id)
            .ok_or("The capture source is no longer available; refresh the source list")?;
        self.backend.thumbnail(&source)
    }

    #[cfg(not(windows))]
    fn thumbnail(&self, _: &str, _: CaptureOptions) -> Result<Vec<u8>> {
        Err("Native capture is currently available on Windows only".into())
    }

    fn sample(active: &mut Active, now: Instant) {
        let frames = active.frames.lock().unwrap_or_else(|e| e.into_inner());
        let status = &mut active.status;
        status.frames = frames.count;
        status.width = frames.width;
        status.height = frames.height;
        status.elapsed_ms = now.saturating_duration_since(active.started).as_millis() as u64;
        status.last_frame_age_ms = frames
            .last
            .map(|t| now.saturating_duration_since(t).as_millis() as u64);
        let seconds = now.saturating_duration_since(active.sampled).as_secs_f64();
        if seconds >= 0.5 {
            status.fps = (frames.count - active.sampled_count) as f64 / seconds;
            active.sampled = now;
            active.sampled_count = frames.count;
        }
    }

    fn stop_session(&mut self, id: &str, reason: StopReason, now: Instant) {
        let Some(mut active) = self.active.remove(id) else {
            return;
        };
        Self::sample(&mut active, now);
        let media = active
            .frames
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .media
            .clone();
        let media_error = media.as_ref().and_then(|m| m.error());
        if let Some(media) = media {
            media.set_changed(Default::default());
            media.close();
        }
        let result = active
            .session
            .stop()
            .and_then(|()| media_error.map_or(Ok(()), Err));
        active.status.state = match (&result, reason) {
            (Err(_), _) => CaptureState::Failed,
            (_, StopReason::SourceClosed) => CaptureState::Closed,
            _ => CaptureState::Stopped,
        };
        active.status.error = result.err();
        active.status.stop_reason = Some(reason);
        active.status.fps = 0.0;
        self.observers.notify(&active.status);
        self.stopped.push_back(active.status);
        while self.stopped.len() > MAX_RETIRED_SESSIONS {
            self.stopped.pop_front();
        }
    }

    fn stop_all(&mut self, reason: StopReason, now: Instant) {
        for id in self.active.keys().cloned().collect::<Vec<_>>() {
            self.stop_session(&id, reason, now);
        }
    }

    fn tick(&mut self, now: Instant) {
        let ended: Vec<_> = self
            .active
            .iter()
            .filter_map(|(id, active)| {
                let frames = active.frames.lock().unwrap_or_else(|e| e.into_inner());
                let closed =
                    frames.closed || frames.media.as_ref().and_then(|m| m.error()).is_some();
                drop(frames);
                let reason = if closed || active.session.is_finished() {
                    StopReason::SourceClosed
                } else if now.saturating_duration_since(active.heartbeat) >= LEASE {
                    StopReason::ClientDisconnected
                } else {
                    return None;
                };
                Some((id.clone(), reason))
            })
            .collect();
        for (id, reason) in ended {
            self.stop_session(&id, reason, now);
        }
        for active in self.active.values_mut() {
            Self::sample(active, now);
            self.observers.notify(&active.status);
        }
    }

    fn deadline(&self) -> Option<Instant> {
        self.active.values().map(|a| a.heartbeat + LEASE).min()
    }

    fn status(&mut self, id: &str, now: Instant) -> Result<CaptureStatus> {
        self.tick(now);
        if let Some(active) = self.active.get_mut(id) {
            Self::sample(active, now);
            return Ok(active.status.clone());
        }
        self.stopped
            .iter()
            .find(|s| s.session_id.as_deref() == Some(id))
            .cloned()
            .ok_or_else(|| "This capture session is no longer current".into())
    }

    fn renew(&mut self, id: &str, now: Instant) -> Result<()> {
        self.tick(now);
        let active = self.active.get_mut(id).ok_or("Capture session ended")?;
        active.heartbeat = now;
        Ok(())
    }

    fn watch(
        &mut self,
        id: &str,
        watch_id: String,
        observer: StatusObserver,
        now: Instant,
    ) -> Result<()> {
        let status = self.status(id, now)?;
        self.observers.watch(watch_id, status, observer)
    }

    fn stop(&mut self, id: &str, now: Instant) -> Result<CaptureStatus> {
        self.stop_session(id, StopReason::User, now);
        self.status(id, now)
    }

    fn media(&self, id: &str) -> Result<Arc<media::MediaSession>> {
        self.active
            .get(id)
            .and_then(|a| {
                a.frames
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .media
                    .clone()
            })
            .ok_or_else(|| "Native share is no longer active".to_string())
    }

    fn reply_started(
        &mut self,
        result: Result<CaptureStatus>,
        reply: mpsc::Sender<Result<CaptureStatus>>,
    ) {
        // Cancellation belongs to this request; it must never stop other captures.
        if let Err(mpsc::SendError(Ok(status))) = reply.send(result) {
            if let Some(id) = status.session_id {
                self.stop_session(&id, StopReason::ClientDisconnected, Instant::now());
            }
        }
    }
}

#[cfg(windows)]
type CaptureSink = Arc<dyn surface::FrameSink>;
#[cfg(not(windows))]
type CaptureSink = ();

enum Command {
    Changed,
    CursorSupported(String, mpsc::Sender<bool>),
    CursorVisible(String, bool, mpsc::Sender<Result<()>>),
    DisplayLayout(mpsc::Sender<Result<geometry::DisplayLayout>>),
    DisplayGeometry(String, mpsc::Sender<Result<geometry::DisplayLayout>>),
    Capabilities(mpsc::Sender<CaptureCapabilities>),
    Supported(mpsc::Sender<bool>),
    DisplayRefreshRates(mpsc::Sender<Vec<u32>>),
    Sources(mpsc::Sender<Result<Vec<CaptureSource>>>),
    Thumbnail(String, CaptureOptions, mpsc::Sender<Result<Vec<u8>>>),
    Start(
        String,
        CaptureOptions,
        Option<CaptureSink>,
        mpsc::Sender<Result<CaptureStatus>>,
    ),
    StartMedia(
        String,
        Arc<media::MediaSession>,
        CaptureOptions,
        mpsc::Sender<Result<CaptureStatus>>,
    ),
    Media(String, mpsc::Sender<Result<Arc<media::MediaSession>>>),
    Status(String, mpsc::Sender<Result<CaptureStatus>>),
    Renew(String, mpsc::Sender<Result<()>>),
    Watch(String, String, StatusObserver, mpsc::Sender<Result<()>>),
    Unwatch(String),
    ClearWatches,
    Stop(String, mpsc::Sender<Result<CaptureStatus>>),
    Shutdown,
}

/// Serializes native operations and reaps sessions even if the UI disappears.
/// Blocking methods must be called off the UI thread. Renew while owning a session;
/// status reads and observers never extend its lease.
pub struct CaptureService {
    commands: mpsc::Sender<Command>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

fn receive_command<T>(
    receiver: &mpsc::Receiver<T>,
    deadline: Option<Instant>,
) -> std::result::Result<T, mpsc::RecvTimeoutError> {
    if let Some(deadline) = deadline {
        receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
    } else {
        // Commands, including shutdown and a new capture, wake an idle service.
        receiver
            .recv()
            .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
    }
}

impl CaptureService {
    pub fn new() -> std::io::Result<Self> {
        Self::with_backend(backend::NativeBackend::new)
    }

    fn with_backend<B: Backend + 'static>(
        create: impl FnOnce() -> B + Send + 'static,
    ) -> std::io::Result<Self> {
        let (commands, receiver) = mpsc::channel();
        let events = commands.clone();
        let changed = lifecycle::Changed::new(move || {
            let _ = events.send(Command::Changed);
        });
        let worker = thread::Builder::new()
            .name("weblink-capture".into())
            .spawn(move || {
                let mut engine = Engine::new(create());
                engine.changed = changed;
                loop {
                    engine.tick(Instant::now());
                    match receive_command(&receiver, engine.deadline()) {
                        Ok(Command::Changed) => engine.changed.acknowledge(),
                        Ok(Command::CursorSupported(id, reply)) => {
                            let _ = reply.send(
                                engine
                                    .active
                                    .get(&id)
                                    .is_some_and(|a| a.session.cursor_visibility_supported()),
                            );
                        }
                        Ok(Command::CursorVisible(id, visible, reply)) => {
                            let _ = reply.send(engine.set_cursor_visible(&id, visible));
                        }
                        Ok(Command::DisplayLayout(reply)) => {
                            let _ = reply.send(engine.display_layout());
                        }
                        Ok(Command::DisplayGeometry(id, reply)) => {
                            let _ = reply.send(engine.display_geometry(&id, Instant::now()));
                        }
                        Ok(Command::Capabilities(reply)) => {
                            let _ = reply.send(engine.capabilities());
                        }
                        Ok(Command::Supported(reply)) => {
                            let _ = reply.send(engine.supported());
                        }
                        Ok(Command::DisplayRefreshRates(reply)) => {
                            let _ = reply.send(engine.backend.display_refresh_rates());
                        }
                        Ok(Command::Sources(reply)) => {
                            let _ = reply.send(engine.backend.sources());
                        }
                        Ok(Command::Thumbnail(id, options, reply)) => {
                            let _ = reply.send(engine.thumbnail(&id, options));
                        }
                        Ok(Command::Start(id, options, sink, reply)) => {
                            let result =
                                engine.start_media(&id, Instant::now(), None, options, sink);
                            engine.reply_started(result, reply);
                        }
                        Ok(Command::Status(id, reply)) => {
                            let _ = reply.send(engine.status(&id, Instant::now()));
                        }
                        Ok(Command::Renew(id, reply)) => {
                            let _ = reply.send(engine.renew(&id, Instant::now()));
                        }
                        Ok(Command::Watch(id, watch_id, observer, reply)) => {
                            let result =
                                engine.watch(&id, watch_id.clone(), observer, Instant::now());
                            if reply.send(result).is_err() {
                                engine.observers.unwatch(&watch_id);
                            }
                        }
                        Ok(Command::Unwatch(id)) => engine.observers.unwatch(&id),
                        Ok(Command::ClearWatches) => engine.observers.clear(),
                        Ok(Command::StartMedia(id, media, options, reply)) => {
                            let result =
                                engine.start_media(&id, Instant::now(), Some(media), options, None);
                            engine.reply_started(result, reply);
                        }
                        Ok(Command::Media(id, reply)) => {
                            let _ = reply.send(engine.media(&id));
                        }
                        Ok(Command::Stop(id, reply)) => {
                            let _ = reply.send(engine.stop(&id, Instant::now()));
                        }
                        Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                }
                engine.stop_all(StopReason::Shutdown, Instant::now());
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

    pub fn capabilities(&self) -> Result<CaptureCapabilities> {
        self.request(Command::Capabilities)
    }
    pub fn supported(&self) -> bool {
        self.request(Command::Supported).unwrap_or(false)
    }
    pub fn display_refresh_rates(&self) -> Vec<u32> {
        self.request(Command::DisplayRefreshRates)
            .unwrap_or_default()
    }
    pub fn sources(&self) -> Result<Vec<CaptureSource>> {
        self.request(Command::Sources)?
    }
    /// Read-only inventory. Does not start capture or renew a capture lease.
    pub fn display_layout(&self) -> Result<geometry::DisplayLayout> {
        self.request(Command::DisplayLayout)?
    }
    /// Native consumers must re-resolve an active display session before authorizing input.
    /// This query does not renew the capture lease and cannot authorize control itself.
    pub fn display_geometry(&self, session_id: String) -> Result<geometry::DisplayLayout> {
        self.request(|reply| Command::DisplayGeometry(session_id, reply))?
    }
    /// One PNG snapshot, at most 640x360, without changing an active capture.
    pub fn thumbnail(&self, source_id: String, options: CaptureOptions) -> Result<Vec<u8>> {
        self.request(|r| Command::Thumbnail(source_id, options, r))?
    }
    pub fn start(&self, source_id: String) -> Result<CaptureStatus> {
        self.start_with_options(source_id, CaptureOptions::default())
    }
    pub fn start_with_options(
        &self,
        source_id: String,
        options: CaptureOptions,
    ) -> Result<CaptureStatus> {
        self.request(|r| Command::Start(source_id, options, None, r))?
    }
    /// Native consumers (including remote desktop) can reuse capture without a WebRTC session.
    #[cfg(windows)]
    pub fn start_with_sink(
        &self,
        source_id: String,
        options: CaptureOptions,
        sink: Arc<dyn surface::FrameSink>,
    ) -> Result<CaptureStatus> {
        self.request(|r| Command::Start(source_id, options, Some(sink), r))?
    }
    pub fn status(&self, session_id: String) -> Result<CaptureStatus> {
        self.request(|r| Command::Status(session_id, r))?
    }
    pub fn renew(&self, session_id: String) -> Result<()> {
        self.request(|r| Command::Renew(session_id, r))?
    }
    pub fn watch(
        &self,
        session_id: String,
        watch_id: String,
        observer: StatusObserver,
    ) -> Result<()> {
        self.request(|r| Command::Watch(session_id, watch_id, observer, r))?
    }
    pub fn unwatch(&self, watch_id: String) {
        let _ = self.commands.send(Command::Unwatch(watch_id));
    }
    pub fn clear_watches(&self) {
        let _ = self.commands.send(Command::ClearWatches);
    }
    pub fn start_media(
        &self,
        source_id: String,
        media: Arc<media::MediaSession>,
    ) -> Result<CaptureStatus> {
        self.start_media_with_options(source_id, media, CaptureOptions::default())
    }
    pub fn start_media_with_options(
        &self,
        source_id: String,
        media: Arc<media::MediaSession>,
        options: CaptureOptions,
    ) -> Result<CaptureStatus> {
        self.request(|r| Command::StartMedia(source_id, media, options, r))?
    }
    pub fn media(&self, session_id: String) -> Result<Arc<media::MediaSession>> {
        self.request(|r| Command::Media(session_id, r))?
    }
    pub fn cursor_visibility_supported(&self, session_id: String) -> bool {
        self.request(|r| Command::CursorSupported(session_id, r))
            .unwrap_or(false)
    }
    /// Changes the shared video only; the host's physical cursor remains visible.
    pub fn set_cursor_visible(&self, session_id: String, visible: bool) -> Result<()> {
        self.request(|r| Command::CursorVisible(session_id, visible, r))?
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
