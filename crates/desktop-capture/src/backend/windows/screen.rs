//! Display capture is reusable independently of window capture and media transport.
use crate::{CaptureMethod, CaptureSource, Frames, Result, Session, SourceKind};
use std::sync::{Arc, Mutex};
use windows_capture::monitor::Monitor;

pub(super) fn id(m: Monitor) -> String {
    format!(
        "monitor:{:x}:{}",
        m.as_raw_hmonitor() as usize,
        m.device_name().unwrap_or_default()
    )
}
pub(super) fn refresh_rates() -> Vec<u32> {
    let mut rates: Vec<_> = Monitor::enumerate()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| m.refresh_rate().ok())
        .filter(|r| (2..=crate::media::MAX_FRAME_RATE).contains(r))
        .collect();
    rates.sort_unstable();
    rates.dedup();
    rates
}
pub(super) fn sources() -> Result<Vec<CaptureSource>> {
    Ok(Monitor::enumerate()
        .map_err(|e| e.to_string())?
        .into_iter()
        .enumerate()
        .map(|(i, m)| CaptureSource {
            id: id(m),
            kind: SourceKind::Monitor,
            name: m.name().unwrap_or_else(|_| format!("Display {}", i + 1)),
            width: m.width().unwrap_or(0),
            height: m.height().unwrap_or(0),
        })
        .collect())
}
pub(super) fn start(
    source: &CaptureSource,
    method: CaptureMethod,
    frames: Arc<Mutex<Frames>>,
) -> Result<Box<dyn Session>> {
    let monitor = Monitor::enumerate()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| id(*m) == source.id)
        .ok_or("Display disconnected")?;
    match method {
        CaptureMethod::Wgc => super::wgc::start_display(monitor, frames),
        CaptureMethod::Dxgi => super::dxgi::start(monitor.as_raw_hmonitor() as usize, frames),
        CaptureMethod::Auto => Err("Capture backend must be resolved before starting".into()),
    }
}

pub(super) fn thumbnail(source: &CaptureSource) -> Result<Vec<u8>> {
    let monitor = Monitor::enumerate()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| id(*m) == source.id)
        .ok_or("Display disconnected")?;
    super::snapshot::monitor(monitor)
}
