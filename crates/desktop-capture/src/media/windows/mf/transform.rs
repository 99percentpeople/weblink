//! Windows hardware H.264/HEVC transforms. Every instance stays on its owning MTA thread.
use super::encoders::Codec;
use crate::damage::DirtyRect;
use crate::media::latency::CodecControl;
use std::{ptr, sync::Arc};
use windows::{
    core::Interface,
    Win32::{
        Graphics::Direct3D11::ID3D11Device,
        Media::MediaFoundation::*,
        System::{
            Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
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
#[derive(Clone, Copy)]
pub(in crate::media::windows) struct Configuration {
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
    pub bitrate_limit: u32,
    pub color: crate::media::color::ColorDescription,
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
    output_type: IMFMediaType,
    pub width: u32,
    pub height: u32,
    fps: u32,
    ready: u32,
    configuration: Vec<CodecControl>,
    color: crate::media::color::ColorDescription,
    pub device: Option<ID3D11Device>,
    _manager: Option<IMFDXGIDeviceManager>,
    dirty_regions: bool,
    frame_number: u32,
    controls_changed: bool,
}
impl Transform {
    #[cfg(test)]
    pub fn open(
        id: &str,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        bitrate_limit: u32,
        color: crate::media::color::ColorDescription,
        wake: Arc<dyn Fn() + Send + Sync>,
        device: Option<&ID3D11Device>,
    ) -> crate::Result<Self> {
        super::encoders::Selection::new(id.to_string(), false).open(
            width,
            height,
            fps,
            bitrate,
            bitrate_limit,
            color,
            wake,
            device,
        )
    }
    pub(super) fn create(
        activation: IMFActivate,
        configuration: Configuration,
        wake: Arc<dyn Fn() + Send + Sync>,
        device: Option<&ID3D11Device>,
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
                let manager = if let Some(device) = device {
                    if attributes.GetUINT32(&MF_SA_D3D11_AWARE).unwrap_or(0) == 0 {
                        return Err(windows::Win32::Foundation::E_NOINTERFACE.into());
                    }
                    let mut token = 0;
                    let mut manager = None;
                    MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
                    let manager = manager.unwrap();
                    manager.ResetDevice(device, token)?;
                    transform
                        .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;
                    Some(manager)
                } else {
                    None
                };
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
                let mut dirty_regions = false;
                // Only the GPU path currently supplies capture metadata. Memory
                // fallback and software encoding continue to consume full frames.
                if device.is_some() {
                    if let Some(api) = &controls {
                        let control = super::damage::configure(api);
                        dirty_regions =
                            control.accepted && control.actual.is_none_or(|value| value == 1);
                        configuration.push(control);
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
                    output_type,
                    width,
                    height,
                    fps,
                    ready: 0,
                    configuration,
                    color,
                    device: device.cloned(),
                    _manager: manager,
                    dirty_regions,
                    frame_number: 0,
                    controls_changed: false,
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
                    "dirtyRegions" => &CODECAPI_AVEncVideoDirtyRectEnabled,
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
    pub fn input(
        &mut self,
        nv12: &[u8],
        timestamp_us: i64,
        dirty_regions: Option<&[DirtyRect]>,
    ) -> Result<()> {
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
            self.process_input(&sample, dirty_regions)?;
        }
        Ok(())
    }
    pub fn input_gpu(
        &mut self,
        surface: Arc<crate::surface::gpu::Lease<super::gpu::Surface>>,
        timestamp_us: i64,
        dirty_regions: Option<&[DirtyRect]>,
    ) -> Result<()> {
        let sample = super::sample::tracked(surface)?;
        unsafe {
            sample.SetSampleTime(timestamp_us * 10)?;
            sample.SetSampleDuration(10_000_000 / i64::from(self.fps))?;
            self.process_input(&sample, dirty_regions)?;
        }
        Ok(())
    }
    pub fn take_controls_changed(&mut self) -> bool {
        std::mem::take(&mut self.controls_changed)
    }
    fn disable_dirty_regions(&mut self, reason: String) -> Result<()> {
        if let Some(api) = &self.controls {
            unsafe { api.SetValue(&CODECAPI_AVEncVideoDirtyRectEnabled, &VARIANT::from(0_u32)) }?;
        }
        self.dirty_regions = false;
        self.controls_changed = true;
        if let Some(control) = self
            .configuration
            .iter_mut()
            .find(|c| c.name == "dirtyRegions")
        {
            control.accepted = false;
            control.actual = Some(0);
            control.error = Some(reason);
        }
        Ok(())
    }
    fn process_input(
        &mut self,
        sample: &IMFSample,
        dirty_regions: Option<&[DirtyRect]>,
    ) -> Result<()> {
        unsafe {
            let mut annotated = false;
            if self.dirty_regions {
                let blob = super::damage::blob(
                    self.frame_number,
                    (self.width, self.height),
                    dirty_regions,
                );
                match sample.SetBlob(&MFSampleExtension_DirtyRects, &blob) {
                    Ok(()) => annotated = true,
                    Err(error) => self.disable_dirty_regions(format!(
                        "Dirty region attribute rejected: {error}"
                    ))?,
                }
            }
            if let Err(error) = self.transform.ProcessInput(self.input, sample, 0) {
                if !annotated || error.code() == MF_E_NOTACCEPTING {
                    return Err(error);
                }
                // A driver may advertise the control but reject the sample hint.
                // Retry this same full texture once without the optional feature.
                self.disable_dirty_regions(format!("Dirty region input rejected: {error}"))?;
                sample.DeleteItem(&MFSampleExtension_DirtyRects)?;
                self.transform.ProcessInput(self.input, sample, 0)?;
            }
        }
        self.frame_number = self.frame_number.wrapping_add(1);
        self.ready = self.ready.saturating_sub(1);
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
            let Some(sample) = super::output::read(
                &self.transform,
                self.output,
                &self.output_type,
                self.width * self.height * 2,
            )?
            else {
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
