//! Controller-side ownership policy. No OS calls, transport or key logging.
use crate::input::ScanCode;

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
    exit_code: u16,
}
impl KeyboardCapture {
    pub fn new(exit_code: u16, initial: [bool; 256]) -> Self {
        Self {
            held: [false; 512],
            initial,
            exit_code,
        }
    }
    pub fn held(&self) -> bool {
        self.held.iter().any(|v| *v)
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
        if self.initial.iter().any(|v| *v) {
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
        if down
            && !extended
            && (self.held[0x1d] || self.held[0x11d])
            && (self.held[0x38] || self.held[0x138])
            && (self.held[0x2a] || self.held[0x36])
            && !self.held[0x15b]
            && !self.held[0x15c]
            && (code == self.exit_code || code == 0x44)
        {
            self.held[index] = true;
            return if code == 0x44 {
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
        KeyboardCapture::new(0x10, [false; 256])
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
        let mut s = KeyboardCapture::new(0x2d, [false; 256]);
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
    fn waits_for_preexisting_keys_and_leaves_unsupported_keys_local() {
        let mut initial = [false; 256];
        initial[0xa2] = true;
        let mut s = KeyboardCapture::new(0x10, initial);
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
}
