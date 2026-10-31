mod input;
mod output;
mod shell;
mod signals;
use output::{Output, Read};
use serde_json::{json, Value};
pub(super) use signals::capabilities;
use signals::Signal;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
struct Job {
    owner: String,
    grant: String,
    cancel: CancellationToken,
    input: input::Input,
    signals: tokio::sync::mpsc::Sender<&'static str>,
    state: Arc<Mutex<JobState>>,
    done: CancellationToken,
}
struct JobState {
    status: &'static str,
    output: Output,
    output_incomplete: bool,
    exit: Option<i32>,
}
/// Holds cancellation responsibility until the caller receives a result or a background handoff.
pub(super) struct StartedJob {
    id: String,
    job: Job,
    guard: tokio_util::sync::DropGuard,
}
impl StartedJob {
    fn background(self) -> Value {
        self.guard.disarm();
        json!({"jobId": self.id})
    }
    pub async fn wait(
        self,
        wait_ms: u64,
        check: impl Fn() -> Result<(), String>,
    ) -> Result<Value, String> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_ms);
        loop {
            // Call cancellation, token revocation and grant expiry remain effective while waiting.
            check()?;
            if self.job.done.is_cancelled() || tokio::time::Instant::now() >= deadline {
                check()?;
                let state = self.job.state.lock().unwrap();
                let mut result = output_page(&state, Read::default())?;
                result["jobId"] = json!(self.id);
                result["background"] = json!(state.status == "running");
                result["stdinStatus"] = json!(self.job.input.status());
                self.guard.disarm();
                return Ok(result);
            }
            tokio::select! {
                _ = self.job.done.cancelled() => {},
                _ = tokio::time::sleep_until(deadline) => {},
                _ = tokio::time::sleep(Duration::from_millis(50)) => {},
            }
        }
    }
}
fn output_page(s: &JobState, read: Read) -> Result<Value, String> {
    let mut page = s.output.read(read)?;
    page["status"] = json!(s.status);
    page["exitCode"] = json!(s.exit);
    page["outputIncomplete"] = json!(s.output_incomplete);
    Ok(page)
}
#[derive(Default)]
pub struct Jobs {
    entries: Mutex<HashMap<String, Job>>,
}
impl Jobs {
    pub fn list(&self) -> Vec<Value> {
        self.entries.lock().unwrap().iter().map(|(id,j)| { let s=j.state.lock().unwrap(); json!({"id":id,"principal":j.owner,"status":s.status,"exitCode":s.exit,"truncated":s.output.truncated()}) }).collect()
    }
    pub fn cancel_grant(&self, grant: &str) {
        for j in self
            .entries
            .lock()
            .unwrap()
            .values()
            .filter(|j| j.grant == grant)
        {
            j.cancel.cancel();
        }
    }
    pub fn stop(&self) {
        for j in self.entries.lock().unwrap().values() {
            j.cancel.cancel();
        }
    }
    pub fn start(&self, owner: &str, grant: &str, args: &Value) -> Result<Value, String> {
        Ok(self.start_waiting(owner, grant, args)?.background())
    }
    pub(super) fn start_waiting(
        &self,
        owner: &str,
        grant: &str,
        args: &Value,
    ) -> Result<StartedJob, String> {
        self.start_with(owner, grant, args, || {
            Ok(shell::commands(
                args["script"].as_str().ok_or("INVALID_ARGUMENTS")?,
            ))
        })
    }
    fn start_with(
        &self,
        owner: &str,
        grant: &str,
        args: &Value,
        command: impl FnOnce() -> Result<Vec<Command>, String>,
    ) -> Result<StartedJob, String> {
        let mut entries = self.entries.lock().unwrap();
        if entries
            .values()
            .filter(|j| j.state.lock().unwrap().status == "running")
            .count()
            >= 10
        {
            return Err("BUSY".into());
        }
        if entries.len() >= 32 {
            entries.retain(|_, j| j.state.lock().unwrap().status == "running");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let commands = command()?;
        // Explicit environment allowlist. Never inherit app/MCP/cloud credentials.
        let env: Vec<_> = std::env::vars_os()
            .filter(|(k, _)| {
                [
                    "PATH",
                    "SYSTEMROOT",
                    "WINDIR",
                    "COMSPEC",
                    "TEMP",
                    "TMP",
                    "USERPROFILE",
                    "HOME",
                    "LANG",
                    "LC_ALL",
                    "PATHEXT",
                ]
                .contains(&k.to_string_lossy().to_ascii_uppercase().as_str())
            })
            .collect();
        let mut child = shell::spawn_with(commands, |command| {
            command
                .env_clear()
                .envs(env.iter().cloned())
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            if let Some(cwd) = args["cwd"].as_str() {
                command.current_dir(cwd);
            }
            #[cfg(unix)]
            command.process_group(0);
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            command.spawn()
        })
        .map_err(|_| "Could not start Shell".to_string())?;
        let process_id = child.id().ok_or("Process unavailable")?;
        #[cfg(windows)]
        let tree = windows_tree::Tree::attach(process_id).map_err(|e| {
            let _ = child.start_kill();
            e
        })?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let state = Arc::new(Mutex::new(JobState {
            status: "running",
            output: Output::default(),
            output_incomplete: false,
            exit: None,
        }));
        let cancel = CancellationToken::new();
        let done = CancellationToken::new();
        let (input, input_receiver) = input::Input::new();
        let (signals, mut signal_receiver) = tokio::sync::mpsc::channel::<&'static str>(8);
        let job = Job {
            owner: owner.into(),
            grant: grant.into(),
            cancel: cancel.clone(),
            input: input.clone(),
            signals,
            state: state.clone(),
            done: done.clone(),
        };
        let started = StartedJob {
            id: id.clone(),
            job: job.clone(),
            guard: cancel.clone().drop_guard(),
        };
        entries.insert(id, job);
        let timeout = Duration::from_millis(args["timeoutMs"].as_u64().unwrap_or(60000));
        tokio::spawn(async move {
            let stdin = child.stdin.take().unwrap();
            let writer = input.clone();
            let writer_cancel = cancel.clone();
            let writer_task = tokio::spawn(async move {
                writer
                    .run(stdin, input_receiver, writer_cancel, cfg!(windows))
                    .await;
            });
            let mut readers = tokio::task::JoinSet::new();
            readers.spawn(drain(stdout, state.clone(), "stdout"));
            readers.spawn(drain(stderr, state.clone(), "stderr"));
            let deadline = tokio::time::Instant::now() + timeout;
            let (status, exit) = loop {
                tokio::select! {
                    biased;
                    _=cancel.cancelled() => break ("cancelled",None),
                    _=tokio::time::sleep_until(deadline) => break ("timed_out",None),
                    result=child.wait() => break ("completed",result.ok().and_then(|s| s.code())),
                    Some(signal)=signal_receiver.recv() => {
                        #[cfg(windows)]
                        {
                            debug_assert_eq!(signal, "TERM");
                            break ("cancelled",None);
                        }
                        #[cfg(unix)]
                        let _ = Command::new("/bin/kill")
                            .args(["-s",signal,"--",&format!("-{process_id}")])
                            .status().await;
                    }
                }
            };
            // Fence new sends as soon as the process stops. The public terminal
            // status still waits for final output collection below.
            cancel.cancel();
            writer_task.abort();
            let _ = writer_task.await;
            input.close();
            // Kill remaining descendants even when the Shell exited first.
            #[cfg(unix)]
            {
                let _ = Command::new("/bin/kill")
                    .args(["-KILL", "--", &format!("-{process_id}")])
                    .status()
                    .await;
            }
            #[cfg(windows)]
            drop(tree);
            let _ = child.kill().await;
            let _ = child.wait().await;
            let incomplete = finish_output(&mut readers, Duration::from_secs(2)).await;
            let mut s = state.lock().unwrap();
            s.output_incomplete = incomplete;
            s.status = status;
            s.exit = exit;
            done.cancel();
        });
        Ok(started)
    }
    pub fn access(
        &self,
        owner: &str,
        grant: &str,
        name: &str,
        args: &Value,
    ) -> Result<Value, String> {
        let entries = self.entries.lock().unwrap();
        let job = entries
            .get(args["jobId"].as_str().ok_or("INVALID_ARGUMENTS")?)
            .filter(|j| j.owner == owner && j.grant == grant)
            .ok_or("PERMISSION_DENIED")?;
        if name == "commands.send" {
            if job.cancel.is_cancelled() || job.state.lock().unwrap().status != "running" {
                return Err("JOB_NOT_RUNNING".into());
            }
            if let Some(signal) = args.get("signal") {
                if args.get("input").is_some() || args.get("eof").is_some() {
                    return Err("INVALID_ARGUMENTS".into());
                }
                match Signal::parse(signal.as_str().ok_or("INVALID_ARGUMENTS")?)? {
                    Signal::Kill => job.cancel.cancel(),
                    signal @ (Signal::Terminate | Signal::Interrupt) => {
                        let signal = if signal == Signal::Terminate {
                            "TERM"
                        } else {
                            "INT"
                        };
                        job.signals.try_send(signal).map_err(|e| match e {
                            tokio::sync::mpsc::error::TrySendError::Full(_) => "BUSY",
                            tokio::sync::mpsc::error::TrySendError::Closed(_) => "JOB_NOT_RUNNING",
                        })?;
                    }
                }
                return Ok(json!({"queued":true,"signal":signal}));
            }
            return job.input.enqueue(args);
        }
        let s = job.state.lock().unwrap();
        if name == "commands.read" {
            let mut page = output_page(&s, Read::parse(args)?)?;
            page["stdinStatus"] = json!(job.input.status());
            return Ok(page);
        }
        let mut status = s.output.metadata();
        status["status"] = json!(s.status);
        status["exitCode"] = json!(s.exit);
        status["outputIncomplete"] = json!(s.output_incomplete);
        status["stdinStatus"] = json!(job.input.status());
        Ok(status)
    }
}
async fn finish_output(readers: &mut tokio::task::JoinSet<bool>, timeout: Duration) -> bool {
    let mut incomplete = false;
    if tokio::time::timeout(timeout, async {
        while let Some(result) = readers.join_next().await {
            incomplete |= !matches!(result, Ok(true));
        }
    })
    .await
    .is_err()
    {
        incomplete = true;
        // Wait for cancellation to finish before publishing a terminal status.
        // Otherwise a late reader could append bytes after clients stop polling.
        readers.shutdown().await;
    }
    incomplete
}
async fn drain(
    mut pipe: impl tokio::io::AsyncRead + Unpin,
    state: Arc<Mutex<JobState>>,
    stream: &'static str,
) -> bool {
    let mut buf = [0u8; 8192];
    loop {
        let Ok(n) = pipe.read(&mut buf).await else {
            return false;
        };
        if n == 0 {
            return true;
        }
        state.lock().unwrap().output.append(&buf[..n], stream);
    }
}
#[cfg(windows)]
mod windows_tree {
    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            JobObjects::*,
            Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
        },
    };
    pub struct Tree(HANDLE);
    unsafe impl Send for Tree {}
    impl Tree {
        pub fn attach(pid: u32) -> Result<Self, String> {
            unsafe {
                let job = CreateJobObjectW(None, None).map_err(|e| e.to_string())?;
                let tree = Self(job);
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of_val(&info) as u32,
                )
                .map_err(|e| e.to_string())?;
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                    .map_err(|e| e.to_string())?;
                let result = AssignProcessToJobObject(job, process).map_err(|e| e.to_string());
                let _ = CloseHandle(process);
                result?;
                Ok(tree)
            }
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    // Exercise real process/pipe/job-object behavior without starting a CLR and
    // PowerShell for every state-machine test. Keep one real Shell smoke below.
    fn fixture_command(mode: &str) -> Command {
        static FIXTURE: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
        let dir = FIXTURE.get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("main.rs");
            std::fs::write(&source, include_str!("jobs/test_process.rs")).unwrap();
            let status = std::process::Command::new(option_env!("RUSTC").unwrap_or("rustc"))
                .args(["--edition=2021", "--crate-name", "weblink_job_fixture"])
                .arg(source)
                .arg("-o")
                .arg(dir.path().join("job-fixture.exe"))
                .status()
                .unwrap();
            assert!(status.success(), "Could not compile native job fixture");
            dir
        });
        let mut command = Command::new(dir.path().join("job-fixture.exe"));
        command.arg(mode);
        command
    }
    fn start_fixture(jobs: &Jobs, mode: &str, args: Value) -> Result<StartedJob, String> {
        // Compile before taking the job registry lock or starting wait deadlines.
        let command = fixture_command(mode);
        jobs.start_with("owner", "grant", &args, || Ok(vec![command]))
    }
    async fn ended(jobs: &Jobs, id: &str) -> Value {
        ended_within(jobs, id, Duration::from_secs(10)).await
    }
    async fn ended_within(jobs: &Jobs, id: &str, timeout: Duration) -> Value {
        let done = jobs.entries.lock().unwrap()[id].done.clone();
        if tokio::time::timeout(timeout, done.cancelled())
            .await
            .is_err()
        {
            let output = jobs.access("owner", "grant", "commands.read", &json!({"jobId":id}));
            jobs.stop();
            panic!("Job did not finish within {timeout:?}: {output:?}");
        }
        jobs.access("owner", "grant", "commands.status", &json!({"jobId":id}))
            .unwrap()
    }
    #[tokio::test]
    #[cfg_attr(
        windows,
        ignore = "Opt-in Windows PowerShell smoke; interpreter startup depends on the host image"
    )]
    async fn real_shell_executes_scripts_and_captures_output() {
        let jobs = Jobs::default();
        #[cfg(unix)]
        let script = "printf shell-output; printf shell-error >&2; exit 7";
        #[cfg(windows)]
        let script =
            "[Console]::Out.Write('shell-output'); [Console]::Error.Write('shell-error'); exit 7";
        let result = jobs
            .start("owner", "grant", &json!({"script":script}))
            .unwrap();
        let id = result["jobId"].as_str().unwrap();
        // A safety bound, not an assertion about a cold Windows Shell's startup
        // time. Run/background deadline behavior is covered by native fixtures.
        let status = ended_within(&jobs, id, Duration::from_secs(30)).await;
        assert_eq!(status["status"], "completed");
        assert_eq!(status["exitCode"], 7);
        let output = jobs
            .access("owner", "grant", "commands.read", &json!({"jobId":id}))
            .unwrap();
        for (stream, expected) in [("stdout", "shell-output"), ("stderr", "shell-error")] {
            let text: String = output["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|chunk| chunk["stream"] == stream)
                .map(|chunk| chunk["data"].as_str().unwrap())
                .collect();
            assert_eq!(text, expected);
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Opt-in UTF-8 smoke for installed pwsh and Windows PowerShell"]
    async fn windows_shells_preserve_utf8_output_native_pipelines_and_files() {
        use base64::Engine;
        let fixture = fixture_command("echo-stdin");
        let executable = fixture
            .as_std()
            .get_program()
            .to_string_lossy()
            .replace('\'', "''");
        let script = format!(
            r#"$text = '中文🙂';
[Console]::Out.WriteLine("stdout:$text");
[Console]::Error.WriteLine("stderr:$text");
Write-Output "pipeline:$text";
$text | & '{executable}' echo-stdin;
Set-Content -LiteralPath 'text.txt' -Value $text -NoNewline;
Write-Output "file:$(Get-Content -LiteralPath 'text.txt' -Raw)";
$text > 'redirect.txt';
Write-Output "encodings:$($OutputEncoding.CodePage),$([Console]::InputEncoding.CodePage),$([Console]::OutputEncoding.CodePage)";
exit 7;
# A trailing comment must not consume the wrapper's closing brace"#
        );
        for command in shell::commands(&script) {
            let program = command.as_std().get_program().to_owned();
            let dir = tempfile::tempdir().unwrap();
            let cwd = dir.path().join("中文 Shell");
            std::fs::create_dir(&cwd).unwrap();
            let jobs = Jobs::default();
            let mut commands = Vec::new();
            if program == "powershell.exe" {
                // Exercise a real missing-executable fallback without changing
                // global PATH or depending on whether pwsh is installed.
                commands.push(Command::new(dir.path().join("missing-pwsh.exe")));
            }
            commands.push(command);
            let job = jobs
                .start_with("owner", "grant", &json!({"cwd":cwd}), || Ok(commands))
                .unwrap_or_else(|error| panic!("{program:?}: {error}"));
            let id = job.background()["jobId"].as_str().unwrap().to_owned();
            let status = ended_within(&jobs, &id, Duration::from_secs(30)).await;
            assert_eq!(status["status"], "completed", "{program:?}");
            assert_eq!(status["exitCode"], 7, "{program:?}");
            let output = jobs
                .access("owner", "grant", "commands.read", &json!({"jobId":id}))
                .unwrap();
            for (stream, expected) in [
                (
                    "stdout",
                    "stdout:中文🙂\r\npipeline:中文🙂\r\n中文🙂\r\nfile:中文🙂\r\nencodings:65001,65001,65001\r\n",
                ),
                ("stderr", "stderr:中文🙂\r\n"),
            ] {
                let chunks: Vec<_> = output["chunks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|chunk| chunk["stream"] == stream)
                    .collect();
                let bytes: Vec<_> = chunks
                    .iter()
                    .flat_map(|chunk| {
                        base64::engine::general_purpose::STANDARD
                            .decode(chunk["dataBase64"].as_str().unwrap())
                            .unwrap()
                    })
                    .collect();
                assert_eq!(bytes, expected.as_bytes(), "{program:?} {stream}");
                let displayed: String = chunks
                    .iter()
                    .map(|chunk| chunk["data"].as_str().unwrap())
                    .collect();
                assert_eq!(displayed, expected, "{program:?} {stream}");
            }
            for (name, expected) in [("text.txt", "中文🙂"), ("redirect.txt", "中文🙂\r\n")]
            {
                let bytes = std::fs::read(cwd.join(name)).unwrap();
                // Windows PowerShell writes a BOM with -Encoding utf8; pwsh does not.
                let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
                assert_eq!(bytes, expected.as_bytes(), "{program:?} {name}");
            }
        }
    }

    #[tokio::test]
    async fn output_finalization_waits_for_cancelled_readers_and_reports_incomplete_output() {
        let mut readers = tokio::task::JoinSet::new();
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct Stopped(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Stopped {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let (started, ready) = tokio::sync::oneshot::channel();
        let flag = stopped.clone();
        readers.spawn(async move {
            let _stopped = Stopped(flag);
            let _ = started.send(());
            std::future::pending::<bool>().await
        });
        ready.await.unwrap();
        assert!(finish_output(&mut readers, Duration::from_millis(10)).await);
        assert!(stopped.load(std::sync::atomic::Ordering::SeqCst));
        assert!(readers.is_empty());
        readers.spawn(async { true });
        readers.spawn(async { false });
        assert!(finish_output(&mut readers, Duration::from_secs(1)).await);
        readers.spawn(async { true });
        assert!(!finish_output(&mut readers, Duration::from_secs(1)).await);
    }

    #[tokio::test]
    async fn ten_jobs_can_run_and_completed_jobs_release_slots() {
        let jobs = Jobs::default();
        let mut ids = Vec::new();
        for _ in 0..10 {
            let job = start_fixture(&jobs, "hold", json!({})).unwrap();
            ids.push(job.id.clone());
            job.background();
        }
        assert_eq!(
            start_fixture(&jobs, "hold", json!({})).err().unwrap(),
            "BUSY"
        );
        jobs.access(
            "owner",
            "grant",
            "commands.send",
            &json!({"jobId":ids[0],"signal":"SIGKILL"}),
        )
        .unwrap();
        assert_eq!(ended(&jobs, &ids[0]).await["status"], "cancelled");
        let job = start_fixture(&jobs, "exit", json!({})).unwrap();
        assert_eq!(job.wait(10000, || Ok(())).await.unwrap()["exitCode"], 7);
        jobs.cancel_grant("grant");
        for id in &ids[1..] {
            assert_eq!(ended(&jobs, id).await["status"], "cancelled");
        }
    }

    #[tokio::test]
    async fn send_enforces_ownership_and_delivers_input_and_eof() {
        let jobs = Jobs::default();
        let job = start_fixture(&jobs, "input", json!({})).unwrap();
        let id = job.id.clone();
        job.background();
        for (owner, grant) in [("other", "grant"), ("owner", "new-grant")] {
            for action in [
                json!({"input":"forbidden"}),
                json!({"signal":"SIGKILL"}),
                json!({"eof":true}),
            ] {
                let mut args = json!({"jobId":id});
                args.as_object_mut()
                    .unwrap()
                    .extend(action.as_object().unwrap().clone());
                assert_eq!(
                    jobs.access(owner, grant, "commands.send", &args)
                        .unwrap_err(),
                    "PERMISSION_DENIED"
                );
            }
        }
        jobs.access(
            "owner",
            "grant",
            "commands.send",
            &json!({"jobId":id,"input":"first\n"}),
        )
        .unwrap();
        jobs.access(
            "owner",
            "grant",
            "commands.send",
            &json!({"jobId":id,"input":"中文🙂","eof":true}),
        )
        .unwrap();
        assert_eq!(ended(&jobs, &id).await["exitCode"], 0);
        let output = jobs
            .access("owner", "grant", "commands.read", &json!({"jobId":id}))
            .unwrap();
        assert_eq!(output["stdinStatus"], "closed");
        let text: String = output["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["data"].as_str().unwrap())
            .collect();
        assert_eq!(text, "first\n中文🙂");
        assert_eq!(
            jobs.access(
                "owner",
                "grant",
                "commands.send",
                &json!({"jobId":id,"input":"late"})
            )
            .unwrap_err(),
            "JOB_NOT_RUNNING"
        );
    }

    #[tokio::test]
    async fn signals_and_revocation_bypass_blocked_stdin() {
        for signal in [Some("SIGKILL"), Some("SIGTERM"), None] {
            let jobs = Jobs::default();
            let job = start_fixture(&jobs, "hold", json!({})).unwrap();
            let id = job.id.clone();
            job.background();
            // The fixture never reads stdin after its launch barrier.
            let args = json!({"jobId":id,"input":"🙂".repeat(16384)});
            for _ in 0..10 {
                if jobs
                    .access("owner", "grant", "commands.send", &args)
                    .is_err()
                {
                    break;
                }
            }
            if let Some(signal) = signal {
                jobs.access(
                    "owner",
                    "grant",
                    "commands.send",
                    &json!({"jobId":id,"signal":signal}),
                )
                .unwrap();
            } else {
                jobs.cancel_grant("grant");
            }
            let status = ended(&jobs, &id).await;
            assert_ne!(status["status"], "running");
            if cfg!(unix) && signal == Some("SIGTERM") {
                // TERM can close the child's pipe before exit handling cancels the
                // writer. A real pipe failure is preserved rather than overwritten.
                assert!(
                    matches!(status["stdinStatus"].as_str(), Some("closed" | "failed")),
                    "Unexpected terminal stdin status after SIGTERM: {status}"
                );
            } else {
                assert_eq!(status["stdinStatus"], "closed");
            }
            assert_eq!(
                jobs.access(
                    "owner",
                    "grant",
                    "commands.send",
                    &json!({"jobId":id,"input":"late"}),
                )
                .unwrap_err(),
                "JOB_NOT_RUNNING"
            );
        }
    }

    #[tokio::test]
    async fn process_exit_fences_sends_before_output_finalization() {
        let jobs = Jobs::default();
        let job = start_fixture(&jobs, "exit", json!({})).unwrap();
        let id = job.id.clone();
        let stopping = job.job.cancel.clone();
        job.background();
        tokio::time::timeout(Duration::from_secs(10), stopping.cancelled())
            .await
            .unwrap();
        for action in [
            json!({"input":"late"}),
            json!({"eof":true}),
            json!({"signal":"SIGTERM"}),
        ] {
            let mut args = json!({"jobId":id});
            args.as_object_mut()
                .unwrap()
                .extend(action.as_object().unwrap().clone());
            assert_eq!(
                jobs.access("owner", "grant", "commands.send", &args)
                    .unwrap_err(),
                "JOB_NOT_RUNNING"
            );
        }
        assert_eq!(ended(&jobs, &id).await["status"], "completed");
    }

    #[tokio::test]
    async fn control_characters_are_literal_input_and_do_not_close_or_signal_the_job() {
        let jobs = Jobs::default();
        let job = start_fixture(&jobs, "input-hex", json!({})).unwrap();
        let id = job.id.clone();
        job.background();
        jobs.access(
            "owner",
            "grant",
            "commands.send",
            &json!({"jobId":id,"input":"\u{0}\u{3}\u{4}\t\r\n\u{1b}"}),
        )
        .unwrap();
        let status = jobs
            .access("owner", "grant", "commands.status", &json!({"jobId":id}))
            .unwrap();
        assert_eq!(status["status"], "running");
        assert_eq!(status["stdinStatus"], "open");
        jobs.access(
            "owner",
            "grant",
            "commands.send",
            &json!({"jobId":id,"input":"\u{1a}\u{8}END","eof":true}),
        )
        .unwrap();
        assert_eq!(ended(&jobs, &id).await["exitCode"], 0);
        let output = jobs
            .access("owner", "grant", "commands.read", &json!({"jobId":id}))
            .unwrap();
        let text: String = output["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["data"].as_str().unwrap())
            .collect();
        assert_eq!(text, "000304090d0a1b1a08454e44");
    }

    #[tokio::test]
    async fn closed_child_stdin_reports_write_failure_while_process_is_still_running() {
        let jobs = Jobs::default();
        let job = start_fixture(&jobs, "closed-input", json!({})).unwrap();
        let id = job.id.clone();
        job.background();
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let status = jobs
                    .access("owner", "grant", "commands.status", &json!({"jobId":id}))
                    .unwrap();
                if status["bytes"].as_u64().unwrap() > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            jobs.access(
                "owner",
                "grant",
                "commands.send",
                &json!({"jobId":id,"input":"hello"}),
            )
            .unwrap();
            loop {
                let status = jobs
                    .access("owner", "grant", "commands.status", &json!({"jobId":id}))
                    .unwrap();
                if status["stdinStatus"] == "failed" {
                    return status;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        jobs.stop();
        ended(&jobs, &id).await;
        assert_eq!(
            result.expect("Deferred pipe failure must be visible without another send")["status"],
            "running"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn unsupported_windows_interrupt_has_no_side_effects() {
        let jobs = Jobs::default();
        let job = start_fixture(&jobs, "input", json!({})).unwrap();
        let id = job.id.clone();
        job.background();
        assert_eq!(
            jobs.access(
                "owner",
                "grant",
                "commands.send",
                &json!({"jobId":id,"signal":"SIGINT"})
            )
            .unwrap_err(),
            "UNSUPPORTED_SIGNAL"
        );
        jobs.access(
            "owner",
            "grant",
            "commands.send",
            &json!({"jobId":id,"input":"still running","eof":true}),
        )
        .unwrap();
        assert_eq!(ended(&jobs, &id).await["exitCode"], 0);
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Opt-in stdin smoke for installed pwsh and Windows PowerShell"]
    async fn windows_shells_deliver_early_input_without_launch_barrier_read_ahead() {
        let fixture = fixture_command("echo-stdin");
        let executable = fixture
            .as_std()
            .get_program()
            .to_string_lossy()
            .replace('\'', "''");
        for script in [
            "[Console]::Out.Write([Console]::In.ReadToEnd())".to_string(),
            format!("& '{executable}' echo-stdin"),
        ] {
            for command in shell::commands(&script) {
                let program = command.as_std().get_program().to_owned();
                let jobs = Jobs::default();
                let job = jobs
                    .start_with("owner", "grant", &json!({}), || Ok(vec![command]))
                    .unwrap();
                let id = job.id.clone();
                job.background();
                // Queue immediately, before PowerShell has finished starting.
                jobs.access(
                    "owner",
                    "grant",
                    "commands.send",
                    &json!({"jobId":id,"input":"中文🙂\nsecond line","eof":true}),
                )
                .unwrap();
                let status = ended_within(&jobs, &id, Duration::from_secs(30)).await;
                assert_eq!(status["exitCode"], 0, "{program:?}: {status}");
                let output = jobs
                    .access("owner", "grant", "commands.read", &json!({"jobId":id}))
                    .unwrap();
                let text: String = output["chunks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|c| c["data"].as_str().unwrap())
                    .collect();
                assert_eq!(
                    text.replace("\r\n", "\n").trim_end(),
                    "中文🙂\nsecond line",
                    "{program:?}"
                );
            }
        }
    }
    #[tokio::test]
    async fn run_returns_completed_output_and_nonzero_exit() {
        let jobs = Jobs::default();
        let job = start_fixture(&jobs, "exit", json!({})).unwrap();
        let id = job.id.clone();
        let result = job.wait(10000, || Ok(())).await.unwrap();
        assert_eq!(result["jobId"], id);
        assert_eq!(result["background"], false);
        assert_eq!(result["status"], "completed");
        assert_eq!(result["exitCode"], 7);
        assert_eq!(result["outputIncomplete"], false);
        let chunks = result["chunks"].as_array().unwrap();
        for (stream, expected) in [("stdout", "out"), ("stderr", "err")] {
            let text: String = chunks
                .iter()
                .filter(|c| c["stream"] == stream)
                .map(|c| c["data"].as_str().unwrap())
                .collect();
            assert_eq!(text, expected);
        }
        assert_eq!(result["hasMore"], false);
        assert!(jobs
            .access("other", "grant", "commands.read", &json!({"jobId":id}))
            .is_err());
        assert!(jobs
            .access(
                "owner",
                "different-grant",
                "commands.read",
                &json!({"jobId":id})
            )
            .is_err());
    }
    #[tokio::test]
    async fn run_wait_limit_hands_off_without_cancelling_and_start_returns_immediately() {
        let jobs = Jobs::default();
        let job = start_fixture(&jobs, "hold", json!({})).unwrap();
        let result = job.wait(1, || Ok(())).await.unwrap();
        assert_eq!(result["background"], true);
        assert_eq!(result["status"], "running");
        let id = result["jobId"].as_str().unwrap();
        assert!(!jobs.entries.lock().unwrap()[id].cancel.is_cancelled());
        let background = start_fixture(&jobs, "hold", json!({}))
            .unwrap()
            .background();
        assert_eq!(background.as_object().unwrap().len(), 1);
        jobs.access(
            "owner",
            "grant",
            "commands.send",
            &json!({"jobId":id,"signal":"SIGKILL"}),
        )
        .unwrap();
        assert_eq!(ended(&jobs, id).await["status"], "cancelled");
        jobs.cancel_grant("grant");
        assert_eq!(
            ended(&jobs, background["jobId"].as_str().unwrap()).await["status"],
            "cancelled"
        );
    }
    #[tokio::test]
    async fn shared_emergency_stops_background_jobs_without_any_control_lease() {
        let service = crate::automation::Service::default();
        service.state.lock().unwrap().enabled = true;
        let job = start_fixture(&service.jobs, "hold", json!({})).unwrap();
        let id = job.id.clone();
        job.background();
        let control = crate::remote_control::Service::default();
        control.observe_emergency(service.emergency_observer());
        control.emergency_revoke();
        let emergency = service.state.lock().unwrap().emergency.clone();
        tokio::time::timeout(Duration::from_secs(1), emergency.wake.notified())
            .await
            .unwrap();
        service.expire();
        assert_eq!(ended(&service.jobs, &id).await["status"], "cancelled");
        assert!(!service.state.lock().unwrap().policy_generation.is_empty());
    }
    #[tokio::test]
    async fn run_cancellation_or_dropped_wait_cancels_owned_job() {
        let jobs = Jobs::default();
        let job = start_fixture(&jobs, "hold", json!({})).unwrap();
        let id = job.id.clone();
        let live = std::sync::atomic::AtomicBool::new(true);
        let (result, ()) = tokio::join!(
            job.wait(
                10000,
                || if live.load(std::sync::atomic::Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err("CANCELLED".into())
                }
            ),
            async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                live.store(false, std::sync::atomic::Ordering::SeqCst);
            }
        );
        assert_eq!(result.unwrap_err(), "CANCELLED");
        assert_eq!(ended(&jobs, &id).await["status"], "cancelled");
        let job = start_fixture(&jobs, "hold", json!({})).unwrap();
        let id = job.id.clone();
        // Dropping even an unpolled wait future must cancel its command.
        drop(job.wait(10000, || Ok(())));
        assert_eq!(ended(&jobs, &id).await["status"], "cancelled");
    }
    #[tokio::test]
    async fn run_observes_execution_timeout_and_revocation_while_waiting() {
        let jobs = Jobs::default();
        let job = start_fixture(&jobs, "hold", json!({"timeoutMs":50})).unwrap();
        assert_eq!(
            job.wait(10000, || Ok(())).await.unwrap()["status"],
            "timed_out"
        );
        let job = start_fixture(&jobs, "hold", json!({})).unwrap();
        let (result, ()) = tokio::join!(job.wait(10000, || Ok(())), async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            jobs.cancel_grant("grant");
        });
        assert_eq!(result.unwrap()["status"], "cancelled");
    }
    #[test]
    fn caught_up_running_jobs_can_emit_more_and_final_output_still_needs_draining() {
        let mut state = JobState {
            status: "running",
            output: Output::default(),
            output_incomplete: false,
            exit: None,
        };
        let empty = output_page(&state, Read::Cursor(0)).unwrap();
        assert_eq!(empty["hasMore"], false);
        assert_eq!(empty["status"], "running");
        assert_eq!(empty["nextCursor"], 0);
        state.output.append(b"out", "stdout");
        let first = output_page(&state, Read::Cursor(0)).unwrap();
        assert_eq!(first["chunks"][0]["stream"], "stdout");
        assert_eq!(first["nextCursor"], 3);
        state.output.append(b"err", "stderr");
        let next = output_page(&state, Read::Cursor(3)).unwrap();
        assert_eq!(next["chunks"].as_array().unwrap().len(), 1);
        assert_eq!(next["chunks"][0]["stream"], "stderr");
        assert_eq!(next["chunks"][0]["data"], "err");
        state.output.append(&vec![b'x'; 20000], "stdout");
        state.status = "completed";
        state.exit = Some(0);
        let final_page = output_page(&state, Read::Cursor(6)).unwrap();
        assert_eq!(final_page["status"], "completed");
        assert_eq!(final_page["hasMore"], true);
        let tail = output_page(
            &state,
            Read::Cursor(final_page["nextCursor"].as_u64().unwrap()),
        )
        .unwrap();
        assert_eq!(tail["hasMore"], false);
        assert_eq!(tail["nextCursor"], 20006);
    }
    #[tokio::test]
    async fn output_owner_and_cancellation() {
        let jobs = Jobs::default();
        let result = start_fixture(&jobs, "output", json!({}))
            .unwrap()
            .background();
        let id = result["jobId"].as_str().unwrap();
        assert_eq!(ended(&jobs, id).await["exitCode"], 0);
        assert!(jobs
            .access("other", "grant", "commands.read", &json!({"jobId":id}))
            .is_err());
        assert!(jobs
            .access("owner", "new-grant", "commands.read", &json!({"jobId":id}))
            .is_err());
        let output = jobs
            .access("owner", "grant", "commands.read", &json!({"jobId":id}))
            .unwrap();
        assert!(output.to_string().contains("automation-output"));
        assert!(output["nextCursor"].as_u64().unwrap() > 0);
        let result = start_fixture(&jobs, "hold", json!({}))
            .unwrap()
            .background();
        let id = result["jobId"].as_str().unwrap();
        jobs.cancel_grant("grant");
        assert_eq!(ended(&jobs, id).await["status"], "cancelled");
    }
    #[tokio::test]
    async fn run_and_background_reads_keep_final_results_after_large_output() {
        let jobs = Jobs::default();
        let job = start_fixture(&jobs, "large", json!({})).unwrap();
        let id = job.id.clone();
        let result = job.wait(10000, || Ok(())).await.unwrap();
        assert_eq!(result["status"], "completed");
        assert_eq!(result["bytes"], 5000014);
        assert_eq!(result["retainedBytes"], output::LIMIT);
        assert_eq!(result["startCursor"], 5000014 - 16384);
        assert_eq!(result["nextCursor"], 5000014);
        assert_eq!(result["truncated"], true);
        assert_eq!(result["cursorExpired"], false);
        let tail = jobs
            .access("owner", "grant", "commands.read", &json!({"jobId":id}))
            .unwrap();
        assert_eq!(tail["chunks"], result["chunks"]);
        assert_eq!(tail["hasMore"], false);
        let line = jobs
            .access(
                "owner",
                "grant",
                "commands.read",
                &json!({"jobId":id,"tailLines":1}),
            )
            .unwrap();
        assert_eq!(line["chunks"][0]["data"], "FINAL-RESULT\n");
        assert_eq!(line["tailLimited"], false);
        let head = jobs
            .access(
                "owner",
                "grant",
                "commands.read",
                &json!({"jobId":id,"cursor":0}),
            )
            .unwrap();
        assert_eq!(head["cursorExpired"], true);
        assert_eq!(head["startCursor"], 5000014 - output::LIMIT);
        assert_eq!(head["hasMore"], true);
        let status = jobs
            .access("owner", "grant", "commands.status", &json!({"jobId":id}))
            .unwrap();
        assert_eq!(status["bytes"], result["bytes"]);
        assert_eq!(status["earliestCursor"], head["startCursor"]);
        assert!(jobs
            .access(
                "other",
                "grant",
                "commands.read",
                &json!({"jobId":id,"tailLines":1})
            )
            .is_err());
    }
    #[tokio::test]
    async fn bounds_output_and_times_out() {
        let jobs = Jobs::default();
        let result = start_fixture(&jobs, "bytes", json!({}))
            .unwrap()
            .background();
        let id = result["jobId"].as_str().unwrap();
        let status = ended(&jobs, id).await;
        assert_eq!(status["bytes"], 5000000);
        assert_eq!(status["retainedBytes"], output::LIMIT);
        assert_eq!(status["earliestCursor"], 5000000 - output::LIMIT);
        assert_eq!(status["truncated"], true);
        let result = start_fixture(&jobs, "hold", json!({"timeoutMs":50}))
            .unwrap()
            .background();
        let id = result["jobId"].as_str().unwrap();
        assert_eq!(ended(&jobs, id).await["status"], "timed_out");
    }
}
