//! DXGI adapter identity and optional adapter-scoped MFT enumeration.
use std::{ffi::c_void, ptr, sync::OnceLock};
use windows::{
    core::{s, w, Interface, Result, GUID, HRESULT},
    Win32::{
        Foundation::LUID,
        Graphics::{Direct3D11::ID3D11Device, Dxgi::*},
        Media::MediaFoundation::*,
        System::LibraryLoader::{GetModuleHandleW, GetProcAddress},
    },
};

#[derive(Clone, Debug)]
pub(in crate::media::windows) struct Adapter {
    pub luid: LUID,
    pub name: String,
}
impl Adapter {
    pub fn from_device(device: &ID3D11Device) -> Result<Self> {
        let device: IDXGIDevice = device.cast()?;
        unsafe { Self::from_dxgi(&device.GetAdapter()?) }
    }
    fn from_dxgi(adapter: &IDXGIAdapter) -> Result<Self> {
        let desc = unsafe { adapter.GetDesc()? };
        let len = desc.Description.iter().position(|c| *c == 0).unwrap_or(128);
        Ok(Self {
            luid: desc.AdapterLuid,
            name: String::from_utf16_lossy(&desc.Description[..len]),
        })
    }
    pub fn matches(&self, other: &Self) -> bool {
        self.luid.LowPart == other.luid.LowPart && self.luid.HighPart == other.luid.HighPart
    }
    pub fn label(&self) -> String {
        format!(
            "{} [{:08x}:{:08x}]",
            self.name, self.luid.HighPart as u32, self.luid.LowPart
        )
    }
    pub fn attributes(&self) -> Result<IMFAttributes> {
        let mut attributes = None;
        unsafe {
            MFCreateAttributes(&mut attributes, 1)?;
            let attributes = attributes.unwrap();
            // MFT_ENUM_ADAPTER_LUID is a LUID blob, not a UINT64 attribute.
            let mut bytes = [0; 8];
            bytes[..4].copy_from_slice(&self.luid.LowPart.to_le_bytes());
            bytes[4..].copy_from_slice(&self.luid.HighPart.to_le_bytes());
            attributes.SetBlob(&MFT_ENUM_ADAPTER_LUID, &bytes)?;
            Ok(attributes)
        }
    }
}

pub(super) fn all() -> Result<Vec<Adapter>> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
    let mut adapters = Vec::new();
    let mut index = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(index) } {
        index += 1;
        if let Ok(adapter) = Adapter::from_dxgi(&adapter.cast()?) {
            adapters.push(adapter);
        }
    }
    Ok(adapters)
}

type Enumerate = unsafe extern "system" fn(
    GUID,
    u32,
    *const MFT_REGISTER_TYPE_INFO,
    *const MFT_REGISTER_TYPE_INFO,
    *mut c_void,
    *mut *mut Option<IMFActivate>,
    *mut u32,
) -> HRESULT;

pub(super) unsafe fn enumerate(
    adapter: &Adapter,
    output: &MFT_REGISTER_TYPE_INFO,
    list: *mut *mut Option<IMFActivate>,
    count: *mut u32,
) -> crate::Result<()> {
    static ENUMERATE: OnceLock<Option<Enumerate>> = OnceLock::new();
    // mfplat is already imported by MFStartup and stays loaded for the process.
    // Resolve MFTEnum2 optionally so older Windows can keep using MFTEnumEx.
    let enumerate = ENUMERATE
        .get_or_init(|| {
            let module = unsafe { GetModuleHandleW(w!("mfplat.dll")) }.ok()?;
            let address = unsafe { GetProcAddress(module, s!("MFTEnum2")) }?;
            Some(unsafe {
                std::mem::transmute::<unsafe extern "system" fn() -> isize, Enumerate>(address)
            })
        })
        .ok_or("Adapter-scoped hardware encoder enumeration is unavailable")?;
    let attributes = adapter.attributes().map_err(|e| e.to_string())?;
    unsafe {
        enumerate(
            MFT_CATEGORY_VIDEO_ENCODER,
            (MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER).0 as u32,
            ptr::null(),
            output,
            attributes.as_raw(),
            list,
            count,
        )
        .ok()
        .map_err(|e| e.to_string())
    }
}
