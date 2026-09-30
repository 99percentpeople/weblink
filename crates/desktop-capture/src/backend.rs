#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(super) use windows::NativeBackend;

#[cfg(not(windows))]
pub(super) struct NativeBackend;

#[cfg(not(windows))]
impl NativeBackend {
    pub(super) fn new() -> Self {
        Self
    }
}

#[cfg(not(windows))]
impl super::Backend for NativeBackend {
    fn capabilities(&self, _: Option<super::CaptureMethod>) -> super::CaptureCapabilities {
        super::CaptureCapabilities::default()
    }
    fn supported(&self) -> bool {
        false
    }
    fn sources(&self) -> super::Result<Vec<super::CaptureSource>> {
        Err("Native capture is currently available on Windows only".into())
    }
    fn start(
        &self,
        _: &super::CaptureSource,
        _: super::CaptureMethod,
        _: std::sync::Arc<std::sync::Mutex<super::Frames>>,
    ) -> super::Result<Box<dyn super::Session>> {
        Err("Native capture is currently available on Windows only".into())
    }
}
