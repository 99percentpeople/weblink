fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "runtime_capabilities",
            "capture_sources",
            "capture_start",
            "capture_status",
            "capture_stop",
        ]),
    ))
    .expect("could not build desktop configuration");
}
