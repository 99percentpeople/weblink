//! Bounded screenshots and crops in physical desktop coordinates.
use crate::{geometry::PixelRect, Result};
use serde::Deserialize;

// Even an incompressible RGB image at the default square size fits the PNG budget.
// Use a window/desktop crop for detail instead of enlarging every full-screen image.
pub const DEFAULT_MAX_DIMENSION: u32 = 1024;
pub const MAX_DIMENSION: u32 = 2048;
pub const MAX_PNG_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotOptions {
    pub max_width: u32,
    pub max_height: u32,
    /// Absolute physical desktop pixels, wholly inside the selected source.
    pub rect: Option<PixelRect>,
}
impl Default for SnapshotOptions {
    fn default() -> Self {
        Self {
            max_width: DEFAULT_MAX_DIMENSION,
            max_height: DEFAULT_MAX_DIMENSION,
            rect: None,
        }
    }
}
impl SnapshotOptions {
    pub fn validate(&self) -> Result<()> {
        if !(1..=MAX_DIMENSION).contains(&self.max_width)
            || !(1..=MAX_DIMENSION).contains(&self.max_height)
            || self.rect.as_ref().is_some_and(|r| r.edges().is_err())
        {
            return Err("INVALID_ARGUMENTS".into());
        }
        Ok(())
    }
    pub(crate) fn region(&self, source: &PixelRect) -> Result<Region> {
        self.validate()?;
        let (right, bottom) = source.edges()?;
        let bounds = self.rect.as_ref().unwrap_or(source);
        let (r, b) = bounds.edges()?;
        if bounds.left < source.left || bounds.top < source.top || r > right || b > bottom {
            return Err("RECT_OUT_OF_BOUNDS".into());
        }
        Ok(Region {
            bounds: bounds.clone(),
            x: (i64::from(bounds.left) - i64::from(source.left)) as u32,
            y: (i64::from(bounds.top) - i64::from(source.top)) as u32,
            max_width: self.max_width,
            max_height: self.max_height,
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Region {
    pub bounds: PixelRect,
    /// Offsets in the oriented source frame, before any scaling.
    pub x: u32,
    pub y: u32,
    pub max_width: u32,
    pub max_height: u32,
}
impl Region {
    pub fn dimensions(&self) -> (u32, u32) {
        fit(
            self.bounds.width,
            self.bounds.height,
            self.max_width,
            self.max_height,
        )
    }
}

pub(crate) fn fit(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    let w = width.min(max_width);
    let h = height.min(max_height);
    // Select the limiting axis before rounding: 10x3 inside 6x1 is 3x1,
    // not 6x1. Comparing truncated heights would stretch narrow crops.
    if u64::from(w) * u64::from(height) <= u64::from(h) * u64::from(width) {
        (
            w,
            (u64::from(height) * u64::from(w) / u64::from(width)).max(1) as u32,
        )
    } else {
        (
            (u64::from(width) * u64::from(h) / u64::from(height)).max(1) as u32,
            h,
        )
    }
}

#[cfg(test)]
mod tests;
