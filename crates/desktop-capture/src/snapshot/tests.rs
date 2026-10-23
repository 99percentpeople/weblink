use super::*;

fn source() -> PixelRect {
    PixelRect {
        left: -1920,
        top: -200,
        width: 1920,
        height: 1080,
    }
}

#[test]
fn sizing_preserves_aspect_ratio_and_native_detail() {
    let options = SnapshotOptions::default();
    assert_eq!(options.region(&source()).unwrap().dimensions(), (1024, 576));
    let portrait = PixelRect {
        width: 2160,
        height: 3840,
        ..source()
    };
    assert_eq!(options.region(&portrait).unwrap().dimensions(), (576, 1024));
    assert_eq!(fit(2160, 3840, 1600, 1600), (900, 1600));
    assert_eq!(fit(3840, 2160, 2048, 1536), (2048, 1152));
    assert_eq!(fit(300, 200, 1600, 1600), (300, 200));
    assert_eq!(fit(1, 4096, 2048, 2048), (1, 2048));
    assert_eq!(fit(4096, 1, 2048, 2048), (2048, 1));
}

#[test]
fn sizing_selects_the_limiting_axis_before_integer_rounding() {
    assert_eq!(fit(10, 3, 6, 1), (3, 1));
    assert_eq!(fit(3, 10, 1, 6), (1, 3));
    assert_eq!(fit(1920, 1080, 1600, 899), (1598, 899));
}

#[test]
fn desktop_crop_keeps_negative_origin_and_crops_before_scaling() {
    let rect = PixelRect {
        left: -1800,
        top: -100,
        width: 700,
        height: 500,
    };
    let options = SnapshotOptions {
        rect: Some(rect.clone()),
        ..Default::default()
    };
    let area = options.region(&source()).unwrap();
    assert_eq!(area.bounds, rect);
    assert_eq!((area.x, area.y), (120, 100));
    assert_eq!(area.dimensions(), (700, 500));
    let resized = SnapshotOptions {
        max_width: 350,
        max_height: 250,
        ..options
    };
    assert_eq!(resized.region(&source()).unwrap().dimensions(), (350, 250));
}

#[test]
fn invalid_limits_overflows_and_outside_rectangles_are_rejected() {
    for (width, height) in [(0, 1600), (2049, 1600), (1600, 0), (1600, 2049)] {
        assert!(SnapshotOptions {
            max_width: width,
            max_height: height,
            rect: None
        }
        .validate()
        .is_err());
    }
    for rect in [
        PixelRect {
            left: -1921,
            ..source()
        },
        PixelRect {
            top: -201,
            ..source()
        },
        PixelRect {
            width: 1921,
            ..source()
        },
        PixelRect {
            height: 1081,
            ..source()
        },
        PixelRect {
            width: 0,
            ..source()
        },
        PixelRect {
            left: i32::MAX,
            width: 1,
            ..source()
        },
    ] {
        assert!(SnapshotOptions {
            rect: Some(rect),
            ..Default::default()
        }
        .region(&source())
        .is_err());
    }
    for value in [
        serde_json::json!({"maxWidth":1.5}),
        serde_json::json!({"rect":{"left":0,"top":0,"width":1,"height":1,"x":0}}),
    ] {
        assert!(serde_json::from_value::<SnapshotOptions>(value).is_err());
    }
}
