//! Independent local automation authority and MCP API lifetime.
use super::*;

#[cfg(test)]
mod tests;

impl Service {
    pub(super) fn call_enabled(s: &State, principal: &Principal, call: &Call) -> bool {
        if s.native_error.is_some() && !catalog::diagnostic(&call.name) {
            return false;
        }
        match principal.kind.as_str() {
            "peer" => s.enabled || catalog::diagnostic(&call.name),
            // Device discovery is needed to address remote targets even when this
            // machine does not accept automation. It grants no native operations.
            "mcp" => {
                s.mcp_enabled
                    && (s.enabled
                        || call.arguments["target"] != "local"
                        || call.name == "devices.list"
                        || catalog::diagnostic(&call.name))
            }
            _ => false,
        }
    }

    pub(super) fn configure_locked(&self, s: &mut State, mcp: bool, enabled: bool) {
        if mcp {
            s.mcp_enabled = enabled;
            if enabled {
                s.mcp_suspended = false;
            } else {
                if let Some(cancel) = s.listener.take() {
                    cancel.cancel();
                }
                s.endpoint.clear();
                s.active_server = None;
            }
        } else {
            s.enabled = enabled;
        }
        if enabled {
            return;
        }
        let grants: Vec<_> = s
            .grants
            .values()
            .filter(|g| {
                if mcp {
                    g.principal.kind == "mcp"
                } else {
                    g.target == "local" && !Self::diagnostic_grant(g)
                }
            })
            .map(|g| g.id.clone())
            .collect();
        for id in grants {
            self.revoke_locked(s, &id);
        }
        // Include requests that have not reached approval or dispatch yet.
        let requests: Vec<_> = s
            .requests
            .iter()
            .filter(|(_, r)| if mcp { r.mcp } else { r.local && !r.diagnostic })
            .map(|(id, _)| id.clone())
            .collect();
        for id in requests {
            Self::cancel_request(s, &id);
        }
        // Diagnostics retain their authority and requests across automation toggles.
    }

    pub(super) fn diagnostic_grant(g: &Grant) -> bool {
        g.scopes.iter().any(|scope| scope == "diagnostics.read")
            && (g.principal.kind == "peer" || g.scopes.len() == 1)
    }
}
