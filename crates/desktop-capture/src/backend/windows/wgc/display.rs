//! Display WGC retains its session so cursor capture can change without restarting video.
use crate::{
    surface::{readback::Readback, Rotation, TextureFrame},
    Frames, Result, Session,
};
use std::sync::{Arc, Mutex};
use windows::{
    core::Interface,
    Foundation::TypedEventHandler,
    Graphics::{
        Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession},
        DirectX::DirectXPixelFormat,
    },
    Win32::{
        Graphics::Direct3D11::{ID3D11Multithread, ID3D11Texture2D},
        System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess,
    },
};
use windows_capture::{
    d3d11::{create_d3d_device, create_direct3d_device},
    graphics_capture_api::GraphicsCaptureApi,
    monitor::Monitor,
    settings::{DrawBorderSettings, GraphicsCaptureItemType},
};

pub(in super::super) fn start(
    monitor: Monitor,
    frames: Arc<Mutex<Frames>>,
) -> Result<Box<dyn Session>> {
    // Keep compatibility with OS versions without dynamic cursor settings.
    if !GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false) {
        return super::start(monitor, frames);
    }
    let item: GraphicsCaptureItemType = monitor
        .try_into()
        .map_err(|e: windows::core::Error| e.to_string())?;
    let GraphicsCaptureItemType::Monitor((item, _)) = item else {
        return Err("Expected a display capture item".into());
    };
    let (device, context) = create_d3d_device().map_err(|e| e.to_string())?;
    // Frame callbacks and media readback share this immediate context.
    let multithread: ID3D11Multithread = context.cast().map_err(|e| e.to_string())?;
    unsafe {
        let _ = multithread.SetMultithreadProtected(true);
    }
    let direct3d = create_direct3d_device(&device).map_err(|e| e.to_string())?;
    let size = item.Size().map_err(|e| e.to_string())?;
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &direct3d,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        1,
        size,
    )
    .map_err(|e| e.to_string())?;
    let session = pool
        .CreateCaptureSession(&item)
        .map_err(|e| e.to_string())?;
    let cursor_hidden = frames
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .cursor_hidden;
    let pending = Arc::new(Mutex::new(cursor_hidden.then(Readback::default)));
    let mut capture = DisplaySession {
        pool,
        session,
        item,
        frames: frames.clone(),
        arrived: None,
        closed: None,
        pending: pending.clone(),
    };
    // Configure exclusion before StartCapture: changing it afterwards can leave
    // a cursor in frames that were already queued by the compositor.
    capture
        .session
        .SetIsCursorCaptureEnabled(!cursor_hidden)
        .map_err(|e| e.to_string())?;
    if super::borderless_capture(std::time::Duration::from_secs(30))
        .is_ok_and(|setting| setting == DrawBorderSettings::WithoutBorder)
    {
        capture
            .session
            .SetIsBorderRequired(false)
            .map_err(|e| e.to_string())?;
    }
    if GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false) {
        capture
            .session
            .SetMinUpdateInterval(windows::Foundation::TimeSpan { Duration: 10_000 })
            .map_err(|e| e.to_string())?;
    }
    let callback_frames = frames.clone();
    capture.closed = Some(
        capture
            .item
            .Closed(&TypedEventHandler::new(move |_, _| {
                callback_frames
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .closed = true;
                Ok(())
            }))
            .map_err(|e| e.to_string())?,
    );
    let callback_frames = frames;
    // Serialize frame callbacks; no callback owns the session or frame pool.
    let callback_size = Mutex::new(size);
    capture.arrived = Some(
        capture
            .pool
            .FrameArrived(&TypedEventHandler::<
                Direct3D11CaptureFramePool,
                windows::core::IInspectable,
            >::new(move |pool, _| {
                let Some(pool) = pool.as_ref() else {
                    return Ok(());
                };
                let mut current_size = callback_size.lock().unwrap_or_else(|e| e.into_inner());
                if callback_frames
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .closed
                {
                    return Ok(());
                }
                let result = (|| -> Result<()> {
                    let frame = pool.TryGetNextFrame().map_err(|e| e.to_string())?;
                    let result = (|| -> Result<()> {
                        let next_size = frame.ContentSize().map_err(|e| e.to_string())?;
                        if next_size.Width <= 0 || next_size.Height <= 0 {
                            return Ok(());
                        }
                        let surface = frame.Surface().map_err(|e| e.to_string())?;
                        let access: IDirect3DDxgiInterfaceAccess =
                            surface.cast().map_err(|e| e.to_string())?;
                        let texture: ID3D11Texture2D =
                            unsafe { access.GetInterface() }.map_err(|e| e.to_string())?;
                        let texture = TextureFrame {
                            device: &device,
                            context: &context,
                            texture: &texture,
                            rotation: Rotation::Identity,
                            cursor: None,
                        };
                        // Retain one startup GPU frame until DXGI is retired and
                        // the sink attaches, even if the desktop stays static.
                        // Serialize replay with delivery so an older cached frame
                        // cannot overwrite a newer live frame.
                        let mut pending = pending.lock().unwrap_or_else(|e| e.into_inner());
                        if callback_frames
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .sink
                            .is_some()
                        {
                            *pending = None;
                        } else if let Some(retained) = pending.as_mut() {
                            retained.copy(&texture)?;
                        }
                        Frames::deliver(&callback_frames, texture)?;
                        drop(pending);
                        if next_size != *current_size {
                            let direct3d =
                                create_direct3d_device(&device).map_err(|e| e.to_string())?;
                            pool.Recreate(
                                &direct3d,
                                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                                1,
                                next_size,
                            )
                            .map_err(|e| e.to_string())?;
                            *current_size = next_size;
                        }
                        Ok(())
                    })();
                    let _ = frame.Close();
                    result
                })();
                if result.is_err() {
                    callback_frames
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .closed = true;
                }
                Ok(())
            }))
            .map_err(|e| e.to_string())?,
    );
    capture.session.StartCapture().map_err(|e| e.to_string())?;
    Ok(Box::new(capture))
}

struct DisplaySession {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    item: GraphicsCaptureItem,
    frames: Arc<Mutex<Frames>>,
    arrived: Option<i64>,
    closed: Option<i64>,
    pending: Arc<Mutex<Option<Readback>>>,
}
impl Session for DisplaySession {
    fn is_finished(&self) -> bool {
        self.frames.lock().unwrap_or_else(|e| e.into_inner()).closed
    }
    fn cursor_visibility_supported(&self) -> bool {
        true
    }
    fn set_cursor_visible(&self, visible: bool) -> Result<()> {
        self.session
            .SetIsCursorCaptureEnabled(visible)
            .map_err(|e| e.to_string())
    }
    fn flush_pending_frame(&self) -> Result<()> {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let sink = self
            .frames
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sink
            .clone();
        if let (Some(retained), Some(sink)) = (pending.take(), sink) {
            if let Some(frame) = retained.frame() {
                sink.frame(frame)?;
            }
        }
        Ok(())
    }
    fn stop(self: Box<Self>) -> Result<()> {
        Ok(())
    }
}
impl Drop for DisplaySession {
    fn drop(&mut self) {
        self.frames.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
        if let Some(token) = self.arrived.take() {
            let _ = self.pool.RemoveFrameArrived(token);
        }
        if let Some(token) = self.closed.take() {
            let _ = self.item.RemoveClosed(token);
        }
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Requires an unlocked interactive Windows desktop; captures only in memory"]
    fn wgc_hidden_startup_replays_a_retained_frame_when_the_sink_attaches() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Sink(AtomicUsize);
        impl crate::surface::FrameSink for Sink {
            fn frame(&self, frame: TextureFrame<'_>) -> Result<()> {
                assert!(frame.cursor.is_none());
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }
        let _runtime = crate::backend::NativeBackend::new();
        let frames = Arc::new(Mutex::new(Frames {
            cursor_hidden: true,
            ..Default::default()
        }));
        let capture = start(Monitor::primary().unwrap(), frames.clone()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while frames.lock().unwrap().count == 0 {
            assert!(!capture.is_finished());
            assert!(
                std::time::Instant::now() < deadline,
                "No hidden WGC frame arrived"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let sink = Arc::new(Sink(AtomicUsize::new(0)));
        frames.lock().unwrap().sink = Some(sink.clone());
        capture.flush_pending_frame().unwrap();
        assert!(
            sink.0.load(Ordering::SeqCst) > 0,
            "Initial static frame was lost"
        );
        capture.stop().unwrap();
        assert!(frames.lock().unwrap().closed);
    }

    #[test]
    #[ignore = "Requires an unlocked interactive Windows desktop; captures only in memory"]
    fn wgc_display_cursor_toggles_without_restarting_capture() {
        let _runtime = crate::backend::NativeBackend::new();
        let monitor = Monitor::primary().unwrap();
        for _ in 0..2 {
            let frames = Arc::new(Mutex::new(Frames::default()));
            let capture = start(monitor, frames.clone()).unwrap();
            assert!(capture.cursor_visibility_supported());
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while frames.lock().unwrap().count == 0 {
                assert!(!capture.is_finished());
                assert!(
                    std::time::Instant::now() < deadline,
                    "No WGC frames arrived"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            for visible in [false, true, false, true] {
                capture.set_cursor_visible(visible).unwrap();
                assert!(!capture.is_finished());
            }
            capture.stop().unwrap();
            assert!(frames.lock().unwrap().closed);
        }
    }
}
