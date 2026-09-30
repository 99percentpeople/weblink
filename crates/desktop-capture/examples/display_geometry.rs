//! Read-only physical display inventory; never opens a capture or injects input.
fn main() -> Result<(), String> {
    let capture = weblink_desktop_capture::CaptureService::new().map_err(|e| e.to_string())?;
    let first = capture.display_layout()?;
    let second = capture.display_layout()?;
    if first != second {
        return Err("Display layout changed between inventory checks".into());
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&first).map_err(|e| e.to_string())?
    );
    capture.shutdown();
    Ok(())
}
