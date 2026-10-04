use crate::application::executable::normalized_path;
use std::{io, path::Path};
use winreg::{
    enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_BINARY},
    RegKey, RegValue,
};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

fn read_command(name: &str) -> io::Result<Option<String>> {
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let result = root
        .open_subkey_with_flags(RUN_KEY, KEY_READ)
        .and_then(|key| key.get_value(name));
    match result {
        Ok(command) => Ok(Some(command)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

// Only direct executable launches are valid. Unquoted paths containing spaces
// are ambiguous on Windows and must be repaired to a quoted registration.
fn executable(command: &str) -> Option<&str> {
    let command = command.trim();
    if let Some(quoted) = command.strip_prefix('"') {
        let (path, arguments) = quoted.split_once('"')?;
        if path.is_empty() || (!arguments.is_empty() && !arguments.starts_with(char::is_whitespace))
        {
            return None;
        }
        Some(path)
    } else {
        command.split_whitespace().next()
    }
}

fn matches_executable(command: &str, current_exe: &Path) -> bool {
    executable(command).is_some_and(|registered| {
        let registered = Path::new(registered);
        registered.is_absolute()
            && normalized_path(registered).eq_ignore_ascii_case(&normalized_path(current_exe))
    })
}

pub fn path_mismatch(name: &str) -> Result<bool, String> {
    let Some(command) = read_command(name).map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(!matches_executable(&command, &current_exe))
}

fn startup_command(exe: &Path) -> String {
    format!("\"{}\" --autostart", exe.display())
}

pub fn enable(name: &str) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = root.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
    key.set_value(name, &startup_command(&exe))
        .map_err(|e| e.to_string())?;
    // Match the autostart plugin's explicit-enable semantics, including a prior
    // Task Manager disable. Reading status never writes either registry value.
    match root.open_subkey_with_flags(APPROVED_KEY, KEY_SET_VALUE) {
        Ok(key) => key
            .set_raw_value(
                name,
                &RegValue {
                    vtype: REG_BINARY,
                    bytes: vec![2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                },
            )
            .map_err(|e| e.to_string())?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_quoted_and_unquoted_direct_launches_of_the_current_executable() {
        let exe = Path::new(r"C:\Weblink\weblink-desktop.exe");
        for command in [
            r"C:\Weblink\weblink-desktop.exe --autostart",
            r#""C:\Weblink\weblink-desktop.exe" --autostart"#,
            r#"  "c:/weblink/WEBLINK-DESKTOP.EXE" --autostart  "#,
            r#""\\?\C:\Weblink\weblink-desktop.exe" --autostart"#,
        ] {
            assert!(matches_executable(command, exe), "{command}");
        }
    }

    #[test]
    fn rejects_old_paths_shell_wrappers_and_invalid_commands() {
        let exe = Path::new(r"C:\Weblink\weblink-desktop.exe");
        for command in [
            r"C:\Old\weblink-desktop.exe --autostart",
            r#"cmd.exe /c "C:\Weblink\weblink-desktop.exe" --autostart"#,
            r"C:\Weblink\weblink-desktop.exe.old --autostart",
            r#""C:\Weblink\weblink-desktop.exe"suffix --autostart"#,
            r#""C:\Weblink\weblink-desktop.exe --autostart"#,
            "weblink-desktop.exe --autostart",
            "",
        ] {
            assert!(!matches_executable(command, exe), "{command}");
        }
    }

    #[test]
    fn repairs_paths_with_spaces_to_an_unambiguous_direct_launch() {
        let exe = Path::new(r"C:\Apps\Weblink 中文\weblink-desktop.exe");
        assert!(!matches_executable(
            r"C:\Apps\Weblink 中文\weblink-desktop.exe --autostart",
            exe
        ));
        let command = startup_command(exe);
        assert_eq!(
            command,
            r#""C:\Apps\Weblink 中文\weblink-desktop.exe" --autostart"#
        );
        assert!(matches_executable(&command, exe));
    }
}
