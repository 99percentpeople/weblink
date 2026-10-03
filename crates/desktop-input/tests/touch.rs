use weblink_desktop_input::{
    input::{Geometry, Rect},
    touch::{valid_frame, Contact, Contacts, Phase},
    wire,
};

fn contact() -> Contact {
    Contact {
        id: 1,
        x: 0.5,
        y: 0.5,
        phase: Phase::Down,
        pressure: Some(0.25),
        width: Some(0.02),
        height: Some(0.05),
    }
}
fn geometry() -> Geometry {
    let display = Rect {
        left: -1000,
        top: 200,
        width: 1000,
        height: 600,
    };
    Geometry {
        display,
        desktop: display,
    }
}

#[test]
fn touch_properties_map_to_physical_pixels_and_native_pressure() {
    let action = Contacts::default().frame(&[contact()], geometry()).unwrap()[0];
    assert_eq!((action.x, action.y), (-500, 500));
    assert_eq!(action.pressure, Some(256));
    assert_eq!(
        action.contact,
        Some(Rect {
            left: -510,
            top: 485,
            width: 20,
            height: 30
        })
    );
    for (pressure, expected) in [(0.0, 0), (0.5, 512), (1.0, 1024)] {
        let c = Contact {
            pressure: Some(pressure),
            ..contact()
        };
        assert_eq!(
            Contacts::default().frame(&[c], geometry()).unwrap()[0].pressure,
            Some(expected)
        );
    }
}

#[test]
fn touch_contact_area_is_bounded_at_display_edges_and_preserves_subpixel_contacts() {
    for position in [0.0, 1.0] {
        for size in [0.00001, 0.2, 1.0] {
            let c = Contact {
                x: position,
                y: position,
                width: Some(size),
                height: Some(size),
                ..contact()
            };
            let area = Contacts::default().frame(&[c], geometry()).unwrap()[0]
                .contact
                .unwrap();
            assert!(geometry().display.contains(area));
        }
    }
}

#[test]
fn touch_properties_are_optional_and_invalid_values_are_rejected() {
    let legacy: Contact =
        serde_json::from_str(r#"{"id":1,"x":0.5,"y":0.5,"phase":"down"}"#).unwrap();
    assert!(valid_frame(&[legacy]));
    let action = Contacts::default().frame(&[legacy], geometry()).unwrap()[0];
    assert_eq!(action.pressure, None);
    assert_eq!(action.contact, None);
    for c in [
        Contact {
            pressure: Some(f64::NAN),
            ..contact()
        },
        Contact {
            pressure: Some(-0.1),
            ..contact()
        },
        Contact {
            pressure: Some(1.01),
            ..contact()
        },
        Contact {
            width: None,
            ..contact()
        },
        Contact {
            height: None,
            ..contact()
        },
        Contact {
            width: Some(0.0),
            ..contact()
        },
        Contact {
            width: Some(f64::INFINITY),
            ..contact()
        },
        Contact {
            height: Some(1.01),
            ..contact()
        },
    ] {
        assert!(!valid_frame(&[c]));
        assert!(Contacts::default().frame(&[c], geometry()).is_err());
    }
}

#[test]
fn touch_wire_accepts_additive_properties_and_validates_before_injection() {
    let mut packet = serde_json::json!({"type":"input", "grantId":"grant", "generation":"media", "geometryRevision":"layout", "inputEpoch":"epoch", "activationSequence":1, "sequence":2, "event":{"type":"touch", "contacts":[{"id":1,"x":0.5,"y":0.5,"phase":"down", "pressure":0.25,"width":0.02,"height":0.05}]}});
    let parsed = wire::parse(&serde_json::to_vec(&packet).unwrap()).unwrap();
    match parsed.event {
        wire::PointerEvent::Touch { contacts } => assert_eq!(contacts, vec![contact()]),
        _ => panic!("expected touch input"),
    }
    packet["event"]["contacts"][0]["pressure"] = serde_json::json!(2);
    assert!(wire::parse(&serde_json::to_vec(&packet).unwrap()).is_none());
    packet["event"]["contacts"][0]["pressure"] = serde_json::json!(0.5);
    packet["event"]["contacts"][0]
        .as_object_mut()
        .unwrap()
        .remove("height");
    assert!(wire::parse(&serde_json::to_vec(&packet).unwrap()).is_none());
}
