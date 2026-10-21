#![allow(non_snake_case, unused_variables)]
use super::*;
use std::{cell::RefCell, rc::Rc};
use windows::{
    core::{implement, Ref, HRESULT},
    Win32::Foundation::{E_FAIL, E_NOTIMPL},
};

#[derive(Default)]
struct State {
    calls: usize,
    offers: Vec<IMFMediaType>,
    selected: Option<IMFMediaType>,
    failure: Option<HRESULT>,
    set_failure: Option<HRESULT>,
}

#[implement(IMFTransform)]
struct Driver(Rc<RefCell<State>>);

impl IMFTransform_Impl for Driver_Impl {
    fn GetOutputStreamInfo(&self, stream: u32) -> Result<MFT_OUTPUT_STREAM_INFO> {
        assert_eq!(stream, 7);
        let changed = self.0.borrow().selected.is_some();
        Ok(MFT_OUTPUT_STREAM_INFO {
            dwFlags: if changed {
                0
            } else {
                MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32
            },
            cbSize: if changed { 4096 } else { 0 },
            ..Default::default()
        })
    }
    fn GetOutputAvailableType(&self, stream: u32, index: u32) -> Result<IMFMediaType> {
        assert_eq!(stream, 7);
        self.0
            .borrow()
            .offers
            .get(index as usize)
            .cloned()
            .ok_or_else(|| MF_E_NO_MORE_TYPES.into())
    }
    fn SetOutputType(&self, stream: u32, media: Ref<IMFMediaType>, flags: u32) -> Result<()> {
        assert_eq!((stream, flags), (7, 0));
        let mut state = self.0.borrow_mut();
        if let Some(error) = state.set_failure {
            return Err(error.into());
        }
        state.selected = media.as_ref().cloned();
        Ok(())
    }
    fn ProcessOutput(
        &self,
        flags: u32,
        count: u32,
        output: *mut MFT_OUTPUT_DATA_BUFFER,
        status: *mut u32,
    ) -> Result<()> {
        assert_eq!((flags, count), (0, 1));
        let mut state = self.0.borrow_mut();
        state.calls += 1;
        unsafe {
            assert_eq!((*output).dwStreamID, 7);
            *status = 0;
            if let Some(error) = state.failure {
                return Err(error.into());
            }
            if state.selected.is_none() {
                assert!((*output).pSample.is_none());
                (*output).dwStatus = MFT_OUTPUT_DATA_BUFFER_FORMAT_CHANGE.0 as u32;
                return Err(MF_E_TRANSFORM_STREAM_CHANGE.into());
            }
            let sample = (*output)
                .pSample
                .as_ref()
                .expect("New allocation model requires a caller sample");
            let buffer = sample.GetBufferByIndex(0)?;
            assert!(
                buffer.GetMaxLength()? >= 4096,
                "New buffer requirements were ignored"
            );
            buffer.SetCurrentLength(4)?;
            sample.SetSampleTime(123_456)?;
        }
        Ok(())
    }
    // These methods are outside the output-event contract under test.
    fn GetStreamLimits(&self, _: *mut u32, _: *mut u32, _: *mut u32, _: *mut u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetStreamCount(&self, _: *mut u32, _: *mut u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetStreamIDs(&self, _: u32, _: *mut u32, _: u32, _: *mut u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetInputStreamInfo(&self, _: u32, _: *mut MFT_INPUT_STREAM_INFO) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetAttributes(&self) -> Result<IMFAttributes> {
        Err(E_NOTIMPL.into())
    }
    fn GetInputStreamAttributes(&self, _: u32) -> Result<IMFAttributes> {
        Err(E_NOTIMPL.into())
    }
    fn GetOutputStreamAttributes(&self, _: u32) -> Result<IMFAttributes> {
        Err(E_NOTIMPL.into())
    }
    fn DeleteInputStream(&self, _: u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn AddInputStreams(&self, _: u32, _: *const u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetInputAvailableType(&self, _: u32, _: u32) -> Result<IMFMediaType> {
        Err(E_NOTIMPL.into())
    }
    fn SetInputType(&self, _: u32, _: Ref<IMFMediaType>, _: u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetInputCurrentType(&self, _: u32) -> Result<IMFMediaType> {
        Err(E_NOTIMPL.into())
    }
    fn GetOutputCurrentType(&self, _: u32) -> Result<IMFMediaType> {
        Err(E_NOTIMPL.into())
    }
    fn GetInputStatus(&self, _: u32) -> Result<u32> {
        Err(E_NOTIMPL.into())
    }
    fn GetOutputStatus(&self) -> Result<u32> {
        Err(E_NOTIMPL.into())
    }
    fn SetOutputBounds(&self, _: i64, _: i64) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn ProcessEvent(&self, _: u32, _: Ref<IMFMediaEvent>) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn ProcessMessage(&self, _: MFT_MESSAGE_TYPE, _: usize) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn ProcessInput(&self, _: u32, _: Ref<IMFSample>, _: u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
}

fn format() -> IMFMediaType {
    let media = unsafe { MFCreateMediaType() }.unwrap();
    unsafe {
        media
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .unwrap();
        media.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).unwrap();
        media
            .SetUINT64(&MF_MT_FRAME_SIZE, (1620u64 << 32) | 1080)
            .unwrap();
        media
            .SetUINT64(&MF_MT_FRAME_RATE, (30u64 << 32) | 1)
            .unwrap();
        media
            .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
            .unwrap();
        media.SetUINT32(&MF_MT_AVG_BITRATE, 1_000_000).unwrap();
        media
            .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32)
            .unwrap();
    }
    crate::media::MediaOptions::default()
        .color_space()
        .apply_mf(&media)
        .unwrap();
    media
}
fn driver(state: State) -> (IMFTransform, Rc<RefCell<State>>) {
    let state = Rc::new(RefCell::new(state));
    (Driver(state.clone()).into(), state)
}

#[test]
fn format_change_renegotiates_once_then_obeys_the_next_output_event() {
    let _runtime = super::super::transform::Runtime::new().unwrap();
    let expected = format();
    let proposal = unsafe { MFCreateMediaType() }.unwrap();
    unsafe {
        // Intel-style startup proposal: unchanged attributes can be absent.
        proposal
            .SetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &[1, 2, 3, 4])
            .unwrap();
        proposal
            .SetUINT64(&MF_MT_FRAME_RATE, (30_000u64 << 32) | 1000)
            .unwrap();
    }
    let (transform, state) = driver(State {
        offers: vec![proposal],
        ..Default::default()
    });
    assert!(read(&transform, 7, &expected, 16).unwrap().is_none());
    assert_eq!(
        state.borrow().calls,
        1,
        "Do not call an async MFT without a fresh event"
    );
    let selected = state.borrow().selected.clone().unwrap();
    unsafe {
        assert_eq!(
            selected.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER).unwrap(),
            4
        );
        assert_eq!(
            selected.GetUINT64(&MF_MT_FRAME_SIZE).unwrap(),
            (1620u64 << 32) | 1080
        );
    }
    // A subsequent HaveOutput now requires a larger caller-allocated sample.
    let sample = read(&transform, 7, &expected, 16).unwrap().unwrap();
    unsafe {
        assert_eq!(sample.GetSampleTime().unwrap(), 123_456);
    }
    assert_eq!(state.borrow().calls, 2);
}

#[test]
fn stream_change_does_not_silently_change_the_webrtc_video_contract() {
    let _runtime = super::super::transform::Runtime::new().unwrap();
    let expected = format();
    for change in 0..6 {
        let incompatible = format();
        unsafe {
            match change {
                0 => incompatible
                    .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_HEVC)
                    .unwrap(),
                1 => incompatible
                    .SetUINT64(&MF_MT_FRAME_SIZE, (1920u64 << 32) | 1080)
                    .unwrap(),
                2 => incompatible
                    .SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)
                    .unwrap(),
                3 => incompatible
                    .SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_0_255.0 as u32)
                    .unwrap(),
                4 => incompatible
                    .SetUINT64(&MF_MT_FRAME_RATE, 30u64 << 32)
                    .unwrap(),
                _ => incompatible
                    .SetUINT64(&MF_MT_FRAME_RATE, (60u64 << 32) | 1)
                    .unwrap(),
            }
        }
        let (transform, state) = driver(State {
            offers: vec![incompatible],
            ..Default::default()
        });
        assert_eq!(
            read(&transform, 7, &expected, 16).unwrap_err().code(),
            MF_E_INVALIDMEDIATYPE
        );
        assert!(state.borrow().selected.is_none());
    }
}

#[test]
fn skips_incompatible_proposals_and_preserves_real_driver_failures() {
    let _runtime = super::super::transform::Runtime::new().unwrap();
    let expected = format();
    let incompatible = format();
    unsafe {
        incompatible
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_HEVC)
            .unwrap();
    }
    let (transform, state) = driver(State {
        offers: vec![incompatible, format()],
        ..Default::default()
    });
    assert!(read(&transform, 7, &expected, 16).unwrap().is_none());
    assert!(state.borrow().selected.is_some());
    for set_failure in [false, true] {
        let (transform, state) = driver(State {
            offers: vec![format()],
            failure: (!set_failure).then_some(E_FAIL),
            set_failure: set_failure.then_some(E_FAIL),
            ..Default::default()
        });
        assert_eq!(
            read(&transform, 7, &expected, 16).unwrap_err().code(),
            E_FAIL
        );
        assert!(state.borrow().selected.is_none());
        assert_eq!(state.borrow().calls, 1);
    }
}
