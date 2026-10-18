//! Separate DXGI cursors are composited after capture; include their old and new
//! bounds in texture damage so moving/hiding a cursor cannot leave stale pixels.
use super::{Cursor, DirtyRect, Rotation};
use crate::damage::Damage;
use std::sync::Arc;

pub(super) fn include_cursor(
    damage: &mut Damage,
    previous: Option<&Cursor>,
    next: Option<&Cursor>,
    size: (u32, u32),
    rotation: Rotation,
) {
    let same = match (previous, next) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a.visible == b.visible
                && a.x == b.x
                && a.y == b.y
                && a.width == b.width
                && a.height == b.height
                && a.pitch == b.pitch
                && a.shape == b.shape
                && Arc::ptr_eq(&a.bytes, &b.bytes)
        }
        _ => false,
    };
    if same {
        return;
    }
    let display = rotation.dimensions(size);
    for cursor in [previous, next].into_iter().flatten().filter(|c| c.visible) {
        let rect = DirtyRect {
            left: cursor.x,
            top: cursor.y,
            right: cursor
                .x
                .saturating_add(cursor.width.min(i32::MAX as u32) as i32),
            bottom: cursor
                .y
                .saturating_add(cursor.height.min(i32::MAX as u32) as i32),
        };
        if let Some(rect) = rect.clip(display) {
            damage.add(rect.rotate(display, rotation.inverse()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn moving_hiding_and_rotating_a_cursor_covers_previous_pixels() {
        let old = Cursor {
            visible: true,
            x: 10,
            y: 20,
            width: 4,
            height: 6,
            ..Default::default()
        };
        let next = Cursor {
            x: 40,
            ..old.clone()
        };
        let mut damage = Damage::unchanged();
        include_cursor(
            &mut damage,
            Some(&old),
            Some(&next),
            (100, 80),
            Rotation::Clockwise90,
        );
        assert_eq!(
            damage.rects().unwrap(),
            &[
                DirtyRect {
                    left: 20,
                    top: 66,
                    right: 26,
                    bottom: 70
                },
                DirtyRect {
                    left: 20,
                    top: 36,
                    right: 26,
                    bottom: 40
                },
            ]
        );
        let hidden = Cursor {
            visible: false,
            ..next.clone()
        };
        let mut damage = Damage::unchanged();
        include_cursor(
            &mut damage,
            Some(&next),
            Some(&hidden),
            (100, 80),
            Rotation::Identity,
        );
        assert_eq!(damage.rects().unwrap().len(), 1);
        let mut damage = Damage::unchanged();
        include_cursor(
            &mut damage,
            Some(&next),
            Some(&next),
            (100, 80),
            Rotation::Identity,
        );
        assert!(damage.rects().unwrap().is_empty());
    }
}
