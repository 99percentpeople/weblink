use super::{restore_error, Setting, Status, ThreadReport, ThreadRole};
use std::ffi::c_void;

pub(super) struct Timer;
pub(super) fn timer() -> Setting<Timer> {
    Setting::unsupported()
}

// Public pthread/qos.h API. An override leaves the worker's assigned QoS intact,
// including QOS_CLASS_UNSPECIFIED, and supports independently nested work items.
extern "C" {
    fn pthread_override_qos_class_start_np(
        thread: libc::pthread_t,
        class: libc::qos_class_t,
        relative: i32,
    ) -> *mut c_void;
    fn pthread_override_qos_class_end_np(handle: *mut c_void) -> i32;
}
struct Priority(*mut c_void);
impl Priority {
    fn enter(role: ThreadRole) -> Result<Option<Self>, String> {
        let class = match role {
            ThreadRole::Capture => libc::qos_class_t::QOS_CLASS_USER_INITIATED,
            ThreadRole::Encode => libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE,
        };
        let handle = unsafe { pthread_override_qos_class_start_np(libc::pthread_self(), class, 0) };
        if handle.is_null() {
            Err("macOS rejected the thread QoS override".into())
        } else {
            Ok(Some(Self(handle)))
        }
    }
}
impl Drop for Priority {
    fn drop(&mut self) {
        let code = unsafe { pthread_override_qos_class_end_np(self.0) };
        if code != 0 {
            restore_error("thread QoS", std::io::Error::from_raw_os_error(code));
        }
    }
}
pub(super) struct Thread {
    priority: Setting<Priority>,
}
impl Thread {
    pub fn enter(role: ThreadRole) -> Self {
        Self {
            priority: Setting::from_result(Priority::enter(role)),
        }
    }
    pub fn report(&self) -> ThreadReport {
        ThreadReport {
            scheduling: self.priority.status.clone(),
            timing: Status::Unsupported,
        }
    }
}
