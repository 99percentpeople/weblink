//! Windows-only coordinate and keyboard encoding; wire values remain unchanged.
use crate::input::Rect;
#[cfg(test)]
mod tests;

pub(super) fn absolute(desktop: Rect, x: i32, y: i32) -> (i32, i32) {
    let axis = |pixel: i32, origin: i32, span: u32| {
        // Aim at the pixel's center in SendInput's 65536-bin virtual desktop grid.
        (((i64::from(pixel) - i64::from(origin)) * 65536 + 32768) / i64::from(span)).clamp(0, 65535)
            as i32
    };
    (
        axis(x, desktop.left, desktop.width),
        axis(y, desktop.top, desktop.height),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Unicode {
    pub unit: u16,
    pub down: bool,
}

#[derive(Default)]
pub(super) struct TextState {
    pending: Option<u16>,
}
impl TextState {
    pub fn insert(
        &mut self,
        text: &str,
        mut check: impl FnMut() -> Result<(), crate::input::Error>,
        mut submit: impl FnMut(&[Unicode]) -> Result<(), crate::input::Error>,
    ) -> Result<(), crate::input::Error> {
        for unit in text.encode_utf16() {
            check()?;
            self.pending = Some(unit); // SendInput may insert only the down half or panic.
            submit(&[Unicode { unit, down: true }, Unicode { unit, down: false }])?;
            self.pending = None;
        }
        Ok(())
    }
    pub fn cancel(
        &mut self,
        mut submit: impl FnMut(&[Unicode]) -> Result<(), crate::input::Error>,
    ) -> Result<(), crate::input::Error> {
        if let Some(unit) = self.pending.take() {
            submit(&[Unicode { unit, down: false }])?;
        }
        Ok(())
    }
}
