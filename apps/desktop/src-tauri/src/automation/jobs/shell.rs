//! Shell selection and per-process encoding defaults.
use std::io;
use tokio::process::Command;

pub(super) fn commands(script: &str) -> Vec<Command> {
    #[cfg(windows)]
    {
        // Keep the launch barrier ahead of the user script: the job manager must
        // own the process tree before any user code can run. UTF-8 without a BOM
        // covers redirected stdout/stderr and PowerShell-to-native pipelines.
        let script = format!(
            "if ([Console]::OpenStandardInput().ReadByte() -ne 0) {{ exit 1 }}; \
             $OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = \
             [System.Text.UTF8Encoding]::new($false); \
             $PSDefaultParameterValues['*:Encoding'] = 'utf8'; \
             & {{\n{script}\n}}"
        );
        ["pwsh.exe", "powershell.exe"]
            .into_iter()
            .map(|program| {
                let mut command = Command::new(program);
                command.args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &script,
                ]);
                command
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        vec![command]
    }
}

pub(super) fn spawn_with<T>(
    commands: Vec<Command>,
    mut spawn: impl FnMut(&mut Command) -> io::Result<T>,
) -> io::Result<T> {
    let mut missing = io::Error::new(io::ErrorKind::NotFound, "No Shell available");
    for mut command in commands {
        match spawn(&mut command) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => missing = error,
            // Only retry a missing executable, never a script exit or a launch
            // failure such as denied access to an installed interpreter.
            result => return result,
        }
    }
    Err(missing)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn prefers_pwsh_without_starting_powershell() {
        let mut started = Vec::new();
        spawn_with(commands("exit 7"), |command| {
            started.push(command.as_std().get_program().to_owned());
            Ok(())
        })
        .unwrap();
        assert_eq!(started, ["pwsh.exe"]);
    }

    #[test]
    fn missing_pwsh_falls_back_to_powershell() {
        let mut started = Vec::new();
        spawn_with(commands("exit 7"), |command| {
            started.push(command.as_std().get_program().to_owned());
            if started.len() == 1 {
                Err(io::Error::from(io::ErrorKind::NotFound))
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(started, ["pwsh.exe", "powershell.exe"]);
    }

    #[test]
    fn installed_shell_launch_errors_do_not_trigger_fallback() {
        for kind in [io::ErrorKind::PermissionDenied, io::ErrorKind::InvalidInput] {
            let mut attempts = 0;
            let result: io::Result<()> = spawn_with(commands("exit 7"), |_| {
                attempts += 1;
                Err(io::Error::from(kind))
            });
            assert_eq!(result.unwrap_err().kind(), kind);
            assert_eq!(attempts, 1);
        }
    }

    #[test]
    fn missing_both_shells_returns_error() {
        let mut attempts = 0;
        let result: io::Result<()> = spawn_with(commands("exit 7"), |_| {
            attempts += 1;
            Err(io::Error::from(io::ErrorKind::NotFound))
        });
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(attempts, 2);
    }
}
