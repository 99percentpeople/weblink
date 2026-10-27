use crate::Action;
use serde::Serialize;

/// Implementation support, independent of current consent and provider availability.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub supported: bool,
    pub backend: Option<&'static str>,
    pub actions: &'static [Action],
    #[serde(flatten)]
    pub features: Option<Features>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    pub supports_wait: bool,
    pub supports_observation: bool,
    pub supports_window_binding: bool,
    pub max_nodes: usize,
    pub max_depth: usize,
    pub reference_ttl_ms: u64,
    pub coordinate_space: &'static str,
    pub max_text_length: usize,
}
impl Features {
    /// Limits enforced by the shared session, regardless of native backend.
    pub const fn new(wait: bool, observation: bool, window_binding: bool) -> Self {
        Self {
            supports_wait: wait,
            supports_observation: observation,
            supports_window_binding: window_binding,
            max_nodes: 256,
            max_depth: 8,
            reference_ttl_ms: 60_000,
            coordinate_space: "desktopPhysicalPixels",
            max_text_length: 4096,
        }
    }
}
impl Capabilities {
    pub const UNSUPPORTED: Self = Self {
        supported: false,
        backend: None,
        actions: &[],
        features: None,
    };
}

/// The same backend descriptor feeds desktop discovery and the MCP capability result.
pub fn capabilities() -> Capabilities {
    crate::platform::capabilities()
}
