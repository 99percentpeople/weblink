//! Acceptance belongs to the current authorized position, not to an earlier hover.
pub(super) struct DragState {
    point: (i32, i32),
    release: bool,
    feedback_seen: bool,
    accepted: bool,
}
impl DragState {
    pub(super) fn new(point: (i32, i32), release: bool) -> Self {
        Self {
            point,
            release,
            feedback_seen: false,
            accepted: false,
        }
    }
    /// Other pointer traffic can race the file-hover channel. Correct its position
    /// and require fresh target feedback before releasing any real files.
    pub(super) fn position(&mut self, desired: (i32, i32), cursor: (i32, i32)) -> bool {
        let move_cursor = cursor != desired;
        if self.point != desired || move_cursor {
            self.point = desired;
            self.feedback_seen = false;
            self.accepted = false;
        }
        move_cursor
    }
    pub(super) fn feedback(&mut self, copy: bool) {
        // DragEnter alone is insufficient for applications that accept on DragOver.
        self.accepted = self.feedback_seen && copy;
        self.feedback_seen = true;
    }
    pub(super) fn can_drop(&self) -> bool {
        self.release && self.accepted
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_cursor_race_is_corrected_and_cannot_release_previous_acceptance() {
        let point = (2010, 122);
        let moved = (2125, 98);
        let mut drag = DragState::new(point, true);
        drag.feedback(true);
        drag.feedback(true);
        assert!(drag.can_drop());
        assert!(drag.position(point, moved));
        assert!(!drag.can_drop());
        assert!(!drag.position(point, point));
        drag.feedback(true);
        assert!(!drag.can_drop());
        drag.feedback(true);
        assert!(drag.can_drop());
    }
    #[test]
    fn a_new_hover_position_resets_acceptance_even_if_the_cursor_arrived_first() {
        let mut drag = DragState::new((2010, 122), true);
        drag.feedback(true);
        drag.feedback(true);
        assert!(!drag.position((2125, 98), (2125, 98)));
        assert!(!drag.can_drop());
        drag.feedback(true);
        assert!(!drag.can_drop());
        drag.feedback(false);
        assert!(!drag.can_drop());
        drag.feedback(true);
        assert!(drag.can_drop());
    }
    #[test]
    fn a_preview_never_drops_despite_movement_and_acceptance() {
        let mut drag = DragState::new((2010, 122), false);
        for cursor in [(2010, 122), (2125, 98), (2010, 122)] {
            drag.position((2010, 122), cursor);
            drag.feedback(true);
            drag.feedback(true);
            assert!(!drag.can_drop());
        }
    }
}
