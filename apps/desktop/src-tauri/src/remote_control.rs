//! Trusted local composition: capture identity + room lifetime + attended native input.
use serde::{Deserialize, Serialize};
use std::sync::Arc;
mod automation;
mod binding;
mod commands;
mod cursor;
mod host;
mod service;
mod text_focus;
mod transport;
pub use commands::*;
pub use service::Service;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    pub owner_id: String,
    pub peer_generation: String,
    #[serde(default)]
    pub connection_generation: Option<String>,
    pub client_id: String,
    pub source_id: String,
}
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub consent_id: String,
    pub client_id: String,
    pub source_id: String,
    pub peer_generation: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ControllerKind {
    Remote,
    Automation,
}
#[derive(Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub controller_kind: Option<ControllerKind>,
    pub source_id: Option<String>,
    pub devices: weblink_desktop_input::devices::Snapshot,
    pub grant_id: Option<String>,
    pub pending: Vec<Pending>,
    pub client_id: Option<String>,
    pub closed: bool,
}
pub enum ControlEvent {
    Granted(String),
    Ended,
}
pub type Observer = Arc<dyn Fn(ControlEvent) + Send + Sync>;
pub type Shared = Arc<Service>;

fn input_error(error: weblink_desktop_input::input::Error) -> String {
    use weblink_desktop_input::input::Error;
    match error {
        Error::WindowUnavailable => "WINDOW_UNAVAILABLE".into(),
        Error::WindowFocusLost => "WINDOW_FOCUS_LOST".into(),
        Error::WindowPointOutside => "WINDOW_POINT_OUTSIDE".into(),
        _ => format!("Native input: {error:?}"),
    }
}
