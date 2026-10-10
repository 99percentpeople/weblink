//! Keep Desktop Duplication's device out of the asynchronous readback path.
//!
//! One reusable shared surface hands a borrowed frame to the sink. The sink copies
//! it to its retained source before returning; no frames queue up in this bridge.
use crate::{
    surface::{Cursor, Rotation, TextureFrame},
    Result,
};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows::{
    core::Interface,
    Win32::{
        Foundation::{HANDLE, HMODULE, S_OK, WAIT_ABANDONED, WAIT_TIMEOUT},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
            Direct3D11::*,
            Dxgi::{Common::*, *},
        },
    },
};

// A failed GPU handoff is an error, never permission to use an unowned texture.
const HANDOFF_TIMEOUT_MS: u32 = 2_000;

pub(super) struct Transfer {
    producer: ID3D11Device,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    surface: Surface,
}
impl Transfer {
    pub(super) fn new(producer: &ID3D11Device, mode: &DXGI_MODE_DESC) -> Result<Self> {
        let adapter = producer
            .cast::<IDXGIDevice>()
            .and_then(|device| unsafe { device.GetAdapter() })
            .map_err(|e| e.to_string())?;
        let (mut device, mut context) = (None, None);
        unsafe {
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .map_err(|e| e.to_string())?;
        let device = device.ok_or("No DXGI transfer device")?;
        let context = context.ok_or("No DXGI transfer context")?;
        // Capture submits the sink's copy here; conversion later uses this same
        // context. Acquisition itself never touches or waits on this context.
        let protection: ID3D11Multithread = context.cast().map_err(|e| e.to_string())?;
        unsafe {
            let _ = protection.SetMultithreadProtected(true);
        }
        if !unsafe { protection.GetMultithreadProtected() }.as_bool() {
            return Err("Could not protect DXGI transfer context".into());
        }
        let surface = Surface::new(producer, &device, mode.Width, mode.Height, mode.Format)?;
        Ok(Self {
            producer: producer.clone(),
            device,
            context,
            surface,
        })
    }

    pub(super) fn deliver(
        &mut self,
        producer_context: &ID3D11DeviceContext,
        texture: &ID3D11Texture2D,
        rotation: Rotation,
        cursor: Option<&Cursor>,
        consume: impl FnOnce(TextureFrame<'_>) -> Result<()>,
    ) -> Result<()> {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            texture.GetDesc(&mut desc);
        }
        if self.surface.shape != (desc.Width, desc.Height, desc.Format) {
            self.surface = Surface::new(
                &self.producer,
                &self.device,
                desc.Width,
                desc.Height,
                desc.Format,
            )?;
        }
        let writing = Access::acquire(&self.surface.write, 0, 1, HANDOFF_TIMEOUT_MS)?;
        unsafe {
            producer_context.CopyResource(&self.surface.producer, texture);
        }
        writing.release()?;
        let reading = Access::acquire(&self.surface.read, 1, 0, HANDOFF_TIMEOUT_MS)?;
        let result = consume(TextureFrame {
            device: &self.device,
            context: &self.context,
            texture: &self.surface.consumer,
            rotation,
            cursor,
        });
        // Release even when the sink fails. RAII also covers unwinding.
        let released = reading.release();
        result.and(released)
    }
}

struct Surface {
    producer: ID3D11Texture2D,
    consumer: ID3D11Texture2D,
    write: IDXGIKeyedMutex,
    read: IDXGIKeyedMutex,
    shape: (u32, u32, DXGI_FORMAT),
}
impl Surface {
    fn new(
        producer: &ID3D11Device,
        consumer: &ID3D11Device,
        width: u32,
        height: u32,
        format: DXGI_FORMAT,
    ) -> Result<Self> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX)
                .0 as u32,
            ..Default::default()
        };
        let make = || -> windows::core::Result<Self> {
            let mut texture = None;
            unsafe {
                producer.CreateTexture2D(&desc, None, Some(&mut texture))?;
            }
            let texture = texture.ok_or_else(windows::core::Error::empty)?;
            let resource: IDXGIResource1 = texture.cast()?;
            let handle = unsafe {
                resource.CreateSharedHandle(
                    None,
                    DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0,
                    None,
                )?
            };
            let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
            let opened: ID3D11Texture2D = unsafe {
                consumer
                    .cast::<ID3D11Device1>()?
                    .OpenSharedResource1(HANDLE(handle.as_raw_handle()))?
            };
            Ok(Self {
                write: texture.cast()?,
                read: opened.cast()?,
                producer: texture,
                consumer: opened,
                shape: (width, height, format),
            })
        };
        make().map_err(|e| format!("DXGI shared texture unavailable: {e}"))
    }
}

struct Access<'a> {
    mutex: Option<&'a IDXGIKeyedMutex>,
    release_key: u64,
}
impl<'a> Access<'a> {
    fn acquire(
        mutex: &'a IDXGIKeyedMutex,
        key: u64,
        release_key: u64,
        timeout: u32,
    ) -> Result<Self> {
        // windows-rs maps positive HRESULTs to Ok(()), but this API returns the
        // positive WAIT_TIMEOUT / WAIT_ABANDONED values without acquiring it.
        let status = unsafe {
            (Interface::vtable(mutex).AcquireSync)(Interface::as_raw(mutex), key, timeout)
        };
        if status != S_OK {
            let reason = if status.0 == WAIT_TIMEOUT.0 as i32 {
                "timed out".to_string()
            } else if status.0 == WAIT_ABANDONED.0 as i32 {
                "was abandoned".to_string()
            } else {
                status.to_string()
            };
            return Err(format!("DXGI shared texture handoff {reason}"));
        }
        Ok(Self {
            mutex: Some(mutex),
            release_key,
        })
    }
    fn release(mut self) -> Result<()> {
        unsafe { self.mutex.take().unwrap().ReleaseSync(self.release_key) }
            .map_err(|e| e.to_string())
    }
}
impl Drop for Access<'_> {
    fn drop(&mut self) {
        if let Some(mutex) = self.mutex.take() {
            let _ = unsafe { mutex.ReleaseSync(self.release_key) };
        }
    }
}

#[cfg(test)]
mod tests;
