use crate::{Backend, CaptureSource, Frames, Result, Session, SourceKind};
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
    time::Instant,
};
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl},
    monitor::Monitor,
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
    window::Window,
};

pub(crate) struct NativeBackend;

fn monitor_id(m: Monitor) -> String {
    format!(
        "monitor:{:x}:{}",
        m.as_raw_hmonitor() as usize,
        m.device_name().unwrap_or_default()
    )
}
fn window_id(w: Window) -> Option<String> {
    Some(format!(
        "window:{:x}:{}",
        w.as_raw_hwnd() as usize,
        w.process_id().ok()?
    ))
}

impl Backend for NativeBackend {
    fn supported(&self) -> bool {
        // This is the dedicated service thread, not the WebView's STA thread.
        if unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_err() {
            return false;
        }
        let supported = GraphicsCaptureApi::is_supported().unwrap_or(false);
        unsafe { RoUninitialize() };
        supported
    }

    fn sources(&self) -> Result<Vec<CaptureSource>> {
        let mut sources = Vec::new();
        for (i, m) in Monitor::enumerate()
            .map_err(|e| e.to_string())?
            .into_iter()
            .enumerate()
        {
            sources.push(CaptureSource {
                id: monitor_id(m),
                kind: SourceKind::Monitor,
                name: m.name().unwrap_or_else(|_| format!("Display {}", i + 1)),
                width: m.width().unwrap_or(0),
                height: m.height().unwrap_or(0),
            });
        }
        for w in Window::enumerate().map_err(|e| e.to_string())? {
            let (Some(id), Ok(name)) = (window_id(w), w.title()) else {
                continue;
            };
            if name.trim().is_empty() {
                continue;
            }
            sources.push(CaptureSource {
                id,
                kind: SourceKind::Window,
                name,
                width: w.width().unwrap_or(0).max(0) as u32,
                height: w.height().unwrap_or(0).max(0) as u32,
            });
        }
        Ok(sources)
    }

    fn start(
        &self,
        source: &CaptureSource,
        frames: Arc<Mutex<Frames>>,
    ) -> Result<Box<dyn Session>> {
        // Re-check identity immediately before creating the WinRT item on the capture thread.
        match source.kind {
            SourceKind::Monitor => {
                let item = Monitor::enumerate()
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .find(|m| monitor_id(*m) == source.id)
                    .ok_or("Display disconnected")?;
                start(item, frames)
            }
            SourceKind::Window => {
                let item = Window::enumerate()
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .find(|w| window_id(*w).as_deref() == Some(&source.id))
                    .ok_or("Window closed")?;
                start(item, frames)
            }
        }
    }
}

fn start<T: TryInto<GraphicsCaptureItemType> + Send + 'static>(
    item: T,
    frames: Arc<Mutex<Frames>>,
) -> Result<Box<dyn Session>> {
    let settings = Settings::new(
        item,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        frames,
    );
    let control = Handler::start_free_threaded(settings).map_err(|e| e.to_string())?;
    Ok(Box::new(WindowsSession(control)))
}

struct WindowsSession(CaptureControl<Handler, Infallible>);
impl Session for WindowsSession {
    fn is_finished(&self) -> bool {
        self.0.is_finished()
    }
    fn stop(self: Box<Self>) -> Result<()> {
        self.0.stop().map_err(|e| e.to_string())
    }
}

struct Handler(Arc<Mutex<Frames>>);
impl GraphicsCaptureApiHandler for Handler {
    type Flags = Arc<Mutex<Frames>>;
    type Error = Infallible;
    fn new(ctx: Context<Self::Flags>) -> std::result::Result<Self, Self::Error> {
        Ok(Self(ctx.flags))
    }
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        _: InternalCaptureControl,
    ) -> std::result::Result<(), Self::Error> {
        let mut stats = self.0.lock().unwrap_or_else(|e| e.into_inner());
        stats.count += 1;
        stats.width = frame.width();
        stats.height = frame.height();
        stats.last = Some(Instant::now());
        // No CPU mapping, encoding, IPC pixels or persistence in this prototype.
        Ok(())
    }
    fn on_closed(&mut self) -> std::result::Result<(), Self::Error> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
        Ok(())
    }
}
