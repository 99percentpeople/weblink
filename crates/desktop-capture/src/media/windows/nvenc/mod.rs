//! Optional NVIDIA driver adapter. No static NVIDIA/CUDA library dependency.
#[cfg(test)]
mod compare;
mod discovery;
mod ffi;
mod preset;
use super::{
    hardware::gpu,
    mf::{
        encoders::Codec,
        transform::{Configuration, Packet},
    },
};
use crate::{
    media::latency::CodecControl,
    media::preset::EncodingPreset,
    surface::gpu::{Lease, Wake},
    Result,
};
pub(super) use discovery::{detect, is_nvidia};
use std::{
    cell::Cell,
    collections::HashMap,
    ffi::{c_char, c_void, CStr},
    ptr::NonNull,
    sync::Arc,
    time::{Duration, Instant},
};
use windows::{core::Interface, Win32::Graphics::Direct3D11::ID3D11Device};

pub(super) const H264: &str = "nvenc:h264";
pub(super) const HEVC: &str = "nvenc:h265";

struct Input {
    _surface: Arc<Lease<gpu::Surface>>,
    submitted: Instant,
}

pub(super) struct Encoder {
    #[cfg(test)]
    pub fail_output: bool,
    raw: NonNull<c_void>,
    // The native completion thread only invokes this wake. close joins it before
    // the Box is released; no native callback may outlive its Rust context.
    _wake: Box<Wake>,
    inputs: HashMap<i64, Input>,
    blocked_since: Option<Instant>,
    keyframe: Cell<bool>,
    configuration: Configuration,
    preset: EncodingPreset,
    preset_fallback: Option<(EncodingPreset, String)>,
}

extern "C" fn wake(context: *mut c_void) {
    // Never let a Rust panic cross the C++/driver boundary.
    let callback = unsafe { &*context.cast::<Wake>() };
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback()));
}
fn error(message: &[c_char; 512]) -> String {
    unsafe { CStr::from_ptr(message.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

impl Encoder {
    pub fn open_requested_preset(
        device: &ID3D11Device,
        configuration: Configuration,
        preset: EncodingPreset,
        notify: Wake,
    ) -> Result<Self> {
        match Self::open_with_preset(device, configuration, preset, notify.clone()) {
            Ok(encoder) => Ok(encoder),
            Err(error) if preset != EncodingPreset::Balanced => {
                let mut encoder = Self::open(device, configuration, notify)?;
                encoder.preset_fallback = Some((preset, error));
                Ok(encoder)
            }
            Err(error) => Err(error),
        }
    }
    pub fn open(device: &ID3D11Device, configuration: Configuration, notify: Wake) -> Result<Self> {
        Self::open_with_preset(device, configuration, EncodingPreset::Balanced, notify)
    }
    pub fn open_with_preset(
        device: &ID3D11Device,
        configuration: Configuration,
        preset: EncodingPreset,
        notify: Wake,
    ) -> Result<Self> {
        if !is_nvidia(device) {
            return Err("The capture adapter does not support NVIDIA NVENC".into());
        }
        let color = configuration.color.rtc();
        let settings = preset::settings(preset);
        let config = ffi::Config {
            codec: match configuration.codec {
                Codec::H264 => 1,
                Codec::Hevc => 2,
            },
            width: configuration.width,
            height: configuration.height,
            fps: configuration.fps,
            bitrate: configuration.bitrate,
            ceiling: configuration.bitrate_limit,
            primaries: color.primaries as u32,
            transfer: color.transfer as u32,
            matrix: color.matrix as u32,
            full_range: u32::from(color.full_range),
            preset: settings.level,
            tuning: settings.tuning,
            spatial_aq: settings.spatial_aq,
        };
        let mut notify = Box::new(notify);
        let mut message = [0; 512];
        let raw = unsafe {
            ffi::weblink_nvenc_open(
                device.as_raw(),
                &config,
                wake,
                (&mut *notify as *mut Wake).cast(),
                message.as_mut_ptr(),
            )
        };
        let raw = NonNull::new(raw).ok_or_else(|| error(&message))?;
        Ok(Self {
            #[cfg(test)]
            fail_output: false,
            raw,
            _wake: notify,
            inputs: HashMap::new(),
            blocked_since: None,
            keyframe: Cell::new(true),
            configuration,
            preset,
            preset_fallback: None,
        })
    }
    pub fn ready(&self) -> bool {
        unsafe { ffi::weblink_nvenc_ready(self.raw.as_ptr()) != 0 }
    }
    pub fn request_keyframe(&self) {
        self.keyframe.set(true);
    }
    pub fn has_pending(&self) -> bool {
        !self.inputs.is_empty()
    }
    pub fn input_gpu(&mut self, surface: Arc<Lease<gpu::Surface>>, timestamp: i64) -> Result<bool> {
        if self.inputs.contains_key(&timestamp) {
            return Err("Duplicate NVENC input timestamp".into());
        }
        let mut message = [0; 512];
        let result = unsafe {
            ffi::weblink_nvenc_input(
                self.raw.as_ptr(),
                surface.texture.as_raw(),
                timestamp,
                u32::from(self.keyframe.get()),
                message.as_mut_ptr(),
            )
        };
        if result < 0 {
            return Err(error(&message));
        }
        if result == 0 {
            if self
                .blocked_since
                .get_or_insert_with(Instant::now)
                .elapsed()
                > Duration::from_secs(3)
            {
                return Err("NVENC input timed out".into());
            }
            return Ok(false);
        }
        self.blocked_since = None;
        self.keyframe.set(false);
        self.inputs.insert(
            timestamp,
            Input {
                _surface: surface,
                submitted: Instant::now(),
            },
        );
        Ok(true)
    }
    pub fn poll(&mut self) -> Result<Vec<Packet>> {
        #[cfg(test)]
        if self.fail_output {
            return Err("Controlled NVENC output failure".into());
        }
        let mut packets = Vec::new();
        for _ in 0..4 {
            let mut message = [0; 512];
            let mut packet = ffi::Packet {
                bytes: std::ptr::null(),
                size: 0,
                keyframe: 0,
                timestamp: 0,
            };
            let result = unsafe {
                ffi::weblink_nvenc_poll(self.raw.as_ptr(), &mut packet, message.as_mut_ptr())
            };
            if result < 0 {
                return Err(error(&message));
            }
            if result == 0 {
                break;
            }
            if packet.bytes.is_null() || packet.size == 0 || packet.size > 64 * 1024 * 1024 {
                return Err("Invalid NVENC output buffer".into());
            }
            let mut bytes =
                unsafe { std::slice::from_raw_parts(packet.bytes, packet.size as usize) }.to_vec();
            if self.inputs.remove(&packet.timestamp).is_none() {
                return Err("Unknown NVENC output timestamp".into());
            }
            super::mf::bitstream_color::normalize(
                &mut bytes,
                self.configuration.codec.encoded(),
                self.configuration.color,
            )
            .map_err(str::to_string)?;
            packets.push(Packet {
                bytes,
                timestamp_us: packet.timestamp,
                keyframe: packet.keyframe != 0,
            });
        }
        if self
            .inputs
            .values()
            .any(|input| input.submitted.elapsed() > Duration::from_secs(3))
        {
            return Err("NVENC output timed out".into());
        }
        Ok(packets)
    }
    pub fn set_bitrate(&mut self, bitrate: u32) -> Result<()> {
        let mut message = [0; 512];
        let result =
            unsafe { ffi::weblink_nvenc_bitrate(self.raw.as_ptr(), bitrate, message.as_mut_ptr()) };
        if result < 0 {
            Err(error(&message))
        } else {
            Ok(())
        }
    }
    pub fn control_status(&self) -> Vec<CodecControl> {
        let settings = preset::settings(self.preset);
        let mut controls: Vec<CodecControl> = [
            ("nvencApiVersion", 122),
            ("nvencPreset", settings.level),
            ("nvencTuning", settings.tuning),
            ("spatialAQ", settings.spatial_aq),
            ("nvencAsync", 1),
            ("lowLatency", 1),
            ("bFrames", 0),
            // NVENC_INFINITE_GOPLENGTH: IDRs are requested by consumers.
            ("gopFrames", u32::MAX),
            (
                "bufferBytes",
                self.configuration
                    .bitrate_limit
                    .div_ceil(8 * self.configuration.fps),
            ),
        ]
        .into_iter()
        .map(|(name, value)| CodecControl {
            name: name.into(),
            requested: value,
            // Initialization accepted these values; NVENC has no corresponding
            // runtime getter, so do not present them as driver readback.
            actual: None,
            accepted: true,
            error: None,
        })
        .collect();
        controls.push(CodecControl {
            name: "encodingPreset".into(),
            requested: self
                .preset_fallback
                .as_ref()
                .map_or(self.preset, |(p, _)| *p)
                .code(),
            // Effective application intent, not a driver getter.
            actual: Some(self.preset.code()),
            accepted: self.preset_fallback.is_none(),
            error: self
                .preset_fallback
                .as_ref()
                .map(|(_, error)| format!("Using balanced: {error}")),
        });
        controls
    }
}
impl Drop for Encoder {
    fn drop(&mut self) {
        // Destroy the driver session before returning any in-flight GPU leases.
        unsafe { ffi::weblink_nvenc_close(self.raw.as_ptr()) };
        self.inputs.clear();
    }
}
