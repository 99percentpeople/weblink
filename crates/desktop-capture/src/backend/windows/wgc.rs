use crate::{Frames, Result, Session};
mod display;
mod exit;
pub(super) use display::start as start_display;
use std::{
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use windows::{
    Graphics::Capture::{GraphicsCaptureAccess, GraphicsCaptureAccessKind},
    Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus,
};
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl},
    settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    },
};

pub(super) fn supported() -> bool {
    GraphicsCaptureApi::is_supported().unwrap_or(false)
}

fn borderless_capture(timeout: Duration) -> Result<DrawBorderSettings> {
    if !GraphicsCaptureApi::is_border_settings_supported().map_err(|e| e.to_string())? {
        return Err("This Windows version does not support borderless capture".into());
    }
    // WithoutBorder alone can be silently ignored when access is denied.
    // Obtain OS approval before requesting a borderless WGC session.
    let request = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)
        .map_err(|e| e.to_string())?;
    let (reply, access) = mpsc::sync_channel(1);
    request
        .when(move |result| {
            let _ = reply.send(result);
        })
        .map_err(|e| e.to_string())?;
    let status = match access.recv_timeout(timeout) {
        Ok(result) => result.map_err(|e| e.to_string())?,
        Err(_) => {
            let _ = request.Cancel();
            return Err("Borderless capture access timed out".into());
        }
    };
    if status != AppCapabilityAccessStatus::Allowed {
        return Err("Windows did not allow borderless capture".into());
    }
    Ok(DrawBorderSettings::WithoutBorder)
}

pub(super) fn start<T: TryInto<GraphicsCaptureItemType> + Send + 'static>(
    item: T,
    frames: Arc<Mutex<Frames>>,
) -> Result<Box<dyn Session>> {
    let thumbnail = frames.lock().unwrap_or_else(|e| e.into_inner()).thumbnail;
    let border = if thumbnail {
        borderless_capture(Duration::from_secs(2))?
    } else {
        // Older Windows versions and denied OS access must not break sharing.
        // Temporary thumbnails still fail rather than flashing a capture border.
        borderless_capture(Duration::from_secs(30)).unwrap_or(DrawBorderSettings::Default)
    };
    // The default WGC interval can undershoot 60 fps on high-refresh displays.
    // Let WGC deliver updates promptly and pace conversion in MediaSession.
    // This property is unavailable on older Windows versions.
    let minimum_update_interval =
        if GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false) {
            MinimumUpdateIntervalSettings::Custom(Duration::from_millis(1))
        } else {
            MinimumUpdateIntervalSettings::Default
        };
    let settings = Settings::new(
        item,
        CursorCaptureSettings::Default,
        border,
        SecondaryWindowSettings::Default,
        minimum_update_interval,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        frames.clone(),
    );
    let control = Handler::start_free_threaded(settings).map_err(|e| e.to_string())?;
    // The library owns the capture loop; observing the actual thread exit also
    // catches failures that bypass Handler::on_closed (including a panic).
    let callback = control.callback();
    let halt = control.halt_handle();
    let thread = control.into_thread_handle();
    let exited = exit::ThreadExit::new(&thread, frames);
    let control = CaptureControl::new(thread, halt, callback);
    match exited {
        Ok(exited) => Ok(Box::new(WindowsSession {
            control: Some(control),
            exited: Some(exited),
        })),
        Err(error) => {
            let _ = control.stop();
            Err(error)
        }
    }
}

struct WindowsSession {
    control: Option<CaptureControl<Handler, String>>,
    exited: Option<exit::ThreadExit>,
}
impl WindowsSession {
    fn close(&mut self) -> Result<()> {
        // Cancel/join callbacks before joining the capture thread or freeing its state.
        self.exited.take();
        self.control
            .take()
            .map_or(Ok(()), |control| control.stop().map_err(|e| e.to_string()))
    }
}
impl Session for WindowsSession {
    fn is_finished(&self) -> bool {
        self.control.as_ref().is_none_or(|c| c.is_finished())
    }
    fn stop(mut self: Box<Self>) -> Result<()> {
        self.close()
    }
}
impl Drop for WindowsSession {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

struct Handler(Arc<Mutex<Frames>>);
impl GraphicsCaptureApiHandler for Handler {
    type Flags = Arc<Mutex<Frames>>;
    type Error = String;
    fn new(ctx: Context<Self::Flags>) -> std::result::Result<Self, Self::Error> {
        Ok(Self(ctx.flags))
    }
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> std::result::Result<(), Self::Error> {
        Frames::deliver(
            &self.0,
            crate::surface::TextureFrame {
                device: frame.device(),
                context: frame.device_context(),
                texture: frame.as_raw_texture(),
                rotation: crate::surface::Rotation::Identity,
                cursor: None,
            },
        )?;
        if self.0.lock().unwrap_or_else(|e| e.into_inner()).thumbnail {
            control.stop();
        }
        Ok(())
    }
    fn on_closed(&mut self) -> std::result::Result<(), Self::Error> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).finish();
        Ok(())
    }
}
