use super::super::{image::Icon, Capabilities, Notification};
pub struct Notice;
pub fn permission(_: &tauri::AppHandle) -> Result<&'static str, String> {
    Ok("unavailable")
}
pub fn capabilities(app: &tauri::AppHandle) -> Result<Capabilities, String> {
    Ok(Capabilities {
        permission: permission(app)?,
        actions: false,
        reply: false,
    })
}
pub fn show(
    _: &tauri::AppHandle,
    _: &str,
    _: &Notification,
    _: Option<&Icon>,
) -> Result<Notice, String> {
    Err("System notifications unavailable on this platform".into())
}
