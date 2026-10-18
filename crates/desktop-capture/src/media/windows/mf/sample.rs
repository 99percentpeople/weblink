//! The MFT may retain ProcessInput samples. Return a surface only on its final release.
use super::gpu::Surface;
use crate::surface::gpu::Lease;
use std::sync::{Arc, Mutex};
use windows::{
    core::{implement, IUnknown, Interface, Ref, Result},
    Win32::{
        Foundation::E_NOTIMPL, Graphics::Direct3D11::ID3D11Texture2D, Media::MediaFoundation::*,
    },
};

pub(in crate::media::windows) fn tracked(surface: Arc<Lease<Surface>>) -> Result<IMFSample> {
    unsafe {
        let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &surface.texture, 0, false)?;
        let tracked = MFCreateTrackedSample()?;
        let sample: IMFSample = tracked.cast()?;
        sample.AddBuffer(&buffer)?;
        let release: IMFAsyncCallback = Release {
            surface: Mutex::new(Some(surface)),
        }
        .into();
        tracked.SetAllocator(&release, None::<&IUnknown>)?;
        Ok(sample)
    }
}
#[implement(IMFAsyncCallback)]
struct Release {
    surface: Mutex<Option<Arc<Lease<Surface>>>>,
}
impl IMFAsyncCallback_Impl for Release_Impl {
    fn GetParameters(&self, _: *mut u32, _: *mut u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn Invoke(&self, _: Ref<IMFAsyncResult>) -> Result<()> {
        self.surface
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        Ok(())
    }
}
