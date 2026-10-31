//! Software decoders use the same native compositor, uploading NV12 instead of
//! asking WebView2 to decode or present the compressed stream.
use super::Texture;
use std::{ffi::c_void, sync::Arc};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows_core::Interface;
#[derive(Default)]
pub struct Upload(*mut c_void);
// Access is serialized by the owning receiver's mutex. D3D11 devices are free-threaded.
unsafe impl Send for Upload {}
unsafe extern "C" {
    fn wl_upload_nv12(
        state: *mut *mut c_void,
        data: *const u8,
        width: u32,
        height: u32,
        result: *mut *mut c_void,
    ) -> i32;
    fn wl_upload_destroy(state: *mut c_void);
}
impl Upload {
    pub fn frame(
        &mut self,
        frame: &libwebrtc::video_frame::BoxVideoFrame,
    ) -> Result<Texture, String> {
        let (width, height) = (frame.buffer.width(), frame.buffer.height());
        let i420 = frame.buffer.to_i420();
        let (y, u, v) = i420.data();
        let (sy, su, sv) = i420.strides();
        let (w, h) = (width as usize, height as usize);
        let mut packed = vec![0; w * h * 3 / 2];
        for row in 0..h {
            packed[row * w..(row + 1) * w]
                .copy_from_slice(&y[row * sy as usize..row * sy as usize + w]);
        }
        for row in 0..h / 2 {
            for col in 0..w / 2 {
                packed[w * h + row * w + col * 2] = u[row * su as usize + col];
                packed[w * h + row * w + col * 2 + 1] = v[row * sv as usize + col];
            }
        }
        let mut texture = std::ptr::null_mut();
        let hr =
            unsafe { wl_upload_nv12(&mut self.0, packed.as_ptr(), width, height, &mut texture) };
        if hr < 0 {
            return Err(format!("Native software frame upload failed: {hr:#x}"));
        }
        let color = frame.buffer.color_space().unwrap_or([1, 1, 1, 1]);
        Ok(Texture {
            cpu_upload: true,
            texture: unsafe { ID3D11Texture2D::from_raw(texture) },
            subresource: 0,
            crop: (0, 0),
            size: (width, height),
            bt709: color[2] == 1,
            full_range: color[3] == 2,
            owner: Arc::new(()),
        })
    }
}
impl Drop for Upload {
    fn drop(&mut self) {
        unsafe { wl_upload_destroy(self.0) }
    }
}
