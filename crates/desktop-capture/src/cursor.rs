//! Cursor exclusion must happen before capture when Windows draws it into the desktop.
use crate::{Backend, CaptureMethod, Engine, Frames, Result};
use std::sync::{Arc, Mutex};

#[cfg(test)]
mod tests;

impl<B: Backend> Engine<B> {
    pub(crate) fn set_cursor_visible(&mut self, id: &str, visible: bool) -> Result<()> {
        let active = self.active.get_mut(id).ok_or("Capture stopped")?;
        if !visible
            && active.requested_backend == CaptureMethod::Auto
            && active.status.backend == Some(CaptureMethod::Dxgi)
        {
            // DXGI can return a cursor already drawn into the desktop texture
            // (for example during a window drag). Omitting its separate pointer
            // metadata cannot remove those pixels. Auto may use WGC to exclude
            // it at the source; explicit backend selections never change here.
            if !active.session.cursor_visibility_supported() {
                return Err("Cursor exclusion is unavailable for this capture".into());
            }
            let source = active
                .status
                .source
                .as_ref()
                .ok_or("Missing capture source")?;
            let frames = Arc::new(Mutex::new(Frames {
                cursor_hidden: true,
                ..Frames::default()
            }));
            // Keep DXGI and its media alive until the replacement has started.
            // Separate statistics and no sink isolate failed startup and prevent
            // early WGC callbacks from racing the old capture's last frame.
            let replacement = self
                .backend
                .start(source, CaptureMethod::Wgc, frames.clone())?;
            let ready = replacement.set_cursor_visible(false).and_then(|()| {
                if replacement.is_finished() {
                    Err("Cursor-free display capture stopped during startup".into())
                } else {
                    Ok(())
                }
            });
            if let Err(error) = ready {
                let _ = replacement.stop();
                return Err(error);
            }
            let previous = std::mem::replace(&mut active.session, replacement);
            // Join before attaching the new sink. A failure in the retired DXGI
            // session must not discard an already running WGC replacement.
            let _ = previous.stop();
            {
                let mut old = active.frames.lock().unwrap_or_else(|e| e.into_inner());
                let mut next = frames.lock().unwrap_or_else(|e| e.into_inner());
                next.count += old.count;
                next.last = next.last.or(old.last);
                if next.width == 0 || next.height == 0 {
                    next.width = old.width;
                    next.height = old.height;
                }
                next.media = old.media.take();
                #[cfg(windows)]
                {
                    next.sink = old.sink.take();
                }
            }
            active.frames = frames;
            active.status.backend = Some(CaptureMethod::Wgc);
            active.session.flush_pending_frame()?;
            // Retain WGC for this share; pointer hover and capture-mode changes
            // only toggle its cursor property, without opening more sessions.
        } else {
            active.session.set_cursor_visible(visible)?;
        }
        let mut frames = active.frames.lock().unwrap_or_else(|e| e.into_inner());
        frames.cursor_hidden = !visible;
        if let Some(media) = &frames.media {
            media.set_cursor_visible(visible);
        }
        Ok(())
    }
}
