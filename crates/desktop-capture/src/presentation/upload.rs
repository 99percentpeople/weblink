//! Software decoders share native presentation without a browser decode fallback.
//! CPU packing storage and GPU textures are reused, bounded by complete frame leases.
use super::Texture;
use std::{
    ffi::c_void,
    sync::{Arc, Mutex, Weak},
};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows_core::Interface;

const SLOTS: usize = 4;
#[derive(Default)]
pub struct Upload {
    native: *mut c_void,
    packed: Vec<u8>,
    pool: Arc<Mutex<Pool>>,
}
// Serialized by the receiver; returns from GPU consumers only touch the pool mutex.
unsafe impl Send for Upload {}
#[derive(Default)]
struct Pool {
    size: (u32, u32),
    generation: u64,
    allocated: usize,
    idle: Vec<ID3D11Texture2D>,
}
impl Pool {
    fn invalidate(&mut self, size: (u32, u32)) {
        self.allocated -= self.idle.len();
        self.idle.clear();
        self.generation += 1;
        self.size = size;
    }
}
struct Lease {
    texture: Option<ID3D11Texture2D>,
    pool: Weak<Mutex<Pool>>,
    generation: u64,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(pool) = self.pool.upgrade() {
            let mut pool = pool.lock().unwrap();
            if self.generation == pool.generation {
                if let Some(texture) = self.texture.take() {
                    pool.idle.push(texture);
                    return;
                }
            }
            pool.allocated -= 1;
        }
    }
}
unsafe extern "C" {
    fn wl_upload_nv12(
        state: *mut *mut c_void,
        reuse: *mut c_void,
        data: *const u8,
        width: u32,
        height: u32,
        result: *mut *mut c_void,
    ) -> i32;
    fn wl_upload_destroy(state: *mut c_void);
}
impl Upload {
    fn acquire(&self, size: (u32, u32)) -> Option<Lease> {
        let mut pool = self.pool.lock().unwrap();
        if pool.size != size {
            pool.invalidate(size);
        }
        let texture = pool.idle.pop();
        if texture.is_none() {
            // Count old-generation leases too: repeated resize cannot grow an
            // upload queue while a slow GPU/recorder retains previous frames.
            if pool.allocated == SLOTS {
                return None;
            }
            pool.allocated += 1;
        }
        Some(Lease {
            texture,
            pool: Arc::downgrade(&self.pool),
            generation: pool.generation,
        })
    }
    pub fn frame(
        &mut self,
        frame: &libwebrtc::video_frame::BoxVideoFrame,
    ) -> Result<Option<Texture>, String> {
        let (width, height) = (frame.buffer.width(), frame.buffer.height());
        if width < 2
            || height < 2
            || width > 3840
            || height > 2160
            || width % 2 != 0
            || height % 2 != 0
        {
            return Err("Invalid software upload dimensions".into());
        }
        let Some(mut lease) = self.acquire((width, height)) else {
            // Drop this decoded presentation frame, without stalling reference
            // decoding or accumulating a FIFO behind presentation/recording.
            return Ok(None);
        };
        let (w, h) = (width as usize, height as usize);
        self.packed.resize(w * h * 3 / 2, 0);
        if let Some(nv12) = frame.buffer.as_nv12() {
            let (y, uv) = nv12.data();
            let (sy, suv) = nv12.strides();
            let mut offset = 0;
            for (plane, stride, rows) in [(y, sy, h), (uv, suv, h / 2)] {
                for row in 0..rows {
                    self.packed[offset..offset + w]
                        .copy_from_slice(&plane[row * stride as usize..row * stride as usize + w]);
                    offset += w;
                }
            }
        } else {
            let i420 = frame.buffer.to_i420();
            let (y, u, v) = i420.data();
            let (sy, su, sv) = i420.strides();
            let (dst_y, dst_uv) = self.packed.split_at_mut(w * h);
            // Match the encoder's SIMD packing path instead of a per-pixel UV loop.
            libwebrtc::native::yuv_helper::i420_to_nv12(
                y,
                sy,
                u,
                su,
                v,
                sv,
                dst_y,
                width,
                dst_uv,
                width,
                width as i32,
                height as i32,
            );
        }
        let mut texture = std::ptr::null_mut();
        let reuse = lease
            .texture
            .as_ref()
            .map_or(std::ptr::null_mut(), Interface::as_raw);
        let hr = unsafe {
            wl_upload_nv12(
                &mut self.native,
                reuse,
                self.packed.as_ptr(),
                width,
                height,
                &mut texture,
            )
        };
        if hr < 0 {
            // Old-generation leases remain valid until their GPU work finishes.
            self.pool.lock().unwrap().invalidate((0, 0));
            unsafe { wl_upload_destroy(self.native) };
            self.native = std::ptr::null_mut();
            return Err(format!("Native software frame upload failed: {hr:#x}"));
        }
        let texture = unsafe { ID3D11Texture2D::from_raw(texture) };
        lease.texture = Some(texture.clone());
        let color = frame.buffer.color_space().unwrap_or([1, 1, 1, 1]);
        Ok(Some(Texture {
            cpu_upload: true,
            texture,
            subresource: 0,
            crop: (0, 0),
            size: (width, height),
            bt709: color[2] == 1,
            full_range: color[3] == 2,
            owner: Arc::new(lease),
        }))
    }
}
impl Drop for Upload {
    fn drop(&mut self) {
        unsafe { wl_upload_destroy(self.native) }
    }
}

#[cfg(test)]
mod tests;
