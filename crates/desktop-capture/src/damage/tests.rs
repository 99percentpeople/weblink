use super::*;

fn rect(left: i32, top: i32, right: i32, bottom: i32) -> DirtyRect {
    DirtyRect {
        left,
        top,
        right,
        bottom,
    }
}
fn regions(rects: &[DirtyRect]) -> Damage {
    Damage::from_rects(Some(rects), (1000, 800))
}

#[test]
fn unknown_is_never_mistaken_for_unchanged() {
    assert_eq!(Damage::default().rects(), None);
    assert_eq!(Damage::unchanged().rects(), Some([].as_slice()));
    let mut pending = regions(&[rect(1, 2, 3, 4)]);
    pending.merge(&Damage::default());
    pending.merge(&regions(&[rect(100, 200, 300, 400)]));
    assert_eq!(pending.rects(), None);
    assert_eq!(pending.take().rects(), None);
    assert_eq!(pending.rects(), Some([].as_slice()));
}

#[test]
fn skipped_frames_accumulate_until_each_consumer_accepts_a_frame() {
    let first = regions(&[rect(10, 10, 20, 20)]);
    let second = regions(&[rect(100, 100, 110, 110)]);
    let third = regions(&[rect(200, 200, 210, 210)]);
    let mut fast = Damage::unchanged();
    let mut slow = Damage::unchanged();
    for frame in [&first, &second, &third] {
        fast.merge(frame);
        slow.merge(frame);
        assert_eq!(fast.take(), *frame);
    }
    assert_eq!(
        slow.take().rects().unwrap(),
        &[
            rect(10, 10, 20, 20),
            rect(100, 100, 110, 110),
            rect(200, 200, 210, 210)
        ]
    );
    assert!(slow.rects().unwrap().is_empty());
}

#[test]
fn invalid_metadata_falls_back_and_offscreen_rectangles_are_clipped() {
    assert_eq!(regions(&[rect(20, 10, 10, 20)]).rects(), None);
    assert_eq!(
        regions(&[rect(-10, -20, 10, 20)]).rects(),
        Some([rect(0, 0, 10, 20)].as_slice())
    );
    assert!(regions(&[rect(-10, -20, -1, -1)])
        .rects()
        .unwrap()
        .is_empty());
    assert_eq!(Damage::from_rects(Some(&[]), (0, 10)).rects(), None);
}

#[test]
fn accumulation_is_bounded_without_losing_updates() {
    let mut pending = Damage::unchanged();
    for i in 0..=MAX_DIRTY_RECTS as i32 {
        pending.merge(&regions(&[rect(i * 3, 0, i * 3 + 1, 1)]));
    }
    assert_eq!(pending.rects(), None);
    let mut repeated = Damage::unchanged();
    for i in 0..1000 {
        repeated.merge(&regions(&[rect(i, 10, i + 2, 20)]));
    }
    assert_eq!(repeated.rects(), Some([rect(0, 10, 1000, 20)].as_slice()));
}

#[test]
fn rotation_and_scaling_cover_filtering_and_chroma_neighbors() {
    let damage = Damage::from_rects(Some(&[rect(10, 20, 30, 40)]), (100, 80));
    assert_eq!(
        damage
            .for_output((100, 80), Rotation::Clockwise90, (80, 100))
            .rects(),
        Some([rect(40, 10, 60, 30)].as_slice())
    );
    assert_eq!(
        damage
            .for_output((100, 80), Rotation::Clockwise180, (100, 80))
            .rects(),
        Some([rect(70, 40, 90, 60)].as_slice())
    );
    assert_eq!(
        damage
            .for_output((100, 80), Rotation::Clockwise270, (80, 100))
            .rects(),
        Some([rect(20, 70, 40, 90)].as_slice())
    );
    assert_eq!(
        damage
            .for_output((100, 80), Rotation::Identity, (50, 40))
            .rects(),
        Some([rect(4, 8, 16, 22)].as_slice())
    );
    let edge = Damage::from_rects(Some(&[rect(98, 78, 100, 80)]), (100, 80));
    assert_eq!(
        edge.for_output((100, 80), Rotation::Identity, (50, 40))
            .rects(),
        Some([rect(48, 38, 50, 40)].as_slice())
    );
}

#[test]
fn rotation_round_trips_cursor_coordinates() {
    let rect = rect(11, 23, 37, 49);
    for rotation in [
        Rotation::Identity,
        Rotation::Clockwise90,
        Rotation::Clockwise180,
        Rotation::Clockwise270,
    ] {
        let rotated = rect.rotate((100, 80), rotation);
        assert_eq!(
            rotated.rotate(rotation.dimensions((100, 80)), rotation.inverse()),
            rect
        );
    }
}
