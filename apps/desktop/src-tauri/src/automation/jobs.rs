mod output;
use output::{Output, Read};
use serde_json::{json, Value};
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
        let mut entries = self.entries.lock().unwrap();
        if entries
            .values()
            .filter(|j| j.state.lock().unwrap().status == "running")
            .count()
            >= 2
        {
            return Err("BUSY".into());
        }
        if entries.len() >= 32 {
            entries.retain(|_, j| j.state.lock().unwrap().status == "running");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut command = shell(args["script"].as_str().ok_or("INVALID_ARGUMENTS")?);
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
        command
            .env_clear()
            .envs(env)
            .stdin(std::process::Stdio::null())
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
        #[cfg(windows)]
        command.stdin(std::process::Stdio::piped());
        let mut child = command
            .spawn()
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
        let job = Job {
            owner: owner.into(),
            grant: grant.into(),
            cancel: cancel.clone(),
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
            #[cfg(windows)]
            {
                use tokio::io::AsyncWriteExt;
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(b"ready\n").await;
                }
            }
            let mut readers = tokio::task::JoinSet::new();
            readers.spawn(drain(stdout, state.clone(), "stdout"));
            readers.spawn(drain(stderr, state.clone(), "stderr"));
            let (status, exit) = tokio::select! {
                result=child.wait() => ("completed",result.ok().and_then(|s| s.code())),
                _=cancel.cancelled() => ("cancelled",None),
                _=tokio::time::sleep(timeout) => ("timed_out",None),
            };
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
        if name == "commands.cancel" {
            job.cancel.cancel();
            return Ok(json!({"cancelling":true}));
        }
        let s = job.state.lock().unwrap();
        if name == "commands.read" {
            return output_page(&s, Read::parse(args)?);
        }
        let mut status = s.output.metadata();
        status["status"] = json!(s.status);
        status["exitCode"] = json!(s.exit);
        status["outputIncomplete"] = json!(s.output_incomplete);
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
fn shell(script: &str) -> Command {
    #[cfg(windows)]
    {
        let mut c = Command::new("powershell.exe");
        c.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("$null = [Console]::ReadLine(); & {{ {script} }}"),
        ]);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", script]);
        c
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
    async fn ended(jobs: &Jobs, id: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let status = jobs
                    .access("owner", "grant", "commands.status", &json!({"jobId":id}))
                    .unwrap();
                if status["status"] != "running" {
                    return status;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap()
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
    async fn run_returns_completed_output_and_nonzero_exit() {
        let jobs = Jobs::default();
        #[cfg(unix)]
        let script = "printf out; printf err >&2; exit 7";
        #[cfg(windows)]
        let script = "[Console]::Out.Write('out'); [Console]::Error.Write('err'); exit 7";
        let job = jobs
            .start_waiting("owner", "grant", &json!({"script":script}))
            .unwrap();
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
    fn slow_script() -> &'static str {
        #[cfg(unix)]
        {
            "sleep 30"
        }
        #[cfg(windows)]
        {
            "Start-Sleep -Seconds 30"
        }
    }
    #[tokio::test]
    async fn run_wait_limit_hands_off_without_cancelling_and_start_returns_immediately() {
        let jobs = Jobs::default();
        let job = jobs
            .start_waiting("owner", "grant", &json!({"script":slow_script()}))
            .unwrap();
        let result = job.wait(1, || Ok(())).await.unwrap();
        assert_eq!(result["background"], true);
        assert_eq!(result["status"], "running");
        let id = result["jobId"].as_str().unwrap();
        assert!(!jobs.entries.lock().unwrap()[id].cancel.is_cancelled());
        let background = jobs
            .start("owner", "grant", &json!({"script":slow_script()}))
            .unwrap();
        assert_eq!(background.as_object().unwrap().len(), 1);
        assert!(jobs
            .start("owner", "grant", &json!({"script":slow_script()}))
            .is_err());
        jobs.access("owner", "grant", "commands.cancel", &json!({"jobId":id}))
            .unwrap();
        assert_eq!(ended(&jobs, id).await["status"], "cancelled");
        jobs.cancel_grant("grant");
        assert_eq!(
            ended(&jobs, background["jobId"].as_str().unwrap()).await["status"],
            "cancelled"
        );
    }
    #[tokio::test]
    async fn run_cancellation_or_dropped_wait_cancels_owned_job() {
        let jobs = Jobs::default();
        let job = jobs
            .start_waiting("owner", "grant", &json!({"script":slow_script()}))
            .unwrap();
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
        let job = jobs
            .start_waiting("owner", "grant", &json!({"script":slow_script()}))
            .unwrap();
        let id = job.id.clone();
        // Dropping even an unpolled wait future must cancel its command.
        drop(job.wait(10000, || Ok(())));
        assert_eq!(ended(&jobs, &id).await["status"], "cancelled");
    }
    #[tokio::test]
    async fn run_observes_execution_timeout_and_revocation_while_waiting() {
        let jobs = Jobs::default();
        let job = jobs
            .start_waiting(
                "owner",
                "grant",
                &json!({"script":slow_script(),"timeoutMs":50}),
            )
            .unwrap();
        assert_eq!(
            job.wait(10000, || Ok(())).await.unwrap()["status"],
            "timed_out"
        );
        let job = jobs
            .start_waiting("owner", "grant", &json!({"script":slow_script()}))
            .unwrap();
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
        let result = jobs
            .start(
                "owner",
                "grant",
                &json!({"script":"echo automation-output"}),
            )
            .unwrap();
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
        #[cfg(unix)]
        let script = "sleep 30";
        #[cfg(windows)]
        let script = "Start-Sleep -Seconds 30";
        let result = jobs
            .start("owner", "grant", &json!({"script":script}))
            .unwrap();
        let id = result["jobId"].as_str().unwrap();
        jobs.cancel_grant("grant");
        assert_eq!(ended(&jobs, id).await["status"], "cancelled");
    }
    #[tokio::test]
    async fn run_and_background_reads_keep_final_results_after_large_output() {
        let jobs = Jobs::default();
        #[cfg(unix)]
        let script = "head -c 5000000 /dev/zero; printf '\nFINAL-RESULT\n'";
        #[cfg(windows)]
        let script =
            "[Console]::Out.Write(('x' * 5000000)); [Console]::Out.Write(\"`nFINAL-RESULT`n\")";
        let job = jobs
            .start_waiting("owner", "grant", &json!({"script":script}))
            .unwrap();
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
    #[cfg(unix)]
    async fn bounds_output_and_times_out() {
        let jobs = Jobs::default();
        let result = jobs
            .start(
                "owner",
                "grant",
                &json!({"script":"head -c 5000000 /dev/zero"}),
            )
            .unwrap();
        let id = result["jobId"].as_str().unwrap();
        let status = ended(&jobs, id).await;
        assert_eq!(status["bytes"], 5000000);
        assert_eq!(status["retainedBytes"], output::LIMIT);
        assert_eq!(status["earliestCursor"], 5000000 - output::LIMIT);
        assert_eq!(status["truncated"], true);
        let result = jobs
            .start(
                "owner",
                "grant",
                &json!({"script":"sleep 30","timeoutMs":50}),
            )
            .unwrap();
        let id = result["jobId"].as_str().unwrap();
        assert_eq!(ended(&jobs, id).await["status"], "timed_out");
    }
}
