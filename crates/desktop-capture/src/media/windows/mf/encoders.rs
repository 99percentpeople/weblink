//! Adapter-aware discovery and selection. Runs only on the owning encoder thread.
use super::{
    adapter::{self, Adapter},
    transform::{Configuration, Runtime, Transform},
};
use crate::{
    media::{latency::HardwareEncoderSelection, EncoderInfo, MediaOptions},
    Result,
};
use std::{ptr, sync::Arc};
use windows::{
    core::PWSTR,
    Win32::{
        Graphics::Direct3D11::ID3D11Device, Media::MediaFoundation::*, System::Com::CoTaskMemFree,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::media::windows) enum Codec {
    H264,
    Hevc,
}
impl Codec {
    pub fn from_id(id: &str) -> Self {
        if id.ends_with(":h265") {
            Self::Hevc
        } else {
            Self::H264
        }
    }
    pub fn mime(self) -> &'static str {
        match self {
            Self::H264 => "video/h264",
            Self::Hevc => "video/h265",
        }
    }
    pub fn subtype(self) -> windows::core::GUID {
        match self {
            Self::H264 => MFVideoFormat_H264,
            Self::Hevc => MFVideoFormat_HEVC,
        }
    }
    pub fn profile(self) -> u32 {
        match self {
            Self::H264 => eAVEncH264VProfile_Base.0 as u32,
            Self::Hevc => eAVEncH265VProfile_Main_420_8.0 as u32,
        }
    }
    pub fn encoded(self) -> libwebrtc::video_frame::EncodedVideoCodec {
        match self {
            Self::H264 => libwebrtc::video_frame::EncodedVideoCodec::H264,
            Self::Hevc => libwebrtc::video_frame::EncodedVideoCodec::H265,
        }
    }
}

struct Activations(*mut Option<IMFActivate>, u32);
impl Drop for Activations {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                for slot in std::slice::from_raw_parts_mut(self.0, self.1 as usize) {
                    *slot = None;
                }
                CoTaskMemFree(Some(self.0.cast()));
            }
        }
    }
}
struct Candidate<T = IMFActivate> {
    info: EncoderInfo,
    adapter: Option<Adapter>,
    activation: T,
}
fn info(activation: &IMFActivate, codec: Codec) -> windows::core::Result<EncoderInfo> {
    unsafe {
        let clsid = activation.GetGUID(&MFT_TRANSFORM_CLSID_Attribute)?;
        let mut name = PWSTR::null();
        let mut len = 0;
        activation.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len)?;
        let label = if name.is_null() {
            "Windows hardware video".into()
        } else {
            String::from_utf16_lossy(std::slice::from_raw_parts(name.0, len as usize))
        };
        CoTaskMemFree(Some(name.0.cast()));
        Ok(EncoderInfo {
            // Settings retain their existing IDs, including on multi-adapter systems.
            id: match codec {
                Codec::H264 => format!("mf:{clsid:?}"),
                Codec::Hevc => format!("mf:{clsid:?}:h265"),
            },
            name: label,
            hardware: true,
            codecs: vec![codec.mime().into()],
        })
    }
}
fn enumerate(codec: Codec, adapter: Option<&Adapter>) -> Result<Vec<Candidate>> {
    let mut list = Activations(ptr::null_mut(), 0);
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: codec.subtype(),
    };
    unsafe {
        if let Some(adapter) = adapter {
            adapter::enumerate(adapter, &output, &mut list.0, &mut list.1)?;
        } else {
            MFTEnumEx(
                MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                None,
                Some(&output),
                &mut list.0,
                &mut list.1,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    let mut encoders = Vec::new();
    if !list.0.is_null() {
        for activation in unsafe { std::slice::from_raw_parts(list.0, list.1 as usize) }
            .iter()
            .flatten()
        {
            // One stale registration must not hide the other working encoders.
            if let Ok(info) = info(activation, codec) {
                encoders.push(Candidate {
                    info,
                    adapter: adapter.cloned(),
                    activation: activation.clone(),
                });
            }
        }
    }
    Ok(encoders)
}
fn catalog(codec: Codec) -> Result<Vec<Candidate>> {
    catalog_with(codec, &adapter::all().unwrap_or_default(), enumerate)
}
fn catalog_with<T>(
    codec: Codec,
    adapters: &[Adapter],
    mut enumerate: impl FnMut(Codec, Option<&Adapter>) -> Result<Vec<Candidate<T>>>,
) -> Result<Vec<Candidate<T>>> {
    let legacy = enumerate(codec, None);
    let error = legacy.as_ref().err().cloned();
    let mut candidates = legacy.unwrap_or_default();
    // Include secondary GPUs in capability discovery, without changing stable IDs.
    for adapter in adapters {
        candidates.extend(enumerate(codec, Some(adapter)).unwrap_or_default());
    }
    if candidates.is_empty() {
        if let Some(error) = error {
            return Err(error);
        }
    }
    Ok(candidates)
}
pub fn detect() -> Result<Vec<EncoderInfo>> {
    let _runtime = Runtime::new().map_err(|e| e.to_string())?;
    let mut encoders: Vec<EncoderInfo> = Vec::new();
    for codec in [Codec::H264, Codec::Hevc] {
        for candidate in catalog(codec).unwrap_or_default() {
            if encoders.iter().any(|e| e.id == candidate.info.id) {
                continue;
            }
            if Transform::create(
                candidate.activation,
                Configuration {
                    codec,
                    width: 320,
                    height: 180,
                    fps: 30,
                    bitrate: 1_000_000,
                    bitrate_limit: 1_000_000,
                    color: MediaOptions::default().color_space(),
                },
                Arc::new(|| {}),
                None,
            )
            .is_ok()
            {
                encoders.push(candidate.info);
            }
        }
    }
    Ok(encoders)
}

#[cfg(test)]
pub(super) fn has_adapter_codec(device: &ID3D11Device, mime: &str) -> Result<bool> {
    let adapter = Adapter::from_device(device).map_err(|e| e.to_string())?;
    let codec = [Codec::H264, Codec::Hevc]
        .into_iter()
        .find(|codec| codec.mime() == mime)
        .unwrap();
    Ok(!enumerate(codec, Some(&adapter))?.is_empty())
}

pub(in crate::media::windows) struct Selection {
    requested: String,
    automatic: bool,
    codec: Codec,
    capture: Option<Adapter>,
    capture_error: Option<String>,
    pub report: Option<HardwareEncoderSelection>,
}
impl Selection {
    // A different backend may fall back to any working MFT for the same codec.
    pub fn for_codec(codec: Codec) -> Self {
        let mut selection = Self::new(String::new(), true);
        selection.codec = codec;
        selection
    }
    pub fn new(requested: String, automatic: bool) -> Self {
        Self {
            codec: Codec::from_id(&requested),
            requested,
            automatic,
            capture: None,
            capture_error: None,
            report: None,
        }
    }
    pub fn capture_device(&mut self, device: &ID3D11Device) {
        match Adapter::from_device(device) {
            Ok(adapter) => self.set_capture(Some(adapter), None),
            Err(error) => self.set_capture(
                None,
                Some(format!("Capture adapter identification failed: {error}")),
            ),
        }
    }
    fn set_capture(&mut self, capture: Option<Adapter>, error: Option<String>) {
        if !self
            .capture
            .as_ref()
            .zip(capture.as_ref())
            .is_some_and(|(a, b)| a.matches(b))
        {
            self.report = None;
        }
        self.capture = capture;
        self.capture_error = error;
    }
    pub fn open(
        &mut self,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        bitrate_limit: u32,
        color: crate::media::color::ColorDescription,
        wake: Arc<dyn Fn() + Send + Sync>,
        device: Option<&ID3D11Device>,
    ) -> Result<Transform> {
        if let Some(device) = device {
            self.capture_device(device);
        }
        let configuration = Configuration {
            codec: self.codec,
            width,
            height,
            fps,
            bitrate,
            bitrate_limit,
            color,
        };
        self.try_open(
            device.is_some(),
            |codec, adapter| {
                if let Some(adapter) = adapter {
                    enumerate(codec, Some(adapter))
                } else {
                    catalog(codec)
                }
            },
            |candidate| {
                Transform::create(
                    candidate.activation.clone(),
                    configuration,
                    wake.clone(),
                    device,
                )
                .map_err(|e| e.to_string())
            },
        )
    }
    fn try_open<T, R>(
        &mut self,
        gpu: bool,
        mut enumerate: impl FnMut(Codec, Option<&Adapter>) -> Result<Vec<Candidate<T>>>,
        mut open: impl FnMut(&Candidate<T>) -> Result<R>,
    ) -> Result<R> {
        let mut errors = self.capture_error.clone().into_iter().collect::<Vec<_>>();
        let capture = self.capture.clone();
        // A CPU fallback keeps the capture identity and reopens the same adapter's
        // encoder first. A new capture device resets the preference above.
        let preferred = self
            .report
            .as_ref()
            .map(|r| r.encoder.as_str())
            .unwrap_or(&self.requested)
            .to_string();
        for scope in capture
            .as_ref()
            .map(Some)
            .into_iter()
            .chain(std::iter::once(None))
        {
            let matched = scope.is_some();
            let mut candidates = match enumerate(self.codec, scope) {
                Ok(candidates) => candidates,
                Err(error) => {
                    errors.push(error);
                    continue;
                }
            };
            if matched {
                candidates.sort_by_key(|c| c.info.id != preferred);
            }
            for candidate in candidates {
                if !candidate
                    .info
                    .codecs
                    .iter()
                    .any(|codec| codec == self.codec.mime())
                {
                    continue;
                }
                if (!matched || !self.automatic)
                    && !self.requested.is_empty()
                    && candidate.info.id != self.requested
                {
                    continue;
                }
                // Never deliberately submit textures to a known different adapter.
                if gpu
                    && capture
                        .as_ref()
                        .zip(candidate.adapter.as_ref())
                        .is_some_and(|(a, b)| !a.matches(b))
                {
                    continue;
                }
                match open(&candidate) {
                    Ok(value) => {
                        self.report = Some(HardwareEncoderSelection {
                            requested: self.requested.clone(),
                            encoder: candidate.info.id,
                            name: candidate.info.name,
                            capture_adapter: capture.as_ref().map(Adapter::label),
                            encoder_adapter: candidate.adapter.as_ref().map(Adapter::label),
                            adapter_matched: capture
                                .as_ref()
                                .zip(candidate.adapter.as_ref())
                                .is_some_and(|(a, b)| a.matches(b)),
                            fallback: (!matched && !errors.is_empty()).then(|| errors.join("; ")),
                        });
                        return Ok(value);
                    }
                    Err(error) => errors.push(format!("{}: {error}", candidate.info.name)),
                }
            }
            if matched {
                errors.push("No usable hardware encoder for the capture adapter and requested codec/selection".into());
            }
        }
        errors.push("Selected hardware encoder is unavailable".into());
        Err(format!(
            "Hardware encoder initialization failed: {}",
            errors.join("; ")
        ))
    }
}

#[cfg(test)]
mod tests;
