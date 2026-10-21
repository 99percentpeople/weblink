//! One output call per METransformHaveOutput, including format-change notices.
use std::mem::ManuallyDrop;
use windows::{
    core::{Result, GUID},
    Win32::{
        Media::MediaFoundation::*,
        System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT},
    },
};

pub(super) fn read(
    transform: &IMFTransform,
    stream: u32,
    expected: &IMFMediaType,
    minimum_size: u32,
) -> Result<Option<IMFSample>> {
    unsafe {
        // Renegotiation may change both the buffer size and who allocates samples.
        let info = transform.GetOutputStreamInfo(stream)?;
        let sample = if info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 == 0 {
            let sample = MFCreateSample()?;
            sample.AddBuffer(&MFCreateMemoryBuffer(info.cbSize.max(minimum_size))?)?;
            Some(sample)
        } else {
            None
        };
        let mut output = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: stream,
            pSample: ManuallyDrop::new(sample),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        }];
        let mut flags = 0;
        let result = transform.ProcessOutput(0, &mut output, &mut flags);
        let sample = ManuallyDrop::take(&mut output[0].pSample);
        drop(ManuallyDrop::take(&mut output[0].pEvents));
        if let Err(error) = result {
            if error.code() != MF_E_TRANSFORM_STREAM_CHANGE {
                return Err(error);
            }
            drop(sample);
            renegotiate(transform, stream, expected)?;
            // This notification produced no sample. The asynchronous MFT signals
            // the next output separately; calling again here can be E_UNEXPECTED.
            return Ok(None);
        }
        Ok(sample)
    }
}

fn renegotiate(transform: &IMFTransform, stream: u32, expected: &IMFMediaType) -> Result<()> {
    unsafe {
        let mut index = 0;
        loop {
            let available = match transform.GetOutputAvailableType(stream, index) {
                Ok(media) => media,
                Err(error) if error.code() == MF_E_NO_MORE_TYPES => {
                    return Err(windows::core::Error::new(
                        MF_E_INVALIDMEDIATYPE,
                        "Hardware encoder changed its negotiated video format",
                    ));
                }
                Err(error) => return Err(error),
            };
            index += 1;
            let media = MFCreateMediaType()?;
            // Driver proposals may omit unchanged attributes, and may add their
            // sequence header. Retain those additions without changing the codec,
            // dimensions, profile or colour contract already advertised to WebRTC.
            expected.CopyAllItems(&media)?;
            for item in 0..available.GetCount()? {
                let mut key = GUID::zeroed();
                let mut value = PROPVARIANT::default();
                let result = available
                    .GetItemByIndex(item, &mut key, Some(&mut value))
                    .and_then(|()| media.SetItem(&key, &value));
                let cleared = PropVariantClear(&mut value);
                result?;
                cleared?;
            }
            if compatible(&media, expected)? {
                transform.SetOutputType(stream, &media, 0)?;
                return Ok(());
            }
        }
    }
}

unsafe fn compatible(media: &IMFMediaType, expected: &IMFMediaType) -> Result<bool> {
    for key in [MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE] {
        if media.GetGUID(&key)? != expected.GetGUID(&key)? {
            return Ok(false);
        }
    }
    if media.GetUINT64(&MF_MT_FRAME_SIZE)? != expected.GetUINT64(&MF_MT_FRAME_SIZE)? {
        return Ok(false);
    }
    let rate = media.GetUINT64(&MF_MT_FRAME_RATE)?;
    let expected_rate = expected.GetUINT64(&MF_MT_FRAME_RATE)?;
    if rate as u32 == 0
        || expected_rate as u32 == 0
        || (rate >> 32) * u64::from(expected_rate as u32)
            != (expected_rate >> 32) * u64::from(rate as u32)
    {
        return Ok(false);
    }
    for key in [
        MF_MT_MPEG2_PROFILE,
        MF_MT_INTERLACE_MODE,
        MF_MT_VIDEO_PRIMARIES,
        MF_MT_TRANSFER_FUNCTION,
        MF_MT_YUV_MATRIX,
        MF_MT_VIDEO_NOMINAL_RANGE,
    ] {
        if media.GetUINT32(&key)? != expected.GetUINT32(&key)? {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests;
