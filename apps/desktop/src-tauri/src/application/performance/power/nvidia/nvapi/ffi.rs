//! Minimal DRS ABI from NVIDIA's public NVAPI headers (nvapi.h,
//! nvapi_interface.h and NvApiDriverSettings.h): https://github.com/NVIDIA/nvapi.
//! Only the DWORD power preference is read/written; union storage remains opaque.
use std::ffi::c_void;

pub type Handle = *mut c_void;
pub type Status = i32;
pub const PREFERRED_PSTATE_ID: u32 = 0x1057_eb71;
pub const APPLICATION_NOT_FOUND: Status = -166;
pub const SETTING_NOT_FOUND: Status = -160;

pub const fn version<T>(revision: u32) -> u32 {
    (std::mem::size_of::<T>() as u32) | (revision << 16)
}

// NVDRS_SETTING_V1 is packed to four bytes in the SDK. Each union contains
// a 4-byte length + 4096-byte binary payload (also large enough for a DWORD).
#[repr(C)]
pub struct Setting {
    pub version: u32,
    pub name: [u16; 2048],
    pub id: u32,
    pub kind: u32,
    pub location: u32,
    pub predefined: u32,
    pub predefined_valid: u32,
    pub default_value: [u32; 1025],
    pub current_value: [u32; 1025],
}

#[repr(C)]
pub struct Application {
    pub version: u32,
    pub predefined: u32,
    pub name: [u16; 2048],
    pub friendly: [u16; 2048],
    pub launcher: [u16; 2048],
    pub file_in_folder: [u16; 2048],
    pub flags: u32,
    pub command_line: [u16; 2048],
}

#[repr(C)]
pub struct ProfileInfo {
    pub version: u32,
    pub name: [u16; 2048],
    pub gpu_support: u32,
    pub predefined: u32,
    pub applications: u32,
    pub settings: u32,
}

macro_rules! structure {
    ($name:ty, $revision:expr) => {
        impl Default for $name {
            fn default() -> Self {
                // All fields are integers/arrays, for which zero is valid.
                let mut result: Self = unsafe { std::mem::zeroed() };
                result.version = version::<Self>($revision);
                result
            }
        }
    };
}
structure!(Setting, 1);
structure!(Application, 4);
structure!(ProfileInfo, 1);

const _: () = {
    assert!(std::mem::size_of::<Setting>() == 12320);
    assert!(std::mem::align_of::<Setting>() == 4);
    assert!(std::mem::offset_of!(Setting, current_value) == 8220);
    assert!(std::mem::size_of::<Application>() == 20492);
    assert!(std::mem::offset_of!(Application, command_line) == 16396);
    assert!(std::mem::size_of::<ProfileInfo>() == 4116);
};

pub type Query = unsafe extern "C" fn(u32) -> *mut c_void;
pub type Initialize = unsafe extern "C" fn() -> Status;
pub type Unload = unsafe extern "C" fn() -> Status;
pub type ErrorMessage = unsafe extern "C" fn(Status, *mut u8) -> Status;
pub type CreateSession = unsafe extern "C" fn(*mut Handle) -> Status;
pub type SessionCall = unsafe extern "C" fn(Handle) -> Status;
pub type GetBase = unsafe extern "C" fn(Handle, *mut Handle) -> Status;
pub type FindApplication =
    unsafe extern "C" fn(Handle, *const u16, *mut Handle, *mut Application) -> Status;
pub type GetProfile = unsafe extern "C" fn(Handle, Handle, *mut ProfileInfo) -> Status;
pub type CreateProfile = unsafe extern "C" fn(Handle, *mut ProfileInfo, *mut Handle) -> Status;
pub type CreateApplication = unsafe extern "C" fn(Handle, Handle, *mut Application) -> Status;
pub type GetSetting = unsafe extern "C" fn(Handle, Handle, u32, *mut Setting) -> Status;
pub type SetSetting = unsafe extern "C" fn(Handle, Handle, *mut Setting) -> Status;
