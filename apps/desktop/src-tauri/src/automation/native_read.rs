//! Native discovery/capture can call back into the window thread. Never wait for
//! it under the authority lock, and never return data after that authority ends.
use super::*;
use weblink_desktop_capture::CaptureService;

fn screenshot_options(
    args: &Value,
) -> Result<weblink_desktop_capture::snapshot::SnapshotOptions, String> {
    let fields = ["maxWidth", "maxHeight", "rect"]
        .into_iter()
        .filter_map(|key| args.get(key).map(|value| (key.to_owned(), value.clone())))
        .collect::<serde_json::Map<_, _>>();
    let options: weblink_desktop_capture::snapshot::SnapshotOptions =
        serde_json::from_value(Value::Object(fields)).map_err(|_| "INVALID_ARGUMENTS")?;
    options.validate()?;
    Ok(options)
}

pub(super) fn handles(name: &str) -> bool {
    matches!(name, "screen.sources" | "control.screenshot")
}

fn read(
    service: &Service,
    epoch: &str,
    id: &str,
    operation: impl FnOnce(&Call) -> Result<Value, String>,
) -> Result<Value, String> {
    // A cancelled caller cannot accumulate more workers behind a stuck provider.
    // Keep this guard until the native operation actually returns.
    let _slot = service.native_read.try_lock().map_err(|_| "BUSY")?;
    let (call, generation) = {
        let mut s = service.state.lock().unwrap();
        Service::check_call(&s, epoch, id)?;
        let generation = s
            .requests
            .get(id)
            .map(|r| r.generation.clone())
            .ok_or("CANCELLED")?;
        let ticket = s.tickets.get_mut(id).ok_or("CANCELLED")?;
        if ticket.used {
            return Err("CANCELLED".into());
        }
        if !handles(&ticket.call.name) || ticket.call.arguments["target"] != "local" {
            return Err("INVALID_TARGET".into());
        }
        ticket.used = true;
        (ticket.call.clone(), generation)
    };
    let result = operation(&call);
    let s = service.state.lock().unwrap();
    if s.requests.get(id).map(|r| &r.generation) != Some(&generation) {
        return Err("CANCELLED".into());
    }
    Service::check_call(&s, epoch, id)?;
    result
}

pub(super) async fn action(
    capture: Arc<CaptureService>,
    service: Shared,
    epoch: String,
    id: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read(&service, &epoch, &id, |call| match call.name.as_str() {
            "screen.sources" => {
                let sources = capture.sources()?;
                // Preserve discovery on platforms without native geometry support.
                match capture.display_layout() {
                    Ok(layout) => Ok(json!({
                        "sources": sources,
                        "coordinateSpace": "desktopPhysicalPixels",
                        "geometryRevision": layout.revision,
                        "virtualBounds": layout.virtual_bounds,
                        "displays": layout.displays,
                    })),
                    Err(_) => Ok(json!({"sources": sources})),
                }
            }
            "control.screenshot" => {
                let source = call.arguments["sourceId"]
                    .as_str()
                    .ok_or("INVALID_ARGUMENTS")?;
                super::coordinates::screenshot(
                    source,
                    capture.snapshot_with_options(
                        source.into(),
                        screenshot_options(&call.arguments)?,
                    )?,
                )
            }
            _ => Err("UNSUPPORTED".into()),
        })
    })
    .await
    .map_err(|_| "EXECUTION_FAILED")?
}

#[cfg(test)]
mod tests;
