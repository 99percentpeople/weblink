//! Issuing a local MCP token authorizes calls without a second local consent.
//! Forwarded calls still require the destination's independent peer permission.
use super::*;

impl Grant {
    pub(super) fn covers_target(&self, target: &Value) -> bool {
        target.as_str() == Some(self.target.as_str())
            || (self.principal.kind == "mcp"
                && self.target == "*"
                && target.as_str().is_some_and(|value| value != "local"))
    }
}

impl Service {
    pub(super) fn token_grant(
        s: &mut State,
        principal: &Principal,
        target: &Value,
    ) -> Result<(), String> {
        if principal.kind != "mcp" || !Self::principal_active(s, principal) {
            return Err("SESSION_CLOSED".into());
        }
        if s.policies_suspended {
            return Err("PERMISSION_DENIED".into());
        }
        // Keep at most two authorities per token, regardless of requested peer IDs.
        // The forwarding authority can never be used for a native local effect.
        let target = if target == "local" { "local" } else { "*" };
        if s.grants.values().any(|g| {
            g.principal.kind == "mcp"
                && g.principal.id == principal.id
                && g.target == target
                && Self::grant_live(s, g)
        }) {
            return Ok(());
        }
        let mut scopes: Vec<String> = catalog::tools()
            .iter()
            .map(|tool| tool["scope"].as_str().unwrap().to_string())
            .collect();
        scopes.sort();
        scopes.dedup();
        let id = uuid::Uuid::new_v4().to_string();
        s.grants.insert(
            id.clone(),
            Grant {
                id,
                principal: principal.clone(),
                target: target.into(),
                scopes,
                // Validity follows the registry, including later expiry edits.
                expires_at: None,
            },
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests;
