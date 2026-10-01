use super::{environment, safety::Safety};
use crate::{engine::Device, input::*};
use windows::Win32::UI::Input::KeyboardAndMouse::*;

pub(super) struct WindowsDevice(
    pub Safety,
    pub super::touch::TouchDevice,
    pub super::pan::PanDevice,
);
impl Device for WindowsDevice {
    fn pan_supported(&self) -> bool {
        self.2.supported()
    }
    fn submit_pan(&mut self, gesture: crate::pan::Pan) -> Result<(), Error> {
        if !self.available() {
            return Err(Error::Unavailable);
        }
        self.2.submit(gesture)
    }
    fn cancel_pan(&mut self) -> Result<(), Error> {
        self.2.cancel()
    }
    fn cursor_position(&self) -> Result<(i32, i32), Error> {
        let mut point = windows::Win32::Foundation::POINT::default();
        unsafe { windows::Win32::UI::WindowsAndMessaging::GetPhysicalCursorPos(&mut point) }
            .map_err(|_| Error::Unavailable)?;
        Ok((point.x, point.y))
    }
    fn touch_supported(&self) -> bool {
        self.1.supported()
    }
    fn submit_touch(&mut self, contacts: &[crate::touch::Action]) -> Result<(), Error> {
        if !self.available() || contacts.iter().any(|c| !self.0.pixel_in_guard(c.x, c.y)) {
            return Err(Error::Unavailable);
        }
        self.1.submit(contacts)
    }
    fn cancel_touch(&mut self) -> Result<(), Error> {
        self.1.cancel()
    }
    fn available(&self) -> bool {
        !self.0.observations.pending() && environment::desktop_available() && self.0.guard_current()
    }
    fn geometry_current(&self, g: Geometry) -> bool {
        self.0.geometry_current(g)
    }
    fn submit(&mut self, actions: &[Action]) -> Result<(), Error> {
        let only_release = actions.iter().all(|a| {
            matches!(
                a,
                Action::Key { down: false, .. }
                    | Action::Button { down: false, .. }
                    | Action::Unicode { down: false, .. }
            )
        });
        if !environment::desktop_available() || (!only_release && !self.available()) {
            return Err(Error::Unavailable);
        }
        let mut inputs = Vec::with_capacity(actions.len());
        for action in actions {
            if let Action::Move { x, y } = *action {
                if !self.0.pointer_in_guard(x, y) {
                    return Err(Error::Unavailable);
                }
            }
            inputs.push(to_input(*action, self.0.marker));
        }
        if inputs.is_empty() {
            return Ok(());
        }
        let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent as usize == inputs.len() {
            Ok(())
        } else {
            Err(Error::Injection)
        }
    }
}
fn to_input(action: Action, marker: usize) -> INPUT {
    let keyboard = |scan: u16, flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wScan: scan,
                dwFlags: flags,
                dwExtraInfo: marker,
                ..Default::default()
            },
        },
    };
    match action {
        Action::Key { key, down } => keyboard(
            key.code(),
            KEYEVENTF_SCANCODE
                | if key.extended() {
                    KEYEVENTF_EXTENDEDKEY
                } else {
                    KEYBD_EVENT_FLAGS(0)
                }
                | if down {
                    KEYBD_EVENT_FLAGS(0)
                } else {
                    KEYEVENTF_KEYUP
                },
        ),
        Action::Unicode { unit, down } => keyboard(
            unit,
            KEYEVENTF_UNICODE
                | if down {
                    KEYBD_EVENT_FLAGS(0)
                } else {
                    KEYEVENTF_KEYUP
                },
        ),
        _ => {
            let (dx, dy, data, flags) = match action {
                Action::Move { x, y } => (
                    x,
                    y,
                    0,
                    MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                ),
                Action::Wheel { horizontal, delta } => (
                    0,
                    0,
                    delta as u32,
                    if horizontal {
                        MOUSEEVENTF_HWHEEL
                    } else {
                        MOUSEEVENTF_WHEEL
                    },
                ),
                Action::Button { button, down } => {
                    let (data, press, release) = match button {
                        Button::Left => (0, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                        Button::Right => (0, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                        Button::Middle => (0, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
                        Button::Back => (1, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP),
                        Button::Forward => (2, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP),
                    };
                    (0, 0, data, if down { press } else { release })
                }
                _ => unreachable!(),
            };
            INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx,
                        dy,
                        mouseData: data,
                        dwFlags: flags,
                        dwExtraInfo: marker,
                        ..Default::default()
                    },
                },
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_flags_keep_extended_unicode_wheel_and_marker_distinct() {
        unsafe {
            let right_ctrl = to_input(
                Action::Key {
                    key: ScanCode::new(0x1d, true).unwrap(),
                    down: false,
                },
                42,
            )
            .Anonymous
            .ki;
            assert_eq!(right_ctrl.wVk.0, 0);
            assert_eq!(right_ctrl.wScan, 0x1d);
            assert_eq!(
                right_ctrl.dwFlags,
                KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP
            );
            assert_eq!(right_ctrl.dwExtraInfo, 42);
            let text = to_input(
                Action::Unicode {
                    unit: 0xd83d,
                    down: true,
                },
                42,
            )
            .Anonymous
            .ki;
            assert_eq!(text.dwFlags, KEYEVENTF_UNICODE);
            let wheel = to_input(
                Action::Wheel {
                    horizontal: true,
                    delta: -120,
                },
                42,
            )
            .Anonymous
            .mi;
            assert_eq!(wheel.mouseData as i32, -120);
            assert_eq!(wheel.dwFlags, MOUSEEVENTF_HWHEEL);
            let movement = to_input(Action::Move { x: 1, y: 65535 }, 42).Anonymous.mi;
            assert_eq!(
                movement.dwFlags,
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
            );
        }
    }
}
