//! Device metadata is optional and used only to name a newly created profile.

#[tauri::command]
pub fn application_device_name() -> Option<String> {
    device_name()
}

#[cfg(windows)]
fn device_name() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::System::SystemInformation::{
        ComputerNamePhysicalDnsHostname, GetComputerNameExW,
    };

    let mut length = 0;
    // The sizing call fails with ERROR_MORE_DATA and returns space including NUL.
    unsafe {
        let _ = GetComputerNameExW(ComputerNamePhysicalDnsHostname, None, &mut length);
    }
    if length == 0 {
        return None;
    }
    let mut buffer = vec![0u16; length as usize];
    unsafe {
        GetComputerNameExW(
            ComputerNamePhysicalDnsHostname,
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut length,
        )
        .ok()?;
    }
    let name = String::from_utf16(buffer.get(..length as usize)?).ok()?;
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

#[cfg(not(windows))]
fn device_name() -> Option<String> {
    None
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn reads_local_device_name_without_a_shell() {
        let name = application_device_name().expect("Windows computer name");
        assert!(!name.is_empty());
        assert!(!name.contains('\0'));
    }
}
