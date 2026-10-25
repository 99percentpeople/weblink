//! Runtime backend selection; neither driver availability nor GPU brand is a guarantee.
use super::super::{
    mf::{
        self,
        adapter::Adapter,
        encoders::{self, Codec},
        transform::{self, Configuration, Packet},
    },
    nvenc,
};
use super::gpu;
use crate::{
    damage::DirtyRect,
    media::{
        color::ColorDescription,
        latency::{CodecControl, HardwareEncoderSelection},
        preset::EncodingPreset,
        EncoderInfo,
    },
    surface::gpu::{Lease, Wake},
    Result,
};
use libwebrtc::video_frame::EncodedVideoCodec;
use std::{sync::Arc, time::Duration};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;

pub fn detect() -> Result<Vec<EncoderInfo>> {
    let mut available = nvenc::detect();
    // An optional NVIDIA driver failure must never hide the Windows catalog.
    match mf::detect() {
        Ok(mf) => available.extend(mf),
        Err(error) if available.is_empty() => return Err(error),
        Err(_) => {}
    }
    Ok(available)
}

struct Preference {
    enabled: bool,
    failed: Option<String>,
}
impl Preference {
    fn new(requested: &str, automatic: bool) -> Self {
        Self {
            enabled: automatic || matches!(requested, nvenc::H264 | nvenc::HEVC),
            failed: None,
        }
    }
    fn allows(&self, nvidia: bool) -> bool {
        self.enabled && nvidia && self.failed.is_none()
    }
}

pub(super) struct Selection {
    requested: String,
    codec: Codec,
    preference: Preference,
    mf: encoders::Selection,
    nvenc_active: bool,
    preset: EncodingPreset,
    pub report: Option<HardwareEncoderSelection>,
}
impl Selection {
    pub fn new(requested: String, automatic: bool) -> Self {
        let codec = Codec::from_id(&requested);
        let mf = if matches!(requested.as_str(), nvenc::H264 | nvenc::HEVC) {
            encoders::Selection::for_codec(codec)
        } else {
            encoders::Selection::new(requested.clone(), automatic)
        };
        Self {
            preference: Preference::new(&requested, automatic),
            requested,
            codec,
            mf,
            nvenc_active: false,
            preset: EncodingPreset::Balanced,
            report: None,
        }
    }
    pub fn set_preset(&mut self, preset: EncodingPreset) {
        self.preset = preset;
        self.mf.set_preset(preset);
    }
    pub fn capture_device(&mut self, device: &ID3D11Device) {
        self.mf.capture_device(device);
    }
    // Once an active NVENC session fails, continue on MF for this receiver.
    // Do not repeatedly reopen a failing driver at the capture frame rate.
    pub fn reject_nvenc(&mut self, error: &str) -> bool {
        if !self.nvenc_active {
            return false;
        }
        self.preference.failed = Some(format!("NVENC failed; using Media Foundation: {error}"));
        self.nvenc_active = false;
        true
    }
    pub fn open(
        &mut self,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        bitrate_limit: u32,
        color: ColorDescription,
        wake: Wake,
        device: Option<&ID3D11Device>,
    ) -> Result<Encoder> {
        let configuration = Configuration {
            codec: self.codec,
            width,
            height,
            fps,
            bitrate,
            bitrate_limit,
            color,
        };
        let preset = self.preset;
        self.open_with(
            configuration,
            wake,
            device,
            |device, configuration, wake| {
                nvenc::Encoder::open_requested_preset(device, configuration, preset, wake)
            },
        )
    }
    fn open_with(
        &mut self,
        configuration: Configuration,
        wake: Wake,
        device: Option<&ID3D11Device>,
        open_nvenc: impl FnOnce(&ID3D11Device, Configuration, Wake) -> Result<nvenc::Encoder>,
    ) -> Result<Encoder> {
        let Configuration {
            width,
            height,
            fps,
            bitrate,
            bitrate_limit,
            color,
            ..
        } = configuration;
        self.nvenc_active = false;
        if let Some(device) = device.filter(|d| self.preference.allows(nvenc::is_nvidia(d))) {
            match open_nvenc(device, configuration, wake.clone()) {
                Ok(encoder) => {
                    let adapter = Adapter::from_device(device).ok().map(|a| a.label());
                    let (id, name) = match self.codec {
                        Codec::H264 => (nvenc::H264, "NVIDIA NVENC H.264"),
                        Codec::Hevc => (nvenc::HEVC, "NVIDIA NVENC H.265"),
                    };
                    self.report = Some(HardwareEncoderSelection {
                        requested: self.requested.clone(),
                        encoder: id.into(),
                        name: name.into(),
                        capture_adapter: adapter.clone(),
                        encoder_adapter: adapter.clone(),
                        adapter_matched: adapter.is_some(),
                        fallback: None,
                    });
                    self.nvenc_active = true;
                    return Ok(Encoder {
                        inner: Inner::Nvenc(encoder),
                        codec: self.codec.encoded(),
                        width,
                        height,
                        device: Some(device.clone()),
                    });
                }
                Err(error) => {
                    self.preference.failed = Some(format!(
                        "NVENC unavailable; using Media Foundation: {error}"
                    ))
                }
            }
        }
        let encoder = self.mf.open(
            width,
            height,
            fps,
            bitrate,
            bitrate_limit,
            color,
            wake,
            device,
        )?;
        self.report = self.mf.report.clone();
        if let Some(report) = &mut self.report {
            report.requested = self.requested.clone();
            let reason = self.preference.failed.clone().or_else(|| {
                matches!(self.requested.as_str(), nvenc::H264 | nvenc::HEVC).then(|| {
                    "NVENC requires a compatible NVIDIA capture texture; using Media Foundation"
                        .into()
                })
            });
            if let Some(reason) = reason {
                report.fallback = Some(match report.fallback.take() {
                    Some(mf) => format!("{reason}; {mf}"),
                    None => reason,
                });
            }
        }
        Ok(Encoder {
            codec: encoder.codec,
            width,
            height,
            device: encoder.device.clone(),
            inner: Inner::Mf(encoder),
        })
    }
}
enum Inner {
    Nvenc(nvenc::Encoder),
    Mf(transform::Transform),
}
pub(super) struct Encoder {
    inner: Inner,
    pub codec: EncodedVideoCodec,
    pub width: u32,
    pub height: u32,
    pub device: Option<ID3D11Device>,
}
impl Encoder {
    pub fn implementation(&self) -> &'static str {
        match &self.inner {
            Inner::Nvenc(_) => "NVENC",
            Inner::Mf(_) => "Media Foundation",
        }
    }
    #[cfg(test)]
    pub fn fail_nvenc_output(&mut self) {
        if let Inner::Nvenc(encoder) = &mut self.inner {
            encoder.fail_output = true;
        }
    }
    pub fn ready(&self) -> bool {
        match &self.inner {
            Inner::Nvenc(e) => e.ready(),
            Inner::Mf(e) => e.ready(),
        }
    }
    pub fn poll(&mut self) -> Result<Vec<Packet>> {
        match &mut self.inner {
            Inner::Nvenc(e) => e.poll(),
            Inner::Mf(e) => e.poll().map_err(|e| e.to_string()),
        }
    }
    pub fn request_keyframe(&self) -> Result<()> {
        match &self.inner {
            Inner::Nvenc(e) => {
                e.request_keyframe();
                Ok(())
            }
            Inner::Mf(e) => e.request_keyframe(),
        }
    }
    pub fn input(
        &mut self,
        bytes: &[u8],
        timestamp: i64,
        damage: Option<&[DirtyRect]>,
    ) -> Result<bool> {
        match &mut self.inner {
            Inner::Nvenc(_) => Err("NVENC requires GPU input".into()),
            Inner::Mf(e) => e
                .input(bytes, timestamp, damage)
                .map(|_| true)
                .map_err(|e| e.to_string()),
        }
    }
    pub fn input_gpu(
        &mut self,
        surface: Arc<Lease<gpu::Surface>>,
        timestamp: i64,
        damage: Option<&[DirtyRect]>,
    ) -> Result<bool> {
        match &mut self.inner {
            Inner::Nvenc(e) => e.input_gpu(surface, timestamp),
            Inner::Mf(e) => e
                .input_gpu(surface, timestamp, damage)
                .map(|_| true)
                .map_err(|e| e.to_string()),
        }
    }
    pub fn set_bitrate(&mut self, value: u32) -> Result<()> {
        match &mut self.inner {
            Inner::Nvenc(e) => e.set_bitrate(value),
            Inner::Mf(e) => e.set_bitrate(value),
        }
    }
    pub fn control_status(&self) -> Vec<CodecControl> {
        match &self.inner {
            Inner::Nvenc(e) => e.control_status(),
            Inner::Mf(e) => e.control_status(),
        }
    }
    pub fn take_controls_changed(&mut self) -> bool {
        match &mut self.inner {
            Inner::Nvenc(_) => false,
            Inner::Mf(e) => e.take_controls_changed(),
        }
    }
    pub fn watchdog(&self) -> Option<Duration> {
        match &self.inner {
            Inner::Nvenc(e) if e.has_pending() => Some(Duration::from_secs(1)),
            _ => None,
        }
    }
}

#[cfg(test)]
#[path = "backend_tests.rs"]
mod tests;
