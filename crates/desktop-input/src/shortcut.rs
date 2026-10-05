//! Validated local shortcuts, shared by host registration and controller capture.
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct Shortcut {
    pub vk: u32,
    pub modifiers: u32,
}
impl Default for Shortcut {
    fn default() -> Self {
        "ctrl-alt-shift-f10".to_owned().try_into().unwrap()
    }
}
impl TryFrom<String> for Shortcut {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        let invalid = "Invalid or reserved keyboard shortcut";
        if matches!(
            value.as_str(),
            "ctrl-alt-delete" | "alt-tab" | "alt-f4" | "meta-l"
        ) {
            return Err(invalid);
        }
        let mut rest = value.as_str();
        let mut modifiers = 0;
        for (prefix, flag) in [("ctrl-", 2), ("alt-", 1), ("shift-", 4), ("meta-", 8)] {
            if let Some(next) = rest.strip_prefix(prefix) {
                modifiers |= flag;
                rest = next;
            }
        }
        if modifiers & (1 | 2 | 8) == 0 {
            return Err(invalid);
        }
        let vk = match rest {
            s if s.len() == 1 && s.as_bytes()[0].is_ascii_lowercase() => {
                u32::from(s.as_bytes()[0].to_ascii_uppercase())
            }
            s if s.len() == 1 && s.as_bytes()[0].is_ascii_digit() => u32::from(s.as_bytes()[0]),
            "f1" => 0x70,
            "f2" => 0x71,
            "f3" => 0x72,
            "f4" => 0x73,
            "f5" => 0x74,
            "f6" => 0x75,
            "f7" => 0x76,
            "f8" => 0x77,
            "f9" => 0x78,
            "f10" => 0x79,
            "f11" => 0x7a,
            "backspace" => 8,
            "tab" => 9,
            "enter" => 13,
            "escape" => 27,
            "space" => 32,
            "pageup" => 33,
            "pagedown" => 34,
            "end" => 35,
            "home" => 36,
            "arrowleft" => 37,
            "arrowup" => 38,
            "arrowright" => 39,
            "arrowdown" => 40,
            "insert" => 45,
            "delete" => 46,
            _ => return Err(invalid),
        };
        Ok(Self { vk, modifiers })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_modifiers_and_os_reserved_keys() {
        assert_eq!(
            Shortcut::default(),
            Shortcut {
                vk: 0x79,
                modifiers: 7
            }
        );
        assert_eq!(
            Shortcut::try_from("ctrl-shift-arrowup".to_owned()).unwrap(),
            Shortcut {
                vk: 38,
                modifiers: 6
            }
        );
        for invalid in [
            "q",
            "shift-q",
            "ctrl",
            "ctrl-ctrl-q",
            "alt-ctrl-q",
            "ctrl-f12",
            "ctrl-f01",
            "ctrl-alt-delete",
            "alt-tab",
            "alt-f4",
            "meta-l",
            "ctrl-unknown",
        ] {
            assert!(Shortcut::try_from(invalid.to_owned()).is_err(), "{invalid}");
        }
    }
}
