use super::{restore_error, Setting, ThreadReport, ThreadRole};

// Linux has no corresponding per-process timeBeginPeriod request. Timing is
// adjusted on the worker itself, together with its scheduling guard.
pub(super) struct Timer;
pub(super) fn timer() -> Setting<Timer> {
    Setting::unsupported()
}

fn error() -> String {
    std::io::Error::last_os_error().to_string()
}
fn priority() -> Result<i32, String> {
    unsafe {
        *libc::__errno_location() = 0;
        let value = libc::getpriority(
            libc::PRIO_PROCESS,
            libc::syscall(libc::SYS_gettid) as libc::id_t,
        );
        if *libc::__errno_location() != 0 {
            Err(error())
        } else {
            Ok(value)
        }
    }
}
fn set_priority(value: i32) -> Result<(), String> {
    let result = unsafe {
        libc::setpriority(
            libc::PRIO_PROCESS,
            libc::syscall(libc::SYS_gettid) as libc::id_t,
            value,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(error())
    }
}
struct Priority {
    previous: i32,
    applied: i32,
}
impl Priority {
    fn enter(role: ThreadRole) -> Result<Option<Self>, String> {
        let previous = priority()?;
        let applied = match role {
            ThreadRole::Capture => -10,
            ThreadRole::Encode => -15,
        };
        if previous <= applied {
            return Ok(None);
        }
        // A missing CAP_SYS_NICE/RLIMIT_NICE is reported, not elevated or retried
        // through a privileged helper. Other adjustments can still succeed.
        set_priority(applied)?;
        let guard = Self { previous, applied };
        if priority()? != applied {
            return Err("Linux did not retain the thread nice value".into());
        }
        Ok(Some(guard))
    }
}
impl Drop for Priority {
    fn drop(&mut self) {
        match priority() {
            Ok(value) if value == self.applied => {
                if let Err(e) = set_priority(self.previous) {
                    restore_error("thread nice value", e);
                }
            }
            Err(e) => restore_error("thread nice value", e),
            _ => {}
        }
    }
}
fn slack() -> Result<libc::c_ulong, String> {
    let value = unsafe { libc::prctl(libc::PR_GET_TIMERSLACK, 0, 0, 0, 0) };
    if value < 0 {
        Err(error())
    } else {
        Ok(value as libc::c_ulong)
    }
}
fn set_slack(value: libc::c_ulong) -> Result<(), String> {
    if unsafe { libc::prctl(libc::PR_SET_TIMERSLACK, value, 0, 0, 0) } == 0 {
        Ok(())
    } else {
        Err(error())
    }
}
struct Slack(libc::c_ulong);
impl Slack {
    fn enter() -> Result<Option<Self>, String> {
        let previous = slack()?;
        if previous == 1 {
            return Ok(None);
        }
        set_slack(1)?;
        let guard = Self(previous);
        if slack()? != 1 {
            return Err("Linux did not retain thread timer slack".into());
        }
        Ok(Some(guard))
    }
}
impl Drop for Slack {
    fn drop(&mut self) {
        match slack() {
            Ok(1) => {
                if let Err(e) = set_slack(self.0) {
                    restore_error("thread timer slack", e);
                }
            }
            Err(e) => restore_error("thread timer slack", e),
            _ => {}
        }
    }
}
pub(super) struct Thread {
    priority: Setting<Priority>,
    timing: Setting<Slack>,
}
impl Thread {
    pub fn enter(role: ThreadRole) -> Self {
        Self {
            priority: Setting::from_result(Priority::enter(role)),
            timing: Setting::from_result(Slack::enter()),
        }
    }
    pub fn report(&self) -> ThreadReport {
        ThreadReport {
            scheduling: self.priority.status.clone(),
            timing: self.timing.status.clone(),
        }
    }
}
