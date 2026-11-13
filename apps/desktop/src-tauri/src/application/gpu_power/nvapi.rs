mod ffi;
#[cfg(test)]
mod tests;

use super::{Power, Profile, Profiles, Result, MAX_PERFORMANCE};
use ffi::*;
use sha2::{Digest, Sha256};
use std::ptr::null_mut;
use windows::{
    core::{s, w},
    Win32::{
        Foundation::{FreeLibrary, ERROR_MOD_NOT_FOUND, HMODULE},
        System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32},
    },
};

struct Library(HMODULE);
impl Drop for Library {
    fn drop(&mut self) {
        let _ = unsafe { FreeLibrary(self.0) };
    }
}

struct Api {
    _library: Library,
    initialized: bool,
    #[cfg(test)]
    query: Query,
    unload: Unload,
    error_message: ErrorMessage,
    create_session: CreateSession,
    destroy_session: SessionCall,
    load: SessionCall,
    save: SessionCall,
    base: GetBase,
    find: FindApplication,
    profile: GetProfile,
    create_profile: CreateProfile,
    create_application: CreateApplication,
    get_setting: GetSetting,
    set_setting: SetSetting,
}

impl Api {
    fn open() -> Result<Option<Self>> {
        let name = if cfg!(target_pointer_width = "64") {
            w!("nvapi64.dll")
        } else {
            w!("nvapi.dll")
        };
        // Never search the executable directory or PATH for a driver DLL.
        let library = match unsafe { LoadLibraryExW(name, None, LOAD_LIBRARY_SEARCH_SYSTEM32) } {
            Ok(library) => Library(library),
            Err(error) if error.code() == ERROR_MOD_NOT_FOUND.to_hresult() => return Ok(None),
            Err(error) => return Err(format!("Load NVAPI: {error}")),
        };
        let query: Query = unsafe {
            std::mem::transmute(
                GetProcAddress(library.0, s!("nvapi_QueryInterface"))
                    .ok_or("NVAPI query interface is unavailable")?,
            )
        };
        macro_rules! resolve {
            ($id:expr, $kind:ty) => {{
                let id: u32 = $id;
                let pointer = unsafe { query(id) };
                if pointer.is_null() {
                    return Err(format!("NVAPI interface {id:#x} is unavailable"));
                }
                // Each ID/signature is from NVIDIA's published interface table.
                unsafe { std::mem::transmute::<*mut std::ffi::c_void, $kind>(pointer) }
            }};
        }
        let initialize = resolve!(0x0150_e828, Initialize);
        let mut api = Self {
            initialized: false,
            #[cfg(test)]
            query,
            unload: resolve!(0xd22b_dd7e, Unload),
            error_message: resolve!(0x6c2d_048c, ErrorMessage),
            create_session: resolve!(0x0694_d52e, CreateSession),
            destroy_session: resolve!(0xdad9_cff8, SessionCall),
            load: resolve!(0x375d_bd6b, SessionCall),
            save: resolve!(0xfcbc_7e14, SessionCall),
            base: resolve!(0xda84_66a0, GetBase),
            find: resolve!(0xeee5_66b2, FindApplication),
            profile: resolve!(0x61cd_6fd6, GetProfile),
            create_profile: resolve!(0xcc17_6068, CreateProfile),
            create_application: resolve!(0x4347_a9de, CreateApplication),
            get_setting: resolve!(0x73bf_8338, GetSetting),
            set_setting: resolve!(0x577d_d202, SetSetting),
            _library: library,
        };
        let status = unsafe { initialize() };
        if matches!(status, -2 | -3 | -6) {
            return Ok(None); // Missing driver, implementation or NVIDIA hardware.
        }
        api.check(status, "Initialize")?;
        api.initialized = true;
        Ok(Some(api))
    }

    fn check(&self, status: Status, operation: &str) -> Result<()> {
        if status == 0 {
            return Ok(());
        }
        let mut message = [0u8; 64];
        unsafe { (self.error_message)(status, message.as_mut_ptr()) };
        let end = message
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(message.len());
        Err(format!(
            "NVAPI {operation}: {status} ({})",
            String::from_utf8_lossy(&message[..end])
        ))
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { (self.unload)() };
        }
    }
}

pub(super) struct Driver {
    api: Api,
    session: Handle,
    base: Handle,
}

impl Driver {
    pub(super) fn open() -> Result<Option<Self>> {
        let Some(api) = Api::open()? else {
            return Ok(None);
        };
        let mut session = null_mut();
        api.check(
            unsafe { (api.create_session)(&mut session) },
            "CreateSession",
        )?;
        let mut driver = Self {
            api,
            session,
            base: null_mut(),
        };
        driver
            .api
            .check(unsafe { (driver.api.load)(session) }, "LoadSettings")?;
        driver.api.check(
            unsafe { (driver.api.base)(session, &mut driver.base) },
            "GetBaseProfile",
        )?;
        Ok(Some(driver))
    }

    fn power(&self, handle: Handle) -> Result<Option<Power>> {
        let mut setting = Setting::default();
        let status = unsafe {
            (self.api.get_setting)(self.session, handle, PREFERRED_PSTATE_ID, &mut setting)
        };
        if status == SETTING_NOT_FOUND {
            return Ok(None);
        }
        self.api.check(status, "GetSetting")?;
        if setting.kind != 0 {
            return Err("NVIDIA power preference is not a DWORD".into());
        }
        Ok(Some(Power {
            value: setting.current_value[0],
            location: setting.location,
        }))
    }
}

fn unicode(value: &str) -> Result<[u16; 2048]> {
    let encoded: Vec<_> = value.encode_utf16().collect();
    if encoded.len() >= 2048 || encoded.contains(&0) {
        return Err("NVIDIA application path/name is too long or contains a NUL".into());
    }
    let mut result = [0; 2048];
    result[..encoded.len()].copy_from_slice(&encoded);
    Ok(result)
}

fn string(value: &[u16]) -> Result<String> {
    let end = value
        .iter()
        .position(|ch| *ch == 0)
        .ok_or("Unterminated NVAPI string")?;
    String::from_utf16(&value[..end]).map_err(|error| error.to_string())
}

impl Profiles for Driver {
    fn find(&mut self, executable: &str) -> Result<Option<Profile>> {
        let path = unicode(executable)?;
        let mut handle = null_mut();
        let mut application = Application::default();
        let status =
            unsafe { (self.api.find)(self.session, path.as_ptr(), &mut handle, &mut application) };
        if status == APPLICATION_NOT_FOUND {
            return Ok(None);
        }
        self.api.check(status, "FindApplicationByName")?;
        let mut info = ProfileInfo::default();
        self.api.check(
            unsafe { (self.api.profile)(self.session, handle, &mut info) },
            "GetProfileInfo",
        )?;
        Ok(Some(Profile {
            id: handle as usize,
            base: handle == self.base,
            application: string(&application.name)?,
            applications: info.applications,
            power: self.power(handle)?,
        }))
    }

    fn create(&mut self, executable: &str) -> Result<Profile> {
        let digest = format!(
            "{:x}",
            Sha256::digest(super::path_key(executable).as_bytes())
        );
        let mut info = ProfileInfo {
            name: unicode(&format!("Weblink - {}", &digest[..16]))?,
            ..Default::default()
        };
        let mut handle = null_mut();
        self.api.check(
            unsafe { (self.api.create_profile)(self.session, &mut info, &mut handle) },
            "CreateProfile",
        )?;
        if handle.is_null() || handle == self.base {
            return Err("NVAPI returned an invalid application profile".into());
        }
        let mut application = Application {
            name: unicode(executable)?,
            friendly: unicode("Weblink")?,
            ..Default::default()
        };
        self.api.check(
            unsafe { (self.api.create_application)(self.session, handle, &mut application) },
            "CreateApplication",
        )?;
        Ok(Profile {
            id: handle as usize,
            base: false,
            application: executable.into(),
            applications: 1,
            power: None,
        })
    }

    fn set_power(&mut self, profile: &Profile) -> Result<()> {
        let handle = profile.id as Handle;
        if handle.is_null() || handle == self.base || profile.base || profile.applications != 1 {
            return Err("Refusing to write a global/shared NVIDIA profile".into());
        }
        let mut setting = Setting {
            id: PREFERRED_PSTATE_ID,
            location: MAX_PERFORMANCE.location,
            ..Default::default()
        };
        setting.current_value[0] = MAX_PERFORMANCE.value;
        self.api.check(
            unsafe { (self.api.set_setting)(self.session, handle, &mut setting) },
            "Set application power",
        )
    }

    fn save(&mut self) -> Result<()> {
        self.api
            .check(unsafe { (self.api.save)(self.session) }, "SaveSettings")?;
        self.api
            .check(unsafe { (self.api.load)(self.session) }, "ReloadSettings")
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        unsafe { (self.api.destroy_session)(self.session) };
    }
}
