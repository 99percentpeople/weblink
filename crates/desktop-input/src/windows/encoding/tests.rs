use super::*;
use crate::input::{Error, Geometry, Position};

#[test]
fn send_input_grid_preserves_physical_pixels_on_offset_displays() {
    let g = Geometry {
        display: Rect {
            left: -1920,
            top: 240,
            width: 1920,
            height: 1080,
        },
        desktop: Rect {
            left: -1920,
            top: 0,
            width: 4480,
            height: 1440,
        },
    };
    for p in [
        Position { x: 0., y: 0. },
        Position { x: 1., y: 1. },
        Position { x: 0.5, y: 0.5 },
    ] {
        let (px, py) = g.pixels(p).unwrap();
        let (x, y) = absolute(g.desktop, px, py);
        assert_eq!(
            i64::from(g.desktop.left) + i64::from(x) * i64::from(g.desktop.width) / 65536,
            i64::from(px)
        );
        assert_eq!(
            i64::from(g.desktop.top) + i64::from(y) * i64::from(g.desktop.height) / 65536,
            i64::from(py)
        );
    }
    assert_eq!(
        absolute(
            Rect {
                left: -1,
                top: 10,
                width: 1,
                height: 1
            },
            -1,
            10
        ),
        (32768, 32768)
    );
}

#[test]
fn unicode_pairs_preserve_scalars_and_cleanup_partial_injection() {
    let mut state = TextState::default();
    let mut sent = Vec::new();
    state
        .insert(
            "中😀𝄞e\u{301}",
            || Ok(()),
            |strokes| {
                sent.extend_from_slice(strokes);
                Ok(())
            },
        )
        .unwrap();
    let expected: Vec<_> = "中😀𝄞e\u{301}"
        .encode_utf16()
        .flat_map(|unit| [Unicode { unit, down: true }, Unicode { unit, down: false }])
        .collect();
    assert_eq!(sent, expected);
    state
        .cancel(|_| panic!("successful text has no held unit"))
        .unwrap();
    assert_eq!(
        state.insert(
            "😀",
            || Ok(()),
            |strokes| {
                assert_eq!(strokes[0].unit, 0xd83d);
                Err(Error::Injection)
            }
        ),
        Err(Error::Injection)
    );
    let mut releases = Vec::new();
    state
        .cancel(|strokes| {
            releases.extend_from_slice(strokes);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        releases,
        [Unicode {
            unit: 0xd83d,
            down: false
        }]
    );
    state.cancel(|_| panic!("must not release twice")).unwrap();
}

#[test]
fn focus_or_deadline_changes_stop_between_native_units_without_replay() {
    for error in [Error::WindowFocusLost, Error::Stale] {
        let mut state = TextState::default();
        let mut checks = 0;
        let mut sent = Vec::new();
        assert_eq!(
            state.insert(
                "AB",
                || {
                    checks += 1;
                    if checks == 2 {
                        Err(error)
                    } else {
                        Ok(())
                    }
                },
                |strokes| {
                    sent.extend_from_slice(strokes);
                    Ok(())
                }
            ),
            Err(error)
        );
        assert_eq!(
            sent,
            [
                Unicode {
                    unit: 65,
                    down: true
                },
                Unicode {
                    unit: 65,
                    down: false
                }
            ]
        );
        state
            .cancel(|_| panic!("complete pairs need no release"))
            .unwrap();
    }
}

#[test]
fn panicking_native_insertion_keeps_the_pending_release() {
    let mut state = TextState::default();
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        state.insert("A", || Ok(()), |_| panic!("injection panic"))
    }))
    .is_err());
    let mut released = Vec::new();
    state
        .cancel(|strokes| {
            released.extend_from_slice(strokes);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        released,
        [Unicode {
            unit: 65,
            down: false
        }]
    );
}
