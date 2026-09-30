use serde::{Deserialize, Serialize};

pub const MAX_MESSAGE_BYTES: usize = 4096;
pub const REQUEST_TIMEOUT_MS: u64 = 30_000;
pub const LEASE_MS: u64 = 2000;

pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// Publication ID; native capture handles never arrive over the control protocol.
    pub source_id: String,
    pub media_id: String,
    pub geometry_revision: String,
}
impl Target {
    pub fn valid(&self) -> bool {
        [&self.source_id, &self.media_id, &self.geometry_revision]
            .into_iter()
            .all(|s| valid_id(s))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DenialReason {
    Unsupported,
    Busy,
    Declined,
    Expired,
    Unavailable,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RevocationReason {
    Local,
    Disconnected,
    SourceChanged,
    Expired,
    Ended,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Signal {
    Request {
        request_id: String,
        target: Target,
    },
    Grant {
        request_id: String,
        target: Target,
        grant_id: String,
        #[serde(deserialize_with = "lease_number")]
        lease_ms: u64,
    },
    Deny {
        request_id: String,
        reason: DenialReason,
    },
    Cancel {
        request_id: String,
    },
    Revoke {
        grant_id: String,
        reason: RevocationReason,
    },
}
impl Signal {
    pub fn valid(&self) -> bool {
        match self {
            Self::Request { request_id, target } => valid_id(request_id) && target.valid(),
            Self::Grant {
                request_id,
                target,
                grant_id,
                lease_ms,
            } => {
                valid_id(request_id)
                    && target.valid()
                    && valid_id(grant_id)
                    && (500..=10_000).contains(lease_ms)
            }
            Self::Deny { request_id, .. } | Self::Cancel { request_id } => valid_id(request_id),
            Self::Revoke { grant_id, .. } => valid_id(grant_id),
        }
    }
}
pub fn parse(data: &[u8]) -> Option<Signal> {
    if data.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    // Match JSON.parse's last-value-wins semantics before validating known fields.
    let json: serde_json::Value = serde_json::from_slice(data).ok()?;
    let value: Signal = serde_json::from_value(json).ok()?;
    value.valid().then_some(value)
}

fn lease_number<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = f64::deserialize(deserializer)?;
    if !value.is_finite() || value.fract() != 0.0 || !(500.0..=10_000.0).contains(&value) {
        return Err(serde::de::Error::custom("Invalid lease duration"));
    }
    Ok(value as u64)
}
