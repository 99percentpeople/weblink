//! Captured SDR planes retain their sampling format through preview and encoding.
use crate::media::{color::ColorFormat, MediaOptions};
use libwebrtc::{
    native::yuv_helper::{argb_to_i420_with_matrix, argb_to_i444},
    video_frame::{I420Buffer, I444Buffer, VideoBuffer},
};

#[derive(Debug)]
pub(super) enum Pixels {
    I420(I420Buffer),
    I444(I444Buffer),
}
impl From<I420Buffer> for Pixels {
    fn from(value: I420Buffer) -> Self {
        Self::I420(value)
    }
}
impl AsRef<dyn VideoBuffer> for Pixels {
    fn as_ref(&self) -> &(dyn VideoBuffer + 'static) {
        match self {
            Self::I420(b) => b,
            Self::I444(b) => b,
        }
    }
}
impl Pixels {
    pub fn from_bgra(
        bytes: &[u8],
        stride: u32,
        width: u32,
        height: u32,
        options: &MediaOptions,
    ) -> Self {
        // libyuv ARGB is BGRA byte order on little-endian Windows.
        if options.color_format.full_chroma() {
            let mut buffer = I444Buffer::new(width, height);
            argb_to_i444(
                bytes,
                stride,
                &mut buffer,
                (options.color_format != ColorFormat::Rgb)
                    .then(|| options.color_space().yuv_matrix()),
            );
            Self::I444(buffer)
        } else {
            let mut buffer = I420Buffer::new(width, height);
            argb_to_i420_with_matrix(
                bytes,
                stride,
                &mut buffer,
                options.color_space().yuv_matrix(),
            );
            Self::I420(buffer)
        }
    }
    pub fn width(&self) -> u32 {
        self.as_ref().width()
    }
    pub fn height(&self) -> u32 {
        self.as_ref().height()
    }
    pub fn data(&self) -> (&[u8], &[u8], &[u8]) {
        match self {
            Self::I420(b) => b.data(),
            Self::I444(b) => b.data(),
        }
    }
    pub fn strides(&self) -> (u32, u32, u32) {
        match self {
            Self::I420(b) => b.strides(),
            Self::I444(b) => b.strides(),
        }
    }
    pub fn format(&self) -> &'static str {
        match self {
            Self::I420(_) => "I420",
            Self::I444(_) => "I444",
        }
    }
    pub fn scale(&mut self, width: i32, height: i32) -> Self {
        match self {
            Self::I420(b) => Self::I420(b.scale(width, height)),
            Self::I444(b) => Self::I444(b.scale(width, height)),
        }
    }
}
