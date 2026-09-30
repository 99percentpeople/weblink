//! Physical display coordinates. A layout revision is valid only for this service lifetime.
use crate::Result;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelRect {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}
impl PixelRect {
    fn edges(&self) -> Result<(i32, i32)> {
        if self.width == 0 || self.height == 0 {
            return Err("Display has no physical area".into());
        }
        let right = i64::from(self.left) + i64::from(self.width);
        let bottom = i64::from(self.top) + i64::from(self.height);
        Ok((
            right.try_into().map_err(|_| "Display bounds overflow")?,
            bottom.try_into().map_err(|_| "Display bounds overflow")?,
        ))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayGeometry {
    pub source_id: String,
    /// Physical desktop pixels, already oriented as displayed (not encoder dimensions).
    pub bounds: PixelRect,
    pub rotation: u16,
    /// OS resource scale, not a multiplier for physical coordinates. None if unavailable.
    pub scale_percent: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayLayout {
    pub revision: String,
    pub virtual_bounds: PixelRect,
    pub displays: Vec<DisplayGeometry>,
}

#[derive(Default)]
pub(crate) struct LayoutTracker(Option<DisplayLayout>);
impl LayoutTracker {
    pub fn invalidate(&mut self) {
        self.0 = None;
    }

    pub fn update(&mut self, mut displays: Vec<DisplayGeometry>) -> Result<DisplayLayout> {
        let result = self.build(&mut displays);
        if result.is_err() {
            self.invalidate();
        }
        result
    }

    fn build(&mut self, displays: &mut [DisplayGeometry]) -> Result<DisplayLayout> {
        displays.sort_by(|a, b| a.source_id.cmp(&b.source_id));
        if displays.is_empty() || displays.len() > 64 {
            return Err("Display layout unavailable".into());
        }
        let mut left = i32::MAX;
        let mut top = i32::MAX;
        let mut right = i32::MIN;
        let mut bottom = i32::MIN;
        for (i, display) in displays.iter().enumerate() {
            if display.source_id.is_empty()
                || (i > 0 && displays[i - 1].source_id == display.source_id)
                || ![0, 90, 180, 270].contains(&display.rotation)
                || display
                    .scale_percent
                    .is_some_and(|scale| !(100..=500).contains(&scale))
            {
                return Err("Invalid display geometry".into());
            }
            let (r, b) = display.bounds.edges()?;
            left = left.min(display.bounds.left);
            top = top.min(display.bounds.top);
            right = right.max(r);
            bottom = bottom.max(b);
        }
        if let Some(layout) = &self.0 {
            if layout.displays == displays {
                return Ok(layout.clone());
            }
        }
        let layout = DisplayLayout {
            revision: uuid::Uuid::new_v4().to_string(),
            virtual_bounds: PixelRect {
                left,
                top,
                width: (i64::from(right) - i64::from(left)) as u32,
                height: (i64::from(bottom) - i64::from(top)) as u32,
            },
            displays: displays.to_vec(),
        };
        self.0 = Some(layout.clone());
        Ok(layout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn display(id: &str, left: i32) -> DisplayGeometry {
        DisplayGeometry {
            source_id: id.into(),
            bounds: PixelRect {
                left,
                top: 0,
                width: 1920,
                height: 1080,
            },
            rotation: 0,
            scale_percent: Some(150),
        }
    }
    #[test]
    fn physical_bounds_include_negative_origins_without_applying_resource_scale() {
        let mut tracker = LayoutTracker::default();
        let a = display("a", -1920);
        let b = display("b", 0);
        let first = tracker.update(vec![b.clone(), a.clone()]).unwrap();
        assert_eq!(
            first.virtual_bounds,
            PixelRect {
                left: -1920,
                top: 0,
                width: 3840,
                height: 1080
            }
        );
        assert_eq!(first, tracker.update(vec![a.clone(), b]).unwrap());
        let removed = tracker.update(vec![a.clone()]).unwrap();
        assert_ne!(first.revision, removed.revision);
        let mut rotated = a;
        rotated.rotation = 90;
        rotated.bounds.width = 1080;
        rotated.bounds.height = 1920;
        assert_ne!(
            removed.revision,
            tracker.update(vec![rotated]).unwrap().revision
        );
    }
    #[test]
    fn failed_queries_and_scale_changes_invalidate_old_revisions() {
        let mut tracker = LayoutTracker::default();
        let mut a = display("a", 0);
        let first = tracker.update(vec![a.clone()]).unwrap();
        a.scale_percent = Some(200);
        let scaled = tracker.update(vec![a.clone()]).unwrap();
        assert_ne!(first.revision, scaled.revision);
        assert!(tracker.update(vec![]).is_err());
        assert_ne!(
            scaled.revision,
            tracker.update(vec![a.clone()]).unwrap().revision
        );
        assert!(tracker.update(vec![a.clone(), a.clone()]).is_err());
        a.bounds.left = i32::MAX;
        assert!(tracker.update(vec![a]).is_err());
    }
}
