//! A narrow ABI; SDK structures and driver function pointers remain in bridge.cpp.
use std::ffi::{c_char, c_void};

#[repr(C)]
pub(super) struct Config {
    pub codec: u32,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub ceiling: u32,
    pub primaries: u32,
    pub transfer: u32,
    pub matrix: u32,
    pub full_range: u32,
    pub preset: u32,
    pub tuning: u32,
    pub spatial_aq: u32,
}
#[repr(C)]
pub(super) struct Packet {
    pub bytes: *const u8,
    pub size: u32,
    pub keyframe: u32,
    pub timestamp: i64,
}
unsafe extern "C" {
    pub fn weblink_nvenc_open(
        device: *mut c_void,
        config: *const Config,
        wake: extern "C" fn(*mut c_void),
        context: *mut c_void,
        error: *mut c_char,
    ) -> *mut c_void;
    pub fn weblink_nvenc_close(session: *mut c_void);
    pub fn weblink_nvenc_ready(session: *mut c_void) -> u32;
    pub fn weblink_nvenc_input(
        session: *mut c_void,
        texture: *mut c_void,
        timestamp: i64,
        keyframe: u32,
        error: *mut c_char,
    ) -> i32;
    pub fn weblink_nvenc_poll(session: *mut c_void, packet: *mut Packet, error: *mut c_char)
        -> i32;
    pub fn weblink_nvenc_bitrate(session: *mut c_void, bitrate: u32, error: *mut c_char) -> i32;
}
