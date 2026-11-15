use super::{Setting, Status, ThreadReport, ThreadRole};
pub(super) struct Timer;
pub(super) fn timer() -> Setting<Timer> {
    Setting::unsupported()
}
pub(super) struct Thread;
impl Thread {
    pub fn enter(_: ThreadRole) -> Self {
        Self
    }
    pub fn report(&self) -> ThreadReport {
        ThreadReport {
            scheduling: Status::Unsupported,
            timing: Status::Unsupported,
        }
    }
}
