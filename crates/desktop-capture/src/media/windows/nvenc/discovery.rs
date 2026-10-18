use super::super::mf::{
    encoders::Codec,
    transform::{Configuration, Runtime},
};
use super::{Encoder, H264, HEVC};
use crate::media::{EncoderInfo, MediaOptions};
use std::sync::Arc;
use windows::{
    core::Interface,
    Win32::{
        Foundation::HMODULE,
        Graphics::{Direct3D::D3D_DRIVER_TYPE_UNKNOWN, Direct3D11::*, Dxgi::*},
    },
};

pub(in crate::media::windows) fn is_nvidia(device: &ID3D11Device) -> bool {
    (|| -> windows::core::Result<bool> {
        let dxgi: IDXGIDevice = device.cast()?;
        Ok(unsafe { dxgi.GetAdapter()?.GetDesc()?.VendorId == 0x10de })
    })()
    .unwrap_or(false)
}

pub(in crate::media::windows) fn detect() -> Vec<EncoderInfo> {
    let Ok(_runtime) = Runtime::new() else {
        return Vec::new();
    };
    let Ok(factory) = (unsafe { CreateDXGIFactory1::<IDXGIFactory1>() }) else {
        return Vec::new();
    };
    let mut available = [false; 2];
    let mut index = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
        index += 1;
        let Ok(desc) = (unsafe { adapter.GetDesc1() }) else {
            continue;
        };
        if desc.VendorId != 0x10de || desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
            continue;
        }
        let (mut device, mut context) = (None, None);
        if unsafe {
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .is_err()
        {
            continue;
        }
        let Some(device) = device else { continue };
        if let Some(lock) = context.and_then(|context| context.cast::<ID3D11Multithread>().ok()) {
            unsafe {
                let _ = lock.SetMultithreadProtected(true);
            }
        }
        for (i, codec) in [Codec::H264, Codec::Hevc].into_iter().enumerate() {
            if available[i] {
                continue;
            }
            let configuration = Configuration {
                codec,
                width: 320,
                height: 180,
                fps: 30,
                bitrate: 1_000_000,
                bitrate_limit: 1_000_000,
                color: MediaOptions::default().color_space(),
            };
            // Query + actual initialization. A stale DLL or codec GUID alone is not availability.
            available[i] = Encoder::open(&device, configuration, Arc::new(|| {})).is_ok();
        }
    }
    [
        (H264, "NVIDIA NVENC H.264", "video/h264"),
        (HEVC, "NVIDIA NVENC H.265", "video/h265"),
    ]
    .into_iter()
    .zip(available)
    .filter(|(_, yes)| *yes)
    .map(|((id, name, codec), _)| EncoderInfo {
        id: id.into(),
        name: name.into(),
        hardware: true,
        codecs: vec![codec.into()],
    })
    .collect()
}
