use crate::{Frames, Result, Session};
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

fn thumbnail_border() -> Result<DrawBorderSettings> {
    if !GraphicsCaptureApi::is_border_settings_supported().map_err(|e| e.to_string())? {
        return Err("This Windows version does not support borderless previews".into());
    }
    // WithoutBorder alone can be silently ignored when access is denied.
    // Obtain OS approval before starting any temporary WGC session.
    let request = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)
        .map_err(|e| e.to_string())?;
    let (reply, access) = mpsc::sync_channel(1);
    request
        .when(move |result| {
            let _ = reply.send(result);
        })
        .map_err(|e| e.to_string())?;
    let status = match access.recv_timeout(Duration::from_secs(2)) {
        Ok(result) => result.map_err(|e| e.to_string())?,
        Err(_) => {
            let _ = request.Cancel();
            return Err("Borderless preview access timed out".into());
        }
    };
    if status != AppCapabilityAccessStatus::Allowed {
        return Err("Windows did not allow borderless previews".into());
    }
    Ok(DrawBorderSettings::WithoutBorder)
}

pub(super) fn start<T: TryInto<GraphicsCaptureItemType> + Send + 'static>(
    item: T,
    frames: Arc<Mutex<Frames>>,
) -> Result<Box<dyn Session>> {
    let thumbnail = frames.lock().unwrap_or_else(|e| e.into_inner()).thumbnail;
    let border = if thumbnail {
        thumbnail_border()?
    } else {
        DrawBorderSettings::Default
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
        frames,
    );
    let control = Handler::start_free_threaded(settings).map_err(|e| e.to_string())?;
    Ok(Box::new(WindowsSession(control)))
}

struct WindowsSession(CaptureControl<Handler, String>);
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
        self.0.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
        Ok(())
    }
}
