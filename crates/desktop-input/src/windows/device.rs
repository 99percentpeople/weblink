use super::{environment, safety::Safety};
use crate::{engine::Device, input::*};
use windows::Win32::UI::Input::KeyboardAndMouse::*;

pub(super) struct WindowsDevice(
    pub Safety,
    pub super::touch::TouchDevice,
    pub super::pan::PanDevice,
    pub super::gamepad::GamepadDevice,
    pub super::encoding::TextState,
);
impl Device for WindowsDevice {
    fn submit_text(
        &mut self,
        text: &str,
        window: Option<&crate::window::BoundWindow>,
        deadline: std::time::Instant,
    ) -> Result<(), Error> {
        if super::text::insert(text, window, || self.available())? {
            return Ok(());
        }
        let safety = &self.0;
        self.4.insert(
            text,
            || {
                if std::time::Instant::now() > deadline {
                    return Err(Error::Stale);
                }
                if let Some(window) = window {
                    window.check(None)?;
                }
                Ok(())
            },
            |strokes| submit_unicode(safety, strokes),
        )
    }
    fn cancel_text(&mut self) -> Result<(), Error> {
        let safety = &self.0;
        self.4.cancel(|strokes| submit_unicode(safety, strokes))
    }
    fn reset_gamepad_feedback(&mut self, slot: u8) {
        self.3.reset_feedback(slot);
    }
    fn gamepad_feedback(&mut self) -> Vec<(u8, crate::gamepad::Rumble)> {
        self.3.feedback()
    }
    fn capabilities(&self) -> Vec<crate::devices::Capability> {
        capabilities(
            self.pan_supported(),
            self.touch_supported(),
            self.3.capability(),
        )
    }
    fn refresh_capabilities(&mut self) {
        self.3.refresh();
    }
    fn submit_gamepad(&mut self, slot: u8, state: crate::gamepad::State) -> Result<(), Error> {
        self.3.submit(slot, state)
    }
    fn mount(&mut self, key: crate::devices::Key) -> Result<(), Error> {
        match key.kind {
            crate::devices::Kind::Touchscreen => self.1.mount(),
            crate::devices::Kind::Gamepad => self.3.mount(key.slot),
            _ => Ok(()),
        }
    }
    fn unmount(&mut self, key: crate::devices::Key) -> Result<(), Error> {
        match key.kind {
            crate::devices::Kind::Touchscreen => {
                self.1.unmount();
                Ok(())
            }
            crate::devices::Kind::Touchpad => self.2.cancel(),
            crate::devices::Kind::Gamepad => self.3.unmount(key.slot),
            _ => Ok(()),
        }
    }
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
        available(&self.0)
    }
    fn geometry_current(&self, g: Geometry) -> bool {
        self.0.geometry_current(g)
    }
    fn submit(&mut self, actions: &[Action]) -> Result<(), Error> {
        let only_release = actions.iter().all(|a| {
            matches!(
                a,
                Action::Key { down: false, .. } | Action::Button { down: false, .. }
            )
        });
        if !environment::desktop_available() || (!only_release && !self.available()) {
            return Err(Error::Unavailable);
        }
        let mut inputs = Vec::with_capacity(actions.len());
        for action in actions {
            if let Action::Move { x, y } = *action {
                let (x, y) = super::encoding::absolute(self.0.desktop(), x, y);
                if !self.0.pointer_in_guard(x, y) {
                    return Err(Error::Unavailable);
                }
            }
            inputs.push(to_input(*action, self.0.marker, self.0.desktop()));
        }
        submit_inputs(&inputs)
    }
}
pub(super) fn capabilities(
    pan: bool,
    touch: bool,
    gamepad: crate::devices::Capability,
) -> Vec<crate::devices::Capability> {
    use crate::devices::{Capability, Kind};
    vec![
        Capability::system(Kind::Keyboard, true),
        Capability::system(Kind::Mouse, true),
        Capability::system(Kind::Touchpad, pan),
        Capability::system(Kind::Touchscreen, touch),
        gamepad,
    ]
}
fn keyboard(scan: u16, flags: KEYBD_EVENT_FLAGS, marker: usize) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wScan: scan,
                dwFlags: flags,
                dwExtraInfo: marker,
                ..Default::default()
            },
        },
    }
}
fn to_input(action: Action, marker: usize, desktop: Rect) -> INPUT {
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
            marker,
        ),
        _ => {
            let (dx, dy, data, flags) = match action {
                Action::Move { x, y } => {
                    let (x, y) = super::encoding::absolute(desktop, x, y);
                    (
                        x,
                        y,
                        0,
                        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    )
                }
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
fn available(safety: &Safety) -> bool {
    !safety.observations.pending() && environment::desktop_available() && safety.guard_current()
}
fn submit_inputs(inputs: &[INPUT]) -> Result<(), Error> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err(Error::Injection)
    }
}
fn unicode_input(stroke: super::encoding::Unicode, marker: usize) -> INPUT {
    keyboard(
        stroke.unit,
        KEYEVENTF_UNICODE
            | if stroke.down {
                KEYBD_EVENT_FLAGS(0)
            } else {
                KEYEVENTF_KEYUP
            },
        marker,
    )
}
fn submit_unicode(safety: &Safety, strokes: &[super::encoding::Unicode]) -> Result<(), Error> {
    if !environment::desktop_available() || (strokes.iter().any(|s| s.down) && !available(safety)) {
        return Err(Error::Unavailable);
    }
    let inputs: Vec<_> = strokes
        .iter()
        .map(|s| unicode_input(*s, safety.marker))
        .collect();
    submit_inputs(&inputs)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn desktop() -> Rect {
        Rect {
            left: 0,
            top: 0,
            width: 65536,
            height: 65536,
        }
    }
    #[test]
    fn native_flags_keep_extended_unicode_wheel_and_marker_distinct() {
        unsafe {
            let right_ctrl = to_input(
                Action::Key {
                    key: ScanCode::new(0x1d, true).unwrap(),
                    down: false,
                },
                42,
                desktop(),
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
            let text = unicode_input(
                super::super::encoding::Unicode {
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
                desktop(),
            )
            .Anonymous
            .mi;
            assert_eq!(wheel.mouseData as i32, -120);
            assert_eq!(wheel.dwFlags, MOUSEEVENTF_HWHEEL);
            let movement = to_input(Action::Move { x: 1, y: 65535 }, 42, desktop())
                .Anonymous
                .mi;
            assert_eq!(
                movement.dwFlags,
                MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
            );
        }
    }
}
