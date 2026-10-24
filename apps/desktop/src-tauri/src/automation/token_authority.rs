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
    #[cfg(test)]
    pub(super) fn token_grant(
        s: &mut State,
        principal: &Principal,
        target: &Value,
    ) -> Result<(), String> {
        Self::token_grant_for(s, principal, target, false)
    }

    pub(super) fn token_grant_for(
        s: &mut State,
        principal: &Principal,
        target: &Value,
        diagnostic: bool,
    ) -> Result<(), String> {
        if !s.mcp_enabled || principal.kind != "mcp" || !Self::principal_active(s, principal) {
            return Err("SESSION_CLOSED".into());
        }
        if s.mcp_suspended {
            return Err("PERMISSION_DENIED".into());
        }
        // Local diagnostics have an independent grant so toggles can cancel OS jobs.
        // The forwarding authority can never be used for a native local effect.
        let target = if target == "local" { "local" } else { "*" };
        let diagnostic = diagnostic && target == "local";
        if s.grants.values().any(|g| {
            g.principal.kind == "mcp"
                && g.principal.id == principal.id
                && g.target == target
                && (g.scopes.len() == 1) == diagnostic
                && Self::grant_live(s, g)
        }) {
            return Ok(());
        }
        let mut scopes: Vec<String> = catalog::tools()
            .iter()
            .map(|tool| tool["scope"].as_str().unwrap().to_string())
            .collect();
        if diagnostic {
            scopes = vec!["diagnostics.read".into()];
        }
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
                source: GrantSource::Token,
            },
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests;
