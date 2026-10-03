//! Reuse the staging texture instead of allocating one per captured frame.
use crate::surface::{Cursor, Rotation, TextureFrame};
use crate::Result;
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D,
    D3D11_BIND_SHADER_RESOURCE, D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_FLAG_DO_NOT_WAIT, D3D11_MAP_READ, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::DXGI_ERROR_WAS_STILL_DRAWING;

#[derive(Default)]
pub(crate) struct Readback {
    pub captured_at: Option<std::time::Instant>,
    texture: Option<ID3D11Texture2D>,
    staging: Option<ID3D11Texture2D>,
    staging_size: (u32, u32),
    scaler: Option<super::scale::Scaler>,
    pub scale_error: Option<String>,
    prepared: bool,
    pub output_size: (u32, u32),
    device: Option<ID3D11Device>,
    context: Option<ID3D11DeviceContext>,
    pub size: (u32, u32),
    pub dirty: bool,
    pub rotation: Rotation,
    pub cursor: Option<Cursor>,
}
impl Readback {
    pub(crate) fn frame(&self) -> Option<TextureFrame<'_>> {
        Some(TextureFrame {
            device: self.device.as_ref()?,
            context: self.context.as_ref()?,
            texture: self.texture.as_ref()?,
            rotation: self.rotation,
            cursor: self.cursor.as_ref(),
        })
    }

    pub fn copy(&mut self, frame: &TextureFrame<'_>) -> Result<()> {
        self.copy_at(frame, std::time::Instant::now())
    }
    pub fn copy_at(
        &mut self,
        frame: &TextureFrame<'_>,
        captured_at: std::time::Instant,
    ) -> Result<()> {
        let mut desc = Default::default();
        unsafe { frame.texture.GetDesc(&mut desc) };
        let size = (desc.Width, desc.Height);
        if size.0 == 0 || size.1 == 0 || size.0 > 16384 || size.1 > 16384 {
            return Err("Unsupported capture dimensions".into());
        }
        if self.size != size || self.device.as_ref() != Some(frame.device) {
            // Pending readbacks use this context outside the capture mutex.
            // This also covers the generic WGC/window path and injected sources.
            let protection: ID3D11Multithread = frame.context.cast().map_err(|e| e.to_string())?;
            unsafe {
                let _ = protection.SetMultithreadProtected(true);
                if !protection.GetMultithreadProtected().as_bool() {
                    return Err("Readback requires a thread-safe D3D context".into());
                }
            }
            // Retain the original on GPU: later settings increases can recover detail
            // even while the source is static, without full-size CPU readback.
            desc.Usage = D3D11_USAGE_DEFAULT;
            desc.BindFlags = D3D11_BIND_SHADER_RESOURCE.0 as u32;
            desc.CPUAccessFlags = 0;
            desc.MiscFlags = 0;
            let mut texture = None;
            // The texture belongs to this capture device and is recreated on resize/device change.
            unsafe {
                frame
                    .device
                    .CreateTexture2D(&desc, None, Some(&mut texture))
            }
            .map_err(|e| e.to_string())?;
            self.texture = Some(texture.ok_or("No staging texture returned")?);
            self.device = Some(frame.device.clone());
            self.size = size;
            self.staging = None;
            self.scaler = None;
            self.scale_error = None;
            self.context = Some(frame.context.clone());
        }
        let texture = self.texture.as_ref().ok_or("Missing staging texture")?;
        // Copy while the capture surface is still owned. The single pending texture
        // is overwritten by newer arrivals; raw frames never form an unbounded queue.
        unsafe {
            frame.context.CopyResource(texture, frame.texture);
        }
        self.rotation = frame.rotation;
        self.captured_at = Some(captured_at);
        self.cursor = frame.cursor.cloned();
        self.dirty = true;
        self.prepared = false;
        Ok(())
    }

    /// GPU work is bounded to the selected output cadence, not every capture arrival.
    /// Drivers without video processing retain the original CPU scaling path.
    pub fn prepare(&mut self, requested: (u32, u32)) -> Result<()> {
        let source = self.texture.as_ref().ok_or("Missing capture texture")?;
        let device = self.device.as_ref().ok_or("Missing capture device")?;
        let context = self.context.as_ref().ok_or("Missing capture context")?;
        let mut input = source.clone();
        let mut size = self.size;
        if requested != self.size && self.scale_error.is_none() {
            let scaled = (|| -> windows::core::Result<ID3D11Texture2D> {
                if self.scaler.as_ref().is_none_or(|s| s.size != requested) {
                    self.scaler = Some(super::scale::Scaler::new(
                        device, context, source, requested,
                    )?);
                }
                Ok(self.scaler.as_ref().unwrap().run()?.clone())
            })();
            match scaled {
                Ok(texture) => {
                    input = texture;
                    size = requested;
                }
                Err(error) => {
                    self.scale_error = Some(error.to_string());
                    self.scaler = None;
                }
            }
        }
        if self.staging.is_none() || self.staging_size != size {
            let mut desc = Default::default();
            unsafe {
                input.GetDesc(&mut desc);
            }
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            desc.MiscFlags = 0;
            let mut staging = None;
            unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }
                .map_err(|e| e.to_string())?;
            self.staging = staging;
            self.staging_size = size;
        }
        unsafe {
            context.CopyResource(
                self.staging.as_ref().ok_or("Missing staging texture")?,
                &input,
            );
        }
        self.output_size = size;
        self.prepared = true;
        Ok(())
    }

    pub fn map(&mut self) -> Result<Mapped<'_>> {
        if !self.prepared {
            self.prepare(self.size)?;
        }
        let texture = self.staging.as_ref().ok_or("Missing staging texture")?;
        let context = self.context.as_ref().ok_or("Missing capture context")?;
        let size = self.output_size;
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        // Caller holds the same mutex as copy(): the immediate context is serialized.
        // Map waits for the latest GPU copy before exposing its memory to the CPU.
        unsafe { context.Map(texture, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
            .map_err(|e| e.to_string())?;
        let result = Mapped {
            texture,
            context,
            mapped,
            height: size.1,
        };
        if result.mapped.pData.is_null() || result.mapped.RowPitch < size.0 * 4 {
            return Err("Invalid mapped BGRA surface".into());
        }
        Ok(result)
    }

    /// Move staging into a bounded worker-owned slot. Subsequent captures only
    /// replace the retained source; they cannot overwrite this pending GPU copy.
    pub fn submit(
        &mut self,
        requested: (u32, u32),
        reusable: Option<PendingReadback>,
    ) -> Result<PendingReadback> {
        if let Some(buffer) = reusable.filter(|b| Some(&b.context) == self.context.as_ref()) {
            self.staging = Some(buffer.texture);
            self.staging_size = buffer.size;
        }
        self.prepare(requested)?;
        let pending = PendingReadback {
            texture: self.staging.take().ok_or("Missing staging texture")?,
            context: self.context.clone().ok_or("Missing capture context")?,
            size: self.output_size,
        };
        self.prepared = false;
        // Submit once before polling. DO_NOT_WAIT must not leave the copy sitting
        // in the driver's command buffer until another blocking graphics call.
        unsafe { pending.context.Flush() };
        Ok(pending)
    }
}

pub(crate) struct PendingReadback {
    texture: ID3D11Texture2D,
    context: ID3D11DeviceContext,
    size: (u32, u32),
}
impl PendingReadback {
    /// Never wait inside the protected immediate context or the capture mutex.
    /// The worker yields between attempts and can submit other available slots.
    pub fn try_map(&mut self) -> Result<Option<Mapped<'_>>> {
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        match unsafe {
            self.context.Map(
                &self.texture,
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut mapped),
            )
        } {
            Ok(()) => {}
            Err(error) if error.code() == DXGI_ERROR_WAS_STILL_DRAWING => {
                return Ok(None);
            }
            Err(error) => return Err(error.to_string()),
        }
        let result = Mapped {
            texture: &self.texture,
            context: &self.context,
            mapped,
            height: self.size.1,
        };
        if result.mapped.pData.is_null() || result.mapped.RowPitch < self.size.0 * 4 {
            return Err("Invalid mapped BGRA surface".into());
        }
        Ok(Some(result))
    }
}

pub(crate) struct Mapped<'a> {
    texture: &'a ID3D11Texture2D,
    context: &'a ID3D11DeviceContext,
    mapped: D3D11_MAPPED_SUBRESOURCE,
    height: u32,
}
impl Mapped<'_> {
    pub fn stride(&self) -> u32 {
        self.mapped.RowPitch
    }
    pub fn bytes(&self) -> &[u8] {
        // Map succeeded; the borrowed texture stays mapped and immutable until Drop.
        unsafe {
            std::slice::from_raw_parts(
                self.mapped.pData.cast(),
                self.mapped.RowPitch as usize * self.height as usize,
            )
        }
    }
}
impl Drop for Mapped<'_> {
    fn drop(&mut self) {
        unsafe {
            self.context.Unmap(self.texture, 0);
        }
    }
}
