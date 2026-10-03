//! Convert captured SDR pixels using the selected matrix and range.
use crate::media::MediaOptions;
use libwebrtc::{native::yuv_helper::argb_to_i420_with_matrix, video_frame::I420Buffer};

pub(super) fn from_bgra(
    bytes: &[u8],
    stride: u32,
    width: u32,
    height: u32,
    options: &MediaOptions,
) -> I420Buffer {
    let mut buffer = I420Buffer::new(width, height);
    // libyuv ARGB is BGRA byte order on little-endian Windows.
    argb_to_i420_with_matrix(
        bytes,
        stride,
        &mut buffer,
        options.color_space().yuv_matrix(),
    );
    buffer
}
