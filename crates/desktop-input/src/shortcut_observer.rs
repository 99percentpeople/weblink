//! Passive shortcut matching. This policy never owns or suppresses keyboard input.
use crate::shortcut::Shortcut;

pub(crate) struct ShortcutObserver {
    shortcut: Shortcut,
    held: [bool; 256],
}
impl ShortcutObserver {
    pub fn new(shortcut: Shortcut, held: [bool; 256]) -> Self {
        Self { shortcut, held }
    }
    pub fn configure(&mut self, shortcut: Shortcut) {
        self.shortcut = shortcut;
    }
    pub fn input(&mut self, vk: u32, down: bool, injected: bool, authorized: bool) -> bool {
        if injected || vk >= 256 {
            return false;
        }
        let repeated = self.held[vk as usize];
        self.held[vk as usize] = down;
        let modifiers = u32::from(self.held[0xa4] || self.held[0xa5])
            | (u32::from(self.held[0xa2] || self.held[0xa3]) << 1)
            | (u32::from(self.held[0xa0] || self.held[0xa1]) << 2)
            | (u32::from(self.held[0x5b] || self.held[0x5c]) << 3);
        authorized && down && !repeated && self.shortcut == Shortcut { vk, modifiers }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observer() -> ShortcutObserver {
        ShortcutObserver::new(Shortcut::default(), [false; 256])
    }
    fn modifiers(s: &mut ShortcutObserver) {
        for vk in [0xa2, 0xa4, 0xa0] {
            assert!(!s.input(vk, true, false, true));
        }
    }
    #[test]
    fn matches_exact_modifiers_once_per_physical_press() {
        let mut s = observer();
        modifiers(&mut s);
        assert!(!s.input(0x78, true, false, true));
        assert!(s.input(0x79, true, false, true));
        assert!(!s.input(0x79, true, false, true));
        assert!(!s.input(0x79, false, false, true));
        assert!(s.input(0x79, true, false, true));
        s.input(0x79, false, false, true);
        s.input(0x5b, true, false, true);
        assert!(!s.input(0x79, true, false, true));
        s.input(0x79, false, false, true);
        s.input(0x5b, false, false, true);
        s.input(0xa0, false, false, true);
        assert!(!s.input(0x79, true, false, true));
    }
    #[test]
    fn injected_events_neither_trigger_nor_change_physical_modifiers() {
        let mut s = observer();
        for vk in [0xa2, 0xa4, 0xa0] {
            assert!(!s.input(vk, true, true, true));
        }
        assert!(!s.input(0x79, true, false, true));
        s.input(0x79, false, false, true);
        modifiers(&mut s);
        assert!(!s.input(0x79, true, true, true));
        assert!(!s.input(0xa2, false, true, true));
        assert!(s.input(0x79, true, false, true));
    }
    #[test]
    fn authorization_or_configuration_does_not_trigger_an_already_held_key() {
        let mut s = observer();
        modifiers(&mut s);
        assert!(!s.input(0x79, true, false, false));
        assert!(!s.input(0x79, true, false, true));
        s.input(0x79, false, false, true);
        assert!(s.input(0x79, true, false, true));
        s.configure("ctrl-alt-shift-f9".to_owned().try_into().unwrap());
        s.input(0x79, false, false, true);
        assert!(!s.input(0x79, true, false, true));
        assert!(s.input(0x78, true, false, true));
        s.configure(Shortcut::default());
        assert!(!s.input(0x79, true, false, true));
    }
    #[test]
    fn left_and_right_modifiers_are_independent_and_initial_keys_do_not_repeat() {
        let mut held = [false; 256];
        for vk in [0xa3, 0xa5, 0xa1, 0x79] {
            held[vk] = true;
        }
        let mut s = ShortcutObserver::new(Shortcut::default(), held);
        assert!(!s.input(0x79, true, false, true));
        s.input(0xa2, true, false, true);
        s.input(0xa3, false, false, true);
        s.input(0x79, false, false, true);
        assert!(s.input(0x79, true, false, true));
    }
}
