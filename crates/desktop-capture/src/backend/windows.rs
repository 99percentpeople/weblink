//! Display and window capture have separate inventories and backend selection.
mod dxgi;
mod screen;
mod snapshot;
mod wgc;
mod window;
use crate::{
    Backend, CaptureBackendInfo, CaptureCapabilities, CaptureMethod, CaptureSource, Frames, Result,
    Session, SourceKind,
};
use std::sync::{Arc, Mutex};

use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};

// WGC caches activation factories. Keep the service's MTA alive across capability
// queries and captures; tearing it down between queries invalidates those factories.
pub(crate) struct NativeBackend {
    initialized: bool,
}
impl NativeBackend {
    pub(crate) fn new() -> Self {
        Self {
            initialized: unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok(),
        }
    }
}
impl Drop for NativeBackend {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { RoUninitialize() };
        }
    }
}
impl Backend for NativeBackend {
    fn display_refresh_rates(&self) -> Vec<u32> {
        screen::refresh_rates()
    }
    fn supported(&self) -> bool {
        (self.initialized && wgc::supported()) || dxgi::supported()
    }
    fn capabilities(&self, running: Option<CaptureMethod>) -> CaptureCapabilities {
        let wgc = self.initialized && wgc::supported();
        let mut screen = Vec::new();
        // DuplicateOutput rejects a second duplication of the same output in
        // this process. A running DXGI session already proves its availability.
        if running == Some(CaptureMethod::Dxgi) || dxgi::supported() {
            screen.push(CaptureBackendInfo {
                id: CaptureMethod::Dxgi,
                name: "DXGI Desktop Duplication".into(),
            });
        }
        let window = if wgc {
            vec![CaptureBackendInfo {
                id: CaptureMethod::Wgc,
                name: "Windows Graphics Capture".into(),
            }]
        } else {
            vec![]
        };
        screen.extend(window.iter().cloned());
        CaptureCapabilities { screen, window }
    }
    fn sources(&self) -> Result<Vec<CaptureSource>> {
        let mut sources = screen::sources()?;
        sources.extend(window::sources()?);
        Ok(sources)
    }
    fn thumbnail(&self, source: &CaptureSource) -> Result<Vec<u8>> {
        match source.kind {
            SourceKind::Monitor => screen::thumbnail(source),
            SourceKind::Window => crate::surface::thumbnail::capture(|frames| {
                window::start(source, CaptureMethod::Wgc, frames)
            }),
        }
    }
    fn start(
        &self,
        source: &CaptureSource,
        method: CaptureMethod,
        frames: Arc<Mutex<Frames>>,
    ) -> Result<Box<dyn Session>> {
        match source.kind {
            SourceKind::Monitor => screen::start(source, method, frames),
            SourceKind::Window => window::start(source, method, frames),
        }
    }
}
