//! Windows hardware H.264/HEVC transforms. Every instance stays on its owning MTA thread.
use super::super::super::EncoderInfo;
use crate::media::latency::CodecControl;
use std::{mem::ManuallyDrop, ptr, sync::Arc};
use windows::{
    core::{Interface, PWSTR},
    Win32::{
        Media::MediaFoundation::*,
        System::{
            Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED},
            Variant::VARIANT,
        },
    },
};
type Result<T> = windows::core::Result<T>;

pub struct Runtime;
impl Runtime {
    pub fn new() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(error);
            }
        }
        Ok(Self)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
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
#[derive(Clone, Copy)]
enum Codec {
    H264,
    Hevc,
}
impl Codec {
    fn mime(self) -> &'static str {
        match self {
            Self::H264 => "video/h264",
            Self::Hevc => "video/h265",
        }
    }
    fn subtype(self) -> windows::core::GUID {
        match self {
            Self::H264 => MFVideoFormat_H264,
            Self::Hevc => MFVideoFormat_HEVC,
        }
    }
    fn profile(self) -> u32 {
        match self {
            Self::H264 => eAVEncH264VProfile_Base.0 as u32,
            Self::Hevc => eAVEncH265VProfile_Main_420_8.0 as u32,
        }
    }
    fn encoded(self) -> libwebrtc::video_frame::EncodedVideoCodec {
        match self {
            Self::H264 => libwebrtc::video_frame::EncodedVideoCodec::H264,
            Self::Hevc => libwebrtc::video_frame::EncodedVideoCodec::H265,
        }
    }
}
struct Configuration {
    codec: Codec,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    bitrate_limit: u32,
    color: crate::media::color::ColorDescription,
}
fn activations(codec: Codec) -> Result<Vec<(EncoderInfo, IMFActivate)>> {
    let mut list = Activations(ptr::null_mut(), 0);
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: codec.subtype(),
    };
    unsafe {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            None,
            Some(&output),
            &mut list.0,
            &mut list.1,
        )?;
    }
    let mut encoders = Vec::new();
    if list.0.is_null() {
        return Ok(encoders);
    }
    for activation in unsafe { std::slice::from_raw_parts(list.0, list.1 as usize) }
        .iter()
        .flatten()
    {
        let clsid = unsafe { activation.GetGUID(&MFT_TRANSFORM_CLSID_Attribute)? };
        let mut name = PWSTR::null();
        let mut len = 0;
        unsafe {
            activation.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len)?;
        }
        let label = if name.is_null() {
            "Windows hardware video".into()
        } else {
            unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(name.0, len as usize)) }
        };
        unsafe {
            CoTaskMemFree(Some(name.0.cast()));
        }
        encoders.push((
            EncoderInfo {
                // Preserve existing H.264 IDs; disambiguate shared multi-codec MFT CLSIDs.
                id: match codec {
                    Codec::H264 => format!("mf:{clsid:?}"),
                    Codec::Hevc => format!("mf:{clsid:?}:h265"),
                },
                name: label,
                hardware: true,
                codecs: vec![codec.mime().into()],
            },
            activation.clone(),
        ));
    }
    Ok(encoders)
}

pub fn detect() -> crate::Result<Vec<EncoderInfo>> {
    let _runtime = Runtime::new().map_err(|e| e.to_string())?;
    let mut encoders = Vec::new();
    for codec in [Codec::H264, Codec::Hevc] {
        // Missing registration for one codec must not hide another working codec.
        for (info, activation) in activations(codec).unwrap_or_default() {
            // Activation and type negotiation exclude stale registrations and missing drivers.
            if Transform::create(
                activation,
                Configuration {
                    codec,
                    width: 320,
                    height: 180,
                    fps: 30,
                    bitrate: 1_000_000,
                    bitrate_limit: 1_000_000,
                    color: crate::media::MediaOptions::default().color_space(),
                },
                Arc::new(|| {}),
            )
            .is_ok()
            {
                encoders.push(info);
            }
        }
    }
    Ok(encoders)
}

pub struct Packet {
    pub bytes: Vec<u8>,
    pub timestamp_us: i64,
    pub keyframe: bool,
}
pub struct Transform {
    pub codec: libwebrtc::video_frame::EncodedVideoCodec,
    transform: IMFTransform,
    activation: IMFActivate,
    events: super::events::Events,
    controls: Option<ICodecAPI>,
    input: u32,
    output: u32,
    pub width: u32,
    pub height: u32,
    fps: u32,
    ready: u32,
    configuration: Vec<CodecControl>,
    color: crate::media::color::ColorDescription,
}
impl Transform {
    pub fn open(
        id: &str,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        bitrate_limit: u32,
        color: crate::media::color::ColorDescription,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> crate::Result<Self> {
        let codec = if id.ends_with(":h265") {
            Codec::Hevc
        } else {
            Codec::H264
        };
        let (_, activation) = activations(codec)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|(info, _)| info.id == id)
            .ok_or("Selected hardware encoder is unavailable")?;
        Self::create(
            activation,
            Configuration {
                codec,
                width,
                height,
                fps,
                bitrate,
                bitrate_limit,
                color,
            },
            wake,
        )
        .map_err(|e| format!("Hardware encoder initialization failed: {e}"))
    }
    fn create(
        activation: IMFActivate,
        configuration: Configuration,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self> {
        let Configuration {
            codec,
            width,
            height,
            fps,
            bitrate,
            bitrate_limit,
            color,
        } = configuration;
        unsafe {
            let transform: IMFTransform = activation.ActivateObject()?;
            // Activation must also be shut down when configuration fails.
            let configure = || -> Result<Self> {
                let attributes = transform.GetAttributes()?;
                attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                let low_latency = attributes.SetUINT32(&MF_LOW_LATENCY, 1);
                let mut configuration = vec![CodecControl {
                    name: "pipelineLowLatency".into(),
                    requested: 1,
                    accepted: low_latency.is_ok(),
                    actual: attributes.GetUINT32(&MF_LOW_LATENCY).ok(),
                    error: low_latency.err().map(|e| e.to_string()),
                }];
                // This path requires rate and keyframe controls, including during probing.
                let controls = Some(transform.cast::<ICodecAPI>()?);
                if let Some(api) = &controls {
                    configuration.push(set_control(
                        api,
                        "lowLatency",
                        &CODECAPI_AVLowLatencyMode,
                        1,
                        true,
                    ));
                    configuration.push(set_control(
                        api,
                        "bFrames",
                        &CODECAPI_AVEncMPVDefaultBPictureCount,
                        0,
                        false,
                    ));
                    configuration.push(set_control(
                        api,
                        "gopFrames",
                        &CODECAPI_AVEncMPVGOPSize,
                        fps.saturating_mul(2),
                        false,
                    ));
                    configuration.push(set_control(
                        api,
                        "rateControl",
                        &CODECAPI_AVEncCommonRateControlMode,
                        eAVEncCommonRateControlMode_CBR.0 as u32,
                        false,
                    ));
                    // Favor real-time screen interaction over compression efficiency.
                    // Optional: a missing driver control must not disable hardware.
                    configuration.push(set_control(
                        api,
                        "qualityVsSpeed",
                        &CODECAPI_AVEncCommonQualityVsSpeed,
                        33,
                        false,
                    ));
                    // Some drivers latch HRD at SetOutputType and silently ignore
                    // later writes. Reserve one frame at the configured ceiling,
                    // not the conservative startup bandwidth estimate; otherwise
                    // a fixed buffer prevents quality recovering as bandwidth grows.
                    configuration.push(set_control(
                        api,
                        "bufferBytes",
                        &CODECAPI_AVEncCommonBufferSize,
                        buffer_bytes(bitrate_limit, fps),
                        false,
                    ));
                }
                let mut input = [0];
                let mut output = [0];
                // Fixed-stream MFTs may return E_NOTIMPL; their stream IDs are zero.
                let _ = transform.GetStreamIDs(&mut input, &mut output);
                let output_type = MFCreateMediaType()?;
                set_video_type(&output_type, &codec.subtype(), width, height, fps)?;
                color.apply_mf(&output_type)?;
                output_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
                output_type.SetUINT32(&MF_MT_MPEG2_PROFILE, codec.profile())?;
                transform.SetOutputType(output[0], &output_type, 0)?;
                let input_type = MFCreateMediaType()?;
                set_video_type(&input_type, &MFVideoFormat_NV12, width, height, fps)?;
                color.apply_mf(&input_type)?;
                input_type.SetUINT32(&MF_MT_DEFAULT_STRIDE, width)?;
                transform.SetInputType(input[0], &input_type, 0)?;
                if let Some(api) = &controls {
                    // Other vendors may require negotiated types before accepting
                    // this optional setting. Keep both paths and read back at runtime.
                    if let Some(control) = configuration
                        .iter_mut()
                        .find(|c| c.name == "bufferBytes" && !c.accepted)
                    {
                        *control = set_control(
                            api,
                            "bufferBytes",
                            &CODECAPI_AVEncCommonBufferSize,
                            buffer_bytes(bitrate_limit, fps),
                            false,
                        );
                    }
                }
                let events = super::events::Events::start(transform.cast()?, wake)?;
                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
                transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
                Ok(Self {
                    codec: codec.encoded(),
                    transform: transform.clone(),
                    activation: activation.clone(),
                    events,
                    controls,
                    input: input[0],
                    output: output[0],
                    width,
                    height,
                    fps,
                    ready: 0,
                    configuration,
                    color,
                })
            };
            let result = configure();
            if result.is_err() {
                let _ = activation.ShutdownObject();
            }
            result
        }
    }
    pub fn control_status(&self) -> Vec<CodecControl> {
        let mut controls = self.configuration.clone();
        if let Some(api) = &self.controls {
            for control in &mut controls {
                if control.name == "pipelineLowLatency" {
                    control.actual = unsafe {
                        self.transform
                            .GetAttributes()
                            .and_then(|a| a.GetUINT32(&MF_LOW_LATENCY))
                    }
                    .ok();
                    continue;
                }
                let guid = match control.name.as_str() {
                    "lowLatency" => &CODECAPI_AVLowLatencyMode,
                    "bFrames" => &CODECAPI_AVEncMPVDefaultBPictureCount,
                    "gopFrames" => &CODECAPI_AVEncMPVGOPSize,
                    "rateControl" => &CODECAPI_AVEncCommonRateControlMode,
                    "qualityVsSpeed" => &CODECAPI_AVEncCommonQualityVsSpeed,
                    "bufferBytes" => &CODECAPI_AVEncCommonBufferSize,
                    _ => continue,
                };
                match unsafe { api.GetValue(guid) } {
                    Ok(value) => {
                        control.actual = if control.name == "lowLatency" {
                            bool::try_from(&value).ok().map(u32::from)
                        } else {
                            u32::try_from(&value).ok()
                        };
                    }
                    Err(error) => {
                        control.actual = None;
                        if control.error.is_none() {
                            control.error = Some(format!("Readback: {error}"));
                        }
                    }
                }
            }
        }
        controls
    }
    pub fn set_bitrate(&mut self, bitrate: u32) -> crate::Result<()> {
        let api = self
            .controls
            .as_ref()
            .ok_or("Hardware encoder has no rate control")?;
        unsafe { api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bitrate)) }
            .map_err(|e| format!("Hardware encoder bitrate update failed: {e}"))?;
        // HRD capacity follows the configured ceiling for this transform's lifetime.
        // Feedback changes only the target rate; changing the ceiling reopens the MFT.
        Ok(())
    }
    pub fn request_keyframe(&self) -> crate::Result<()> {
        let api = self
            .controls
            .as_ref()
            .ok_or("Hardware encoder has no keyframe control")?;
        unsafe { api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1_u32)) }
            .map_err(|e| format!("Hardware encoder keyframe request failed: {e}"))
    }
    pub fn ready(&self) -> bool {
        self.ready > 0
    }
    pub fn input(&mut self, nv12: &[u8], timestamp_us: i64) -> Result<()> {
        unsafe {
            let buffer = MFCreateMemoryBuffer(nv12.len() as u32)?;
            let mut data = ptr::null_mut();
            buffer.Lock(&mut data, None, None)?;
            ptr::copy_nonoverlapping(nv12.as_ptr(), data, nv12.len());
            buffer.Unlock()?;
            buffer.SetCurrentLength(nv12.len() as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(timestamp_us * 10)?;
            sample.SetSampleDuration(10_000_000 / i64::from(self.fps))?;
            self.transform.ProcessInput(self.input, &sample, 0)?;
            self.ready = self.ready.saturating_sub(1);
        }
        Ok(())
    }
    pub fn poll(&mut self) -> Result<Vec<Packet>> {
        let mut packets = Vec::new();
        for event in self.events.take() {
            match event? {
                kind if kind == METransformNeedInput => self.ready = self.ready.saturating_add(1),
                kind if kind == METransformHaveOutput => {
                    if let Some(packet) = self.output()? {
                        packets.push(packet);
                    }
                }
                _ => {}
            }
        }
        Ok(packets)
    }
    fn output(&mut self) -> Result<Option<Packet>> {
        unsafe {
            let info = self.transform.GetOutputStreamInfo(self.output)?;
            let sample = if info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 == 0 {
                let sample = MFCreateSample()?;
                sample.AddBuffer(&MFCreateMemoryBuffer(
                    info.cbSize.max(self.width * self.height * 2),
                )?)?;
                Some(sample)
            } else {
                None
            };
            let mut output = [MFT_OUTPUT_DATA_BUFFER {
                dwStreamID: self.output,
                pSample: ManuallyDrop::new(sample),
                dwStatus: 0,
                pEvents: ManuallyDrop::new(None),
            }];
            let mut flags = 0;
            let result = self.transform.ProcessOutput(0, &mut output, &mut flags);
            let sample = ManuallyDrop::take(&mut output[0].pSample);
            drop(ManuallyDrop::take(&mut output[0].pEvents));
            result?;
            let Some(sample) = sample else {
                return Ok(None);
            };
            let buffer = sample.ConvertToContiguousBuffer()?;
            let mut data = ptr::null_mut();
            let mut len = 0;
            buffer.Lock(&mut data, None, Some(&mut len))?;
            let mut bytes = if len == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(data, len as usize).to_vec()
            };
            buffer.Unlock()?;
            super::bitstream_color::normalize(&mut bytes, self.codec, self.color)
                .map_err(|reason| windows::core::Error::new(MF_E_INVALIDMEDIATYPE, reason))?;
            let keyframe = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0;
            Ok(Some(Packet {
                bytes,
                timestamp_us: sample.GetSampleTime()? / 10,
                keyframe,
            }))
        }
    }
}
fn set_control(
    api: &ICodecAPI,
    name: &str,
    guid: &windows::core::GUID,
    requested: u32,
    boolean: bool,
) -> CodecControl {
    let value = if boolean {
        VARIANT::from(requested != 0)
    } else {
        VARIANT::from(requested)
    };
    let result = unsafe { api.SetValue(guid, &value) };
    CodecControl {
        name: name.into(),
        requested,
        actual: None,
        accepted: result.is_ok(),
        error: result.err().map(|e| e.to_string()),
    }
}
fn buffer_bytes(bitrate_limit: u32, fps: u32) -> u32 {
    // H.264's HRD size is in bytes. Round up to retain a full frame's budget.
    u64::from(bitrate_limit)
        .div_ceil(8 * u64::from(fps.max(1)))
        .max(128) as u32
}
impl Drop for Transform {
    fn drop(&mut self) {
        self.events.stop();
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            if let Ok(shutdown) = self.transform.cast::<IMFShutdown>() {
                let _ = shutdown.Shutdown();
            }
            let _ = self.activation.ShutdownObject();
        }
    }
}
unsafe fn set_video_type(
    media: &IMFMediaType,
    subtype: &windows::core::GUID,
    width: u32,
    height: u32,
    fps: u32,
) -> Result<()> {
    media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
    media.SetGUID(&MF_MT_SUBTYPE, subtype)?;
    media.SetUINT64(
        &MF_MT_FRAME_SIZE,
        (u64::from(width) << 32) | u64::from(height),
    )?;
    media.SetUINT64(&MF_MT_FRAME_RATE, (u64::from(fps) << 32) | 1)?;
    media.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1_u64 << 32) | 1)?;
    media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    Ok(())
}
