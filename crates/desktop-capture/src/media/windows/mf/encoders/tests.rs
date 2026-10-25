use super::*;
use std::cell::RefCell;
use windows::Win32::Foundation::LUID;

fn adapter(low: u32, name: &str) -> Adapter {
    Adapter {
        luid: LUID {
            LowPart: low,
            HighPart: -2,
        },
        name: name.into(),
    }
}
fn candidate(id: &str, adapter: Option<&Adapter>) -> Candidate<String> {
    Candidate {
        info: EncoderInfo {
            id: id.into(),
            name: id.into(),
            hardware: true,
            codecs: vec![Codec::from_id(id).mime().into()],
            presets: Vec::new(),
        },
        adapter: adapter.cloned(),
        activation: id.into(),
    }
}
fn open(candidate: &Candidate<String>) -> Result<String> {
    Ok(candidate.activation.clone())
}

#[test]
#[ignore = "requires installed hardware encoder drivers"]
fn advertised_presets_initialize_and_report_the_effective_intent() {
    let _runtime = Runtime::new().unwrap();
    let detected = detect().unwrap();
    assert!(
        !detected.is_empty(),
        "No hardware MFT available on this machine"
    );
    for info in detected {
        println!("{} {}: {:?}", info.name, info.id, info.presets);
        for preset in EncodingPreset::ALL {
            let mut selection = Selection::new(info.id.clone(), false);
            selection.set_preset(preset);
            let encoder = selection
                .open(
                    320,
                    180,
                    30,
                    1_000_000,
                    1_000_000,
                    MediaOptions::default().color_space(),
                    Arc::new(|| {}),
                    None,
                )
                .unwrap();
            let controls = encoder.control_status();
            let effective = controls
                .iter()
                .find(|c| c.name == "encodingPreset")
                .unwrap();
            assert_eq!(effective.requested, preset.code());
            if info.presets.contains(&preset) {
                assert!(effective.accepted);
                assert_eq!(effective.actual, Some(preset.code()));
            } else {
                assert!(!effective.accepted);
                assert_eq!(effective.actual, Some(EncodingPreset::Balanced.code()));
                assert!(effective
                    .error
                    .as_ref()
                    .is_some_and(|e| e.contains("Using balanced")));
            }
        }
    }
}

#[test]
fn automatic_selection_prefers_capture_gpu_for_both_codecs() {
    for (name, id, requested) in [
        ("Intel", "mf:intel", "mf:nvidia"),
        ("AMD", "mf:amd:h265", "mf:nvidia:h265"),
    ] {
        let capture = adapter(2, name);
        let mut selection = Selection::new(requested.into(), true);
        selection.set_capture(Some(capture.clone()), None);
        let actual = selection
            .try_open(
                true,
                |codec, scope| {
                    assert_eq!(codec, Codec::from_id(requested));
                    assert!(
                        scope.unwrap().matches(&capture),
                        "legacy enumeration preceded matching capture GPU"
                    );
                    Ok(vec![candidate(id, scope)])
                },
                open,
            )
            .unwrap();
        assert_eq!(actual, id);
        let report = selection.report.unwrap();
        assert_eq!(report.requested, requested);
        assert!(report.adapter_matched);
        assert_eq!(report.capture_adapter, report.encoder_adapter);
        assert!(report.fallback.is_none());
    }
}

#[test]
fn same_transform_id_on_two_adapters_uses_the_capture_activation() {
    let capture = adapter(2, "Intel secondary");
    let primary = adapter(1, "Intel primary");
    let mut selection = Selection::new("mf:intel".into(), false);
    selection.set_capture(Some(capture.clone()), None);
    let chosen = selection
        .try_open(
            true,
            |_, scope| Ok(vec![candidate("mf:intel", Some(scope.unwrap_or(&primary)))]),
            |candidate| Ok(candidate.adapter.as_ref().unwrap().label()),
        )
        .unwrap();
    assert_eq!(chosen, capture.label());
    assert!(selection.report.unwrap().adapter_matched);
}

#[test]
fn failed_matching_candidate_tries_the_next_without_changing_codec() {
    let capture = adapter(2, "AMD");
    let mut selection = Selection::new("mf:original:h265".into(), true);
    selection.set_capture(Some(capture), None);
    let attempted = RefCell::new(Vec::new());
    let chosen = selection
        .try_open(
            true,
            |_, scope| {
                assert!(scope.is_some());
                Ok(vec![
                    candidate("mf:wrong-codec", scope),
                    candidate("mf:broken:h265", scope),
                    candidate("mf:working:h265", scope),
                ])
            },
            |candidate| {
                attempted.borrow_mut().push(candidate.info.id.clone());
                if candidate.info.id == "mf:broken:h265" {
                    Err("driver initialization rejected".into())
                } else {
                    open(candidate)
                }
            },
        )
        .unwrap();
    assert_eq!(chosen, "mf:working:h265");
    assert_eq!(*attempted.borrow(), ["mf:broken:h265", "mf:working:h265"]);
}

#[test]
fn explicit_other_gpu_is_not_replaced_or_given_cross_adapter_textures() {
    let capture = adapter(2, "Intel");
    let chosen_gpu = adapter(1, "NVIDIA");
    let mut selection = Selection::new("mf:nvidia".into(), false);
    selection.set_capture(Some(capture), None);
    let enumerate = |_, scope: Option<&Adapter>| {
        Ok(if scope.is_some() {
            vec![candidate("mf:intel", scope)]
        } else {
            vec![candidate("mf:nvidia", Some(&chosen_gpu))]
        })
    };
    assert!(selection
        .try_open(true, enumerate, |_| -> Result<()> {
            panic!("wrong GPU was given a texture")
        })
        .is_err());
    assert_eq!(
        selection.try_open(false, enumerate, open).unwrap(),
        "mf:nvidia"
    );
    let report = selection.report.unwrap();
    assert!(!report.adapter_matched);
    assert!(report.fallback.is_some());
}

#[test]
fn unavailable_adapter_enumeration_preserves_legacy_path() {
    let mut selection = Selection::new("mf:legacy".into(), true);
    selection.set_capture(Some(adapter(2, "Intel")), None);
    assert_eq!(
        selection
            .try_open(
                true,
                |_, scope| {
                    if scope.is_some() {
                        Err("MFTEnum2 unavailable".into())
                    } else {
                        Ok(vec![
                            candidate("mf:other", None),
                            candidate("mf:legacy", None),
                        ])
                    }
                },
                open
            )
            .unwrap(),
        "mf:legacy"
    );
    let report = selection.report.unwrap();
    assert!(!report.adapter_matched);
    assert!(report.fallback.unwrap().contains("MFTEnum2 unavailable"));
}

#[test]
fn empty_matching_list_preserves_legacy_encoder_and_records_reason() {
    let mut selection = Selection::new("mf:legacy".into(), true);
    selection.set_capture(Some(adapter(2, "AMD")), None);
    assert_eq!(
        selection
            .try_open(
                true,
                |_, scope| {
                    Ok(if scope.is_some() {
                        vec![]
                    } else {
                        vec![candidate("mf:legacy", None)]
                    })
                },
                open
            )
            .unwrap(),
        "mf:legacy"
    );
    assert!(selection
        .report
        .unwrap()
        .fallback
        .unwrap()
        .contains("capture adapter"));
}

#[test]
fn unknown_capture_adapter_preserves_legacy_encoder() {
    let mut selection = Selection::new("mf:legacy".into(), true);
    selection.set_capture(None, Some("DXGI adapter unavailable".into()));
    assert_eq!(
        selection
            .try_open(
                true,
                |_, scope| {
                    assert!(scope.is_none());
                    Ok(vec![candidate("mf:legacy", None)])
                },
                open
            )
            .unwrap(),
        "mf:legacy"
    );
    assert_eq!(
        selection.report.unwrap().fallback.as_deref(),
        Some("DXGI adapter unavailable")
    );
}

#[test]
fn memory_fallback_reopens_actual_encoder_on_the_same_capture_adapter() {
    let mut selection = Selection::new("mf:legacy".into(), true);
    let capture = adapter(2, "Intel");
    selection.set_capture(Some(capture.clone()), None);
    assert_eq!(
        selection
            .try_open(
                true,
                |_, scope| Ok(vec![candidate("mf:active", scope)]),
                open
            )
            .unwrap(),
        "mf:active"
    );
    assert_eq!(
        selection
            .try_open(
                false,
                |_, scope| {
                    assert!(scope.unwrap().matches(&capture));
                    Ok(vec![
                        candidate("mf:new-first-entry", scope),
                        candidate("mf:active", scope),
                    ])
                },
                open
            )
            .unwrap(),
        "mf:active"
    );
    assert!(selection.report.unwrap().adapter_matched);
}

#[test]
fn capture_adapter_change_discards_the_previous_encoder_preference() {
    let mut selection = Selection::new("mf:legacy".into(), true);
    selection.set_capture(Some(adapter(1, "GPU A")), None);
    selection
        .try_open(true, |_, scope| Ok(vec![candidate("mf:old", scope)]), open)
        .unwrap();
    selection.set_capture(Some(adapter(2, "GPU B")), None);
    assert!(selection.report.is_none());
    assert_eq!(
        selection
            .try_open(
                true,
                |_, scope| {
                    assert_eq!(scope.unwrap().luid.LowPart, 2);
                    Ok(vec![
                        candidate("mf:old", scope),
                        candidate("mf:legacy", scope),
                    ])
                },
                open
            )
            .unwrap(),
        "mf:legacy"
    );
}

#[test]
fn all_failures_are_bounded_and_explain_matching_and_legacy_errors() {
    let mut selection = Selection::new("mf:legacy".into(), true);
    selection.set_capture(Some(adapter(2, "AMD")), None);
    let mut attempts = 0;
    let error = selection
        .try_open(
            true,
            |_, scope| {
                Ok(vec![candidate(
                    if scope.is_some() {
                        "mf:matching"
                    } else {
                        "mf:legacy"
                    },
                    scope,
                )])
            },
            |_| -> Result<()> {
                attempts += 1;
                Err("unsupported NV12".into())
            },
        )
        .unwrap_err();
    assert_eq!(attempts, 2);
    assert!(error.contains("mf:matching"));
    assert!(error.contains("mf:legacy"));
    assert!(error.contains("unsupported NV12"));
    assert!(selection.report.is_none());
}

#[test]
fn secondary_gpu_is_discovered_when_the_legacy_catalog_has_no_codec() {
    let primary = adapter(1, "GPU A");
    let secondary = adapter(2, "GPU B");
    for legacy_failed in [false, true] {
        let candidates = catalog_with(
            Codec::Hevc,
            &[primary.clone(), secondary.clone()],
            |codec, scope| {
                assert_eq!(codec, Codec::Hevc);
                match scope {
                    None if legacy_failed => Err("legacy enumeration unavailable".into()),
                    Some(adapter) if adapter.matches(&secondary) => {
                        Ok(vec![candidate("mf:secondary:h265", scope)])
                    }
                    _ => Ok(vec![]),
                }
            },
        )
        .unwrap();
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0].adapter.as_ref().unwrap().matches(&secondary));
    }
}

#[test]
fn adapter_attribute_uses_luid_blob_with_signed_high_part() {
    let _runtime = Runtime::new().unwrap();
    let adapter = adapter(0x12345678, "test");
    let attributes = adapter.attributes().unwrap();
    let mut data = [0; 8];
    unsafe {
        attributes
            .GetBlob(&MFT_ENUM_ADAPTER_LUID, &mut data, None)
            .unwrap();
    }
    assert_eq!(data, [0x78, 0x56, 0x34, 0x12, 0xfe, 0xff, 0xff, 0xff]);
    assert_eq!(adapter.label(), "test [fffffffe:12345678]");
}
