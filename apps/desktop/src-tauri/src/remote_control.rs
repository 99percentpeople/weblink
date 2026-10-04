//! Trusted local composition: capture identity + room lifetime + attended native input.
use serde::{Deserialize, Serialize};
use std::sync::Arc;
mod binding;
mod commands;
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
#[derive(Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub pending: Option<Pending>,
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
    format!("Native input: {error:?}")
}
