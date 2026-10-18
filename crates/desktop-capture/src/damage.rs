//! Optional capture damage. Pixels always describe a complete frame; damage is
//! only a hint relative to the previous frame delivered by the same producer.

/// Pixel bounds with exclusive right/bottom edges, before capture rotation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DirtyRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Rotation {
    #[default]
    Identity,
    Clockwise90,
    Clockwise180,
    Clockwise270,
}
impl Rotation {
    pub(crate) fn dimensions(self, size: (u32, u32)) -> (u32, u32) {
        match self {
            Self::Clockwise90 | Self::Clockwise270 => (size.1, size.0),
            _ => size,
        }
    }
    pub(crate) fn inverse(self) -> Self {
        match self {
            Self::Clockwise90 => Self::Clockwise270,
            Self::Clockwise270 => Self::Clockwise90,
            other => other,
        }
    }
}

impl DirtyRect {
    pub(crate) fn clip(self, size: (u32, u32)) -> Option<Self> {
        let rect = Self {
            left: self.left.max(0),
            top: self.top.max(0),
            right: self.right.min(size.0 as i32),
            bottom: self.bottom.min(size.1 as i32),
        };
        (rect.left < rect.right && rect.top < rect.bottom).then_some(rect)
    }
    pub(crate) fn rotate(self, size: (u32, u32), rotation: Rotation) -> Self {
        let (w, h) = (size.0 as i32, size.1 as i32);
        let (left, top, right, bottom) = match rotation {
            Rotation::Identity => (self.left, self.top, self.right, self.bottom),
            Rotation::Clockwise90 => (h - self.bottom, self.left, h - self.top, self.right),
            Rotation::Clockwise180 => {
                (w - self.right, h - self.bottom, w - self.left, h - self.top)
            }
            Rotation::Clockwise270 => (self.top, w - self.right, self.bottom, w - self.left),
        };
        Self {
            left,
            top,
            right,
            bottom,
        }
    }
}

// Bound both accumulation during backpressure and driver attribute allocations.
pub(crate) const MAX_DIRTY_RECTS: usize = 64;

/// None means unknown/full damage; Some([]) explicitly means unchanged.
/// Each consumer owns its accumulator and clears it only after accepting pixels.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Damage(Option<Vec<DirtyRect>>);
impl Damage {
    pub fn unchanged() -> Self {
        Self(Some(Vec::new()))
    }
    pub fn rects(&self) -> Option<&[DirtyRect]> {
        self.0.as_deref()
    }
    pub fn take(&mut self) -> Self {
        std::mem::replace(self, Self::unchanged())
    }
    pub fn from_rects(rects: Option<&[DirtyRect]>, size: (u32, u32)) -> Self {
        let Some(rects) = rects else {
            return Self::default();
        };
        if size.0 == 0 || size.1 == 0 || size.0 > i32::MAX as u32 || size.1 > i32::MAX as u32 {
            return Self::default();
        }
        let mut damage = Self::unchanged();
        for &rect in rects {
            if rect.left >= rect.right || rect.top >= rect.bottom {
                return Self::default();
            }
            if let Some(rect) = rect.clip(size) {
                damage.add(rect);
                if damage.rects().is_none() {
                    return damage;
                }
            }
        }
        damage
    }
    pub fn add(&mut self, rect: DirtyRect) {
        let Some(rects) = &mut self.0 else { return };
        // Coalescing touching regions is conservative and avoids growing a list
        // for repeated cursor moves or updates in the same part of the screen.
        if let Some(existing) = rects.iter_mut().find(|r| {
            rect.left <= r.right
                && rect.right >= r.left
                && rect.top <= r.bottom
                && rect.bottom >= r.top
        }) {
            existing.left = existing.left.min(rect.left);
            existing.top = existing.top.min(rect.top);
            existing.right = existing.right.max(rect.right);
            existing.bottom = existing.bottom.max(rect.bottom);
        } else if rects.len() < MAX_DIRTY_RECTS {
            rects.push(rect);
        } else {
            // Losing precision is safe; dropping a changed region is not.
            self.0 = None;
        }
    }
    pub fn merge(&mut self, other: &Self) {
        if let Some(rects) = &other.0 {
            for &rect in rects {
                self.add(rect);
            }
        } else {
            self.0 = None;
        }
    }
    pub fn for_output(&self, source: (u32, u32), rotation: Rotation, output: (u32, u32)) -> Self {
        let Some(rects) = self.rects() else {
            return Self::default();
        };
        if source.0 == 0 || source.1 == 0 || output.0 == 0 || output.1 == 0 {
            return Self::default();
        }
        let display = rotation.dimensions(source);
        let mut result = Self::unchanged();
        for rect in rects {
            let mut rect = rect.rotate(source, rotation);
            if display != output {
                // Bilinear filtering can change adjacent output pixels. Expand
                // in source space before outward rounding and NV12 alignment.
                rect.left = (rect.left - 1).max(0);
                rect.top = (rect.top - 1).max(0);
                rect.right = (rect.right + 1).min(display.0 as i32);
                rect.bottom = (rect.bottom + 1).min(display.1 as i32);
            }
            let low =
                |n: i32, from: u32, to: u32| ((n as u64 * to as u64 / from as u64) as i32) & !1;
            let high = |n: i32, from: u32, to: u32| {
                (((n as u64 * to as u64).div_ceil(from as u64) as i32 + 1) & !1).min(to as i32)
            };
            result.add(DirtyRect {
                left: low(rect.left, display.0, output.0),
                top: low(rect.top, display.1, output.1),
                right: high(rect.right, display.0, output.0),
                bottom: high(rect.bottom, display.1, output.1),
            });
        }
        result
    }
}

#[cfg(test)]
mod tests;
