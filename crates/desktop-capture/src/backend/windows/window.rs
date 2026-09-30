//! Windows are captured as windows, never cropped out of a monitor capture.
use crate::{CaptureMethod, CaptureSource, Frames, Result, Session, SourceKind};
use std::sync::{Arc, Mutex};
use windows_capture::window::Window;
fn id(w: Window) -> Option<String> {
    Some(format!(
        "window:{:x}:{}",
        w.as_raw_hwnd() as usize,
        w.process_id().ok()?
    ))
}
pub(super) fn sources() -> Result<Vec<CaptureSource>> {
    Ok(Window::enumerate()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|w| {
            let (Some(id), Ok(name)) = (id(w), w.title()) else {
                return None;
            };
            if name.trim().is_empty() {
                return None;
            }
            Some(CaptureSource {
                id,
                kind: SourceKind::Window,
                name,
                width: w.width().unwrap_or(0).max(0) as u32,
                height: w.height().unwrap_or(0).max(0) as u32,
            })
        })
        .collect())
}
pub(super) fn start(
    source: &CaptureSource,
    method: CaptureMethod,
    frames: Arc<Mutex<Frames>>,
) -> Result<Box<dyn Session>> {
    if method != CaptureMethod::Wgc {
        return Err("Selected backend does not support window capture".into());
    }
    let window = Window::enumerate()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| id(*w).as_deref() == Some(&source.id))
        .ok_or("Window closed")?;
    super::wgc::start(window, frames)
}
