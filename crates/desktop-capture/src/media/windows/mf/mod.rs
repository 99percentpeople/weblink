//! Media Foundation backend and adapter-aware fallback.
pub(super) mod adapter;
pub(super) mod bitstream_color;
mod damage;
pub(super) mod encoders;
mod events;
#[cfg(test)]
mod gpu_tests;
mod output;
pub(super) mod sample;
pub(super) mod transform;
use super::hardware::gpu;
pub use encoders::detect;
