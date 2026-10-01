//! Restore only visibility owned by a native control grant, never a manual hide.
#[derive(Default)]
pub(super) struct ControlWindow {
    grant: Option<String>,
    revision: u64,
    hidden: bool,
}

impl ControlWindow {
    fn accept(&mut self, revision: u64) -> bool {
        if revision <= self.revision {
            return false;
        }
        self.revision = revision;
        true
    }
    pub fn granted(&mut self, revision: u64, grant: String) -> Option<u64> {
        if !self.accept(revision) || self.grant.as_ref() == Some(&grant) {
            return None;
        }
        self.grant = Some(grant);
        Some(revision)
    }
    pub fn hidden(&mut self, revision: u64) {
        // A manual action or a newer grant can win while the window call runs.
        if self.grant.is_some() && self.revision == revision {
            self.hidden = true;
        }
    }
    pub fn ended(&mut self, revision: u64) -> bool {
        if !self.accept(revision) {
            return false;
        }
        // Native authority has only one grant. A newer end can arrive on the
        // UI thread before an older queued grant, so release inherited hiding
        // too; an old end can never pass accept() after a newer grant.
        self.grant = None;
        std::mem::take(&mut self.hidden)
    }
    pub fn manual(&mut self, revision: u64) {
        if self.accept(revision) {
            self.hidden = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_once_only_after_a_successful_automatic_hide() {
        let mut state = ControlWindow::default();
        let revision = state.granted(1, "a".into()).unwrap();
        state.hidden(revision);
        assert!(state.ended(2));
        assert!(!state.ended(2));
        state.granted(3, "b".into());
        // Disabled option, already hidden/minimized, or failed window.hide().
        assert!(!state.ended(4));
    }
    #[test]
    fn manual_show_or_hide_takes_ownership_without_rehiding_the_same_grant() {
        let mut state = ControlWindow::default();
        let revision = state.granted(1, "a".into()).unwrap();
        state.hidden(revision);
        state.manual(2);
        assert!(state.granted(3, "a".into()).is_none());
        assert!(!state.ended(4));
    }
    #[test]
    fn a_late_window_completion_cannot_override_manual_visibility() {
        let mut state = ControlWindow::default();
        let revision = state.granted(1, "a".into()).unwrap();
        state.manual(2);
        state.hidden(revision);
        assert!(!state.ended(3));
    }
    #[test]
    fn old_control_end_cannot_restore_a_new_controls_window() {
        let mut state = ControlWindow::default();
        let revision = state.granted(1, "a".into()).unwrap();
        state.hidden(revision);
        state.granted(3, "b".into());
        assert!(!state.ended(2));
        assert!(state.ended(4));
    }
    #[test]
    fn late_hide_cannot_acquire_a_new_grant_or_revive_an_ended_one() {
        let mut state = ControlWindow::default();
        let revision = state.granted(1, "a".into()).unwrap();
        state.granted(3, "b".into());
        state.hidden(revision);
        assert!(!state.ended(4));
        state.hidden(revision);
        assert!(!state.ended(2));
    }
    #[test]
    fn an_end_delivered_before_a_queued_grant_cannot_hide_an_ended_session() {
        let mut state = ControlWindow::default();
        assert!(!state.ended(2));
        assert!(state.granted(1, "a".into()).is_none());
        let revision = state.granted(3, "b".into()).unwrap();
        state.hidden(revision);
        // c's end overtakes c's grant; b's window still needs restoration.
        assert!(state.ended(6));
        assert!(state.granted(5, "c".into()).is_none());
    }
    #[test]
    fn manual_visibility_prevents_an_older_queued_grant_from_hiding() {
        let mut state = ControlWindow::default();
        state.manual(2);
        assert!(state.granted(1, "a".into()).is_none());
        assert!(!state.ended(3));
    }
}
