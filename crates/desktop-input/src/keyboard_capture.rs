//! Controller-side ownership policy. No OS calls, transport or key logging.
use crate::{input::ScanCode, shortcut::Shortcut};

#[derive(Debug, PartialEq)]
pub enum Decision {
    Pass,
    Suppress,
    Forward(ScanCode, bool),
    Exit,
    Emergency,
}
pub struct KeyboardCapture {
    held: [bool; 512],
    initial: [bool; 256],
    exit: Shortcut,
    emergency: Shortcut,
}
impl KeyboardCapture {
    pub fn new(exit: Shortcut, emergency: Shortcut, initial: [bool; 256]) -> Self {
        Self {
            held: [false; 512],
            initial,
            exit,
            emergency,
        }
    }
    pub fn held(&self) -> bool {
        self.held.iter().any(|v| *v)
    }
    pub fn waiting_for_release(&self) -> bool {
        self.initial.iter().any(|v| *v)
    }
    /// Reconcile only startup-owned keys, outside the low-level hook callback.
    /// A release can occur between the initial snapshot and hook installation,
    /// or be consumed by another hook. It must not block capture forever.
    pub fn reconcile_initial(&mut self, down: &[bool; 256]) {
        for (initial, down) in self.initial.iter_mut().zip(down) {
            *initial &= *down;
        }
    }
    pub fn input(
        &mut self,
        code: u16,
        extended: bool,
        down: bool,
        injected: bool,
        vk: u32,
        active: bool,
    ) -> Decision {
        if injected || vk >= 256 {
            return Decision::Pass;
        }
        // Keys already down before capture belong to the local application.
        if self.waiting_for_release() {
            self.initial[vk as usize] = down;
            return Decision::Pass;
        }
        // Pause has a special E1 sequence, despite sharing NumLock's scan code.
        if vk == 0x13 || vk == 0x2c {
            return Decision::Pass;
        }
        let Some(key) = ScanCode::new(code, extended) else {
            return Decision::Pass;
        };
        let index = usize::from(code) + if extended { 256 } else { 0 };
        if !active {
            let owned = self.held[index];
            if !down {
                self.held[index] = false;
            }
            return if owned {
                Decision::Suppress
            } else {
                Decision::Pass
            };
        }
        let modifiers = u32::from(self.held[0x38] || self.held[0x138])
            | (u32::from(self.held[0x1d] || self.held[0x11d]) << 1)
            | (u32::from(self.held[0x2a] || self.held[0x36]) << 2)
            | (u32::from(self.held[0x15b] || self.held[0x15c]) << 3);
        let chord = Shortcut { vk, modifiers };
        if down && (chord == self.exit || chord == self.emergency) {
            self.held[index] = true;
            return if chord == self.emergency {
                Decision::Emergency
            } else {
                Decision::Exit
            };
        }
        if !down && !self.held[index] {
            return Decision::Pass;
        }
        self.held[index] = down;
        Decision::Forward(key, down)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> KeyboardCapture {
        KeyboardCapture::new(
            "ctrl-alt-shift-q".to_owned().try_into().unwrap(),
            Shortcut::default(),
            [false; 256],
        )
    }
    #[test]
    fn forwards_physical_system_chords_and_repeats_but_not_injection() {
        let mut s = state();
        for (code, ext, vk) in [
            (0x38, false, 0xa4),
            (0x0f, false, 9),
            (0x0f, false, 9),
            (0x5b, true, 0x5b),
        ] {
            assert!(matches!(
                s.input(code, ext, true, false, vk, true),
                Decision::Forward(_, true)
            ));
        }
        assert_eq!(s.input(0x1e, false, true, true, 65, true), Decision::Pass);
        assert_eq!(s.input(0x1e, false, false, false, 65, true), Decision::Pass);
    }
    #[test]
    fn exit_chord_is_local_and_drain_never_captures_new_keys() {
        let mut s = state();
        for code in [0x1d, 0x38, 0x2a] {
            s.input(code, false, true, false, 1, true);
        }
        assert_eq!(s.input(0x10, false, true, false, 81, true), Decision::Exit);
        assert_eq!(s.input(0x1e, false, true, false, 65, false), Decision::Pass);
        for code in [0x10, 0x2a, 0x38, 0x1d] {
            assert_eq!(
                s.input(code, false, false, false, 1, false),
                Decision::Suppress
            );
        }
        assert!(!s.held());
    }
    #[test]
    fn reserves_host_emergency_and_respects_alternate_exit_key() {
        let mut s = KeyboardCapture::new(
            "ctrl-alt-shift-x".to_owned().try_into().unwrap(),
            Shortcut::default(),
            [false; 256],
        );
        for (code, ext) in [(0x1d, true), (0x38, true), (0x36, false)] {
            s.input(code, ext, true, false, 1, true);
        }
        assert!(matches!(
            s.input(0x10, false, true, false, 81, true),
            Decision::Forward(_, true)
        ));
        assert_eq!(s.input(0x2d, false, true, false, 88, true), Decision::Exit);
        assert_eq!(
            s.input(0x44, false, true, false, 0x79, true),
            Decision::Emergency
        );
    }
    #[test]
    fn custom_navigation_exit_and_emergency_require_exact_modifiers() {
        let mut s = KeyboardCapture::new(
            "ctrl-shift-arrowup".to_owned().try_into().unwrap(),
            "ctrl-shift-f8".to_owned().try_into().unwrap(),
            [false; 256],
        );
        s.input(0x1d, true, true, false, 0xa3, true);
        assert!(matches!(
            s.input(0x48, true, true, false, 38, true),
            Decision::Forward(_, true)
        ));
        s.input(0x36, false, true, false, 0xa1, true);
        assert_eq!(s.input(0x48, true, true, false, 38, true), Decision::Exit);
        assert_eq!(
            s.input(0x42, false, true, false, 0x77, true),
            Decision::Emergency
        );
        s.input(0x38, false, true, false, 0xa4, true);
        assert!(matches!(
            s.input(0x42, false, true, false, 0x77, true),
            Decision::Forward(_, true)
        ));
        // F10 is no longer reserved once the host chooses another chord.
        assert!(matches!(
            s.input(0x44, false, true, false, 0x79, true),
            Decision::Forward(_, true)
        ));
    }
    #[test]
    fn waits_for_preexisting_keys_and_leaves_unsupported_keys_local() {
        let mut initial = [false; 256];
        initial[0xa2] = true;
        let mut s = KeyboardCapture::new(
            "ctrl-alt-shift-q".to_owned().try_into().unwrap(),
            Shortcut::default(),
            initial,
        );
        assert_eq!(s.input(0x1e, false, true, false, 65, true), Decision::Pass);
        assert_eq!(
            s.input(0x1d, false, false, false, 0xa2, true),
            Decision::Pass
        );
        assert_eq!(s.input(0x1e, false, false, false, 65, true), Decision::Pass);
        for (code, ext, vk) in [(0x45, false, 0x13), (0x37, true, 0x2c), (0xff, true, 1)] {
            assert_eq!(s.input(code, ext, true, false, vk, true), Decision::Pass);
        }
        assert!(matches!(
            s.input(0x45, false, true, false, 0x90, true),
            Decision::Forward(_, true)
        ));
    }
    #[test]
    fn a_release_missed_during_hook_installation_cannot_block_every_later_key() {
        let mut initial = [false; 256];
        initial[0xa2] = true;
        let mut s = KeyboardCapture::new(
            "ctrl-alt-shift-q".to_owned().try_into().unwrap(),
            Shortcut::default(),
            initial,
        );
        assert!(s.waiting_for_release());
        // Ctrl was released before the hook existed: no key-up callback will arrive.
        s.reconcile_initial(&[false; 256]);
        assert!(!s.waiting_for_release());
        assert_eq!(
            s.input(0x1e, false, true, false, 65, true),
            Decision::Forward(ScanCode::new(0x1e, false).unwrap(), true)
        );
        assert_eq!(
            s.input(0x1e, false, false, false, 65, true),
            Decision::Forward(ScanCode::new(0x1e, false).unwrap(), false)
        );
    }
    #[test]
    fn startup_reconciliation_keeps_preexisting_and_new_local_presses_local() {
        let mut down = [false; 256];
        down[0xa2] = true;
        let mut s = KeyboardCapture::new(
            "ctrl-alt-shift-q".to_owned().try_into().unwrap(),
            Shortcut::default(),
            down,
        );
        assert_eq!(s.input(0x1e, false, true, false, 65, true), Decision::Pass);
        down[65] = true;
        down[0xa2] = false;
        s.reconcile_initial(&down);
        assert!(s.waiting_for_release());
        assert_eq!(s.input(0x1e, false, false, false, 65, true), Decision::Pass);
        assert!(!s.waiting_for_release());
        assert!(matches!(
            s.input(0x1d, false, true, false, 0xa2, true),
            Decision::Forward(_, true)
        ));
        // Suppressed native presses do not appear in asynchronous state. They
        // belong to this capture and must not be cleared by startup reconciliation.
        s.reconcile_initial(&[false; 256]);
        assert!(s.held());
        assert!(matches!(
            s.input(0x1d, false, false, false, 0xa2, true),
            Decision::Forward(_, false)
        ));
    }
}
