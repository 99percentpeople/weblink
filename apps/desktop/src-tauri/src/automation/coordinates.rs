//! All automation observations use physical desktop pixels; only the input wire is normalized.
use base64::Engine;
use serde_json::{json, Value};
use weblink_desktop_capture::{geometry::PixelRect, CaptureSnapshot};
use weblink_desktop_input::input::{Geometry, Rect};

pub(crate) fn rect(value: &PixelRect) -> Rect {
    Rect {
        left: value.left,
        top: value.top,
        width: value.width,
        height: value.height,
    }
}
pub(crate) fn metadata(source: &str, revision: &str, geometry: Geometry) -> Value {
    let bounds = |r: Rect| json!({"left":r.left,"top":r.top,"width":r.width,"height":r.height});
    json!({"coordinateSpace":"desktopPhysicalPixels", "sourceId":source,
        "geometryRevision":revision, "bounds":bounds(geometry.display), "virtualBounds":bounds(geometry.desktop)})
}
pub(super) fn screenshot(source: &str, snapshot: CaptureSnapshot) -> Result<Value, String> {
    if snapshot.image.len() > 4 * 1024 * 1024 {
        return Err("RESULT_TOO_LARGE".into());
    }
    let reader = png::Decoder::new(std::io::Cursor::new(&snapshot.image))
        .read_info()
        .map_err(|_| "INVALID_CAPTURE")?;
    let (width, height) = (reader.info().width, reader.info().height);
    if width == 0 || height == 0 || width > 640 || height > 360 {
        return Err("INVALID_CAPTURE".into());
    }
    let bounds = &snapshot.bounds;
    let mut result = metadata(
        source,
        &snapshot.layout.revision,
        Geometry {
            display: rect(bounds),
            desktop: rect(&snapshot.layout.virtual_bounds),
        },
    );
    result["mimeType"] = json!("image/png");
    result["data"] = json!(base64::engine::general_purpose::STANDARD.encode(&snapshot.image));
    result["imageWidth"] = json!(width);
    result["imageHeight"] = json!(height);
    // Image coordinates have their origin at the upper-left edge. No CSS/DPI scale is involved.
    result["imageToDesktop"] = json!({
        "scaleX":f64::from(bounds.width)/f64::from(width),
        "scaleY":f64::from(bounds.height)/f64::from(height),
        "offsetX":bounds.left,"offsetY":bounds.top,
    });
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    use weblink_desktop_input::input::Position;
    fn geometry() -> Geometry {
        Geometry {
            display: Rect {
                left: -1080,
                top: -200,
                width: 1080,
                height: 1920,
            },
            desktop: Rect {
                left: -1080,
                top: -200,
                width: 3000,
                height: 1920,
            },
        }
    }
    #[test]
    fn physical_points_round_trip_and_reject_out_of_bounds() {
        let g = geometry();
        for (x, y) in [(-1080, -200), (-1, 1719), (-540, 760)] {
            let p = g
                .normalized(Position {
                    x: x as f64,
                    y: y as f64,
                })
                .unwrap();
            assert_eq!(g.pixels(p), Some((x, y)));
        }
        for (x, y) in [
            (0., 760.),
            (-1080.1, 0.),
            (-540., -200.1),
            (-540., 1720.),
            (f64::NAN, 0.),
            (-540., f64::INFINITY),
        ] {
            assert!(g.normalized(Position { x, y }).is_none());
        }
        let r = Rect {
            left: -1,
            top: -1,
            width: 1,
            height: 1,
        };
        let g = Geometry {
            display: r,
            desktop: r,
        };
        assert_eq!(
            g.normalized(Position { x: -1., y: -1. }),
            Some(Position { x: 0., y: 0. })
        );
        assert_eq!(g.normalized(Position { x: 0., y: -1. }), None);
    }
    #[test]
    fn screenshot_mapping_uses_actual_png_dimensions_and_ignores_dpi_and_rotation_metadata() {
        use weblink_desktop_capture::geometry::{DisplayGeometry, DisplayLayout};
        let mut png = Vec::new();
        {
            let mut e = png::Encoder::new(&mut png, 202, 360);
            e.set_color(png::ColorType::Rgba);
            e.set_depth(png::BitDepth::Eight);
            e.write_header()
                .unwrap()
                .write_image_data(&vec![0; 202 * 360 * 4])
                .unwrap();
        }
        let bounds = PixelRect {
            left: -1080,
            top: -200,
            width: 1080,
            height: 1920,
        };
        let result = screenshot(
            "monitor",
            CaptureSnapshot {
                image: png,
                bounds: bounds.clone(),
                layout: DisplayLayout {
                    revision: "rev".into(),
                    virtual_bounds: bounds.clone(),
                    displays: vec![DisplayGeometry {
                        source_id: "monitor".into(),
                        bounds,
                        rotation: 90,
                        scale_percent: Some(150),
                    }],
                },
            },
        )
        .unwrap();
        assert_eq!(result["imageWidth"], 202);
        assert_eq!(result["imageHeight"], 360);
        assert_eq!(result["coordinateSpace"], "desktopPhysicalPixels");
        let m = &result["imageToDesktop"];
        let x = 101. * m["scaleX"].as_f64().unwrap() + m["offsetX"].as_f64().unwrap();
        let y = 180. * m["scaleY"].as_f64().unwrap() + m["offsetY"].as_f64().unwrap();
        assert_eq!((x, y), (-540., 760.));
        let p = geometry().normalized(Position { x, y }).unwrap();
        assert_eq!(geometry().pixels(p), Some((-540, 760)));
    }
}
