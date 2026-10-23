//! Independent local automation authority and MCP API lifetime.
use super::*;

#[cfg(test)]
mod tests;

impl Service {
    pub(super) fn call_enabled(s: &State, principal: &Principal, call: &Call) -> bool {
        match principal.kind.as_str() {
            "peer" => s.enabled,
            // Device discovery is needed to address remote targets even when this
            // machine does not accept automation. It grants no native operations.
            "mcp" => {
                s.mcp_enabled
                    && (s.enabled
                        || call.arguments["target"] != "local"
                        || call.name == "devices.list")
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
            if enabled {
                s.policies_suspended = false;
            }
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
                    g.target == "local"
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
            .filter(|(_, r)| if mcp { r.mcp } else { r.local })
            .map(|(id, _)| id.clone())
            .collect();
        for id in requests {
            Self::cancel_request(s, &id);
        }
        // Keep peer identities and policies while forwarding uses the same links.
        // No local call can use them until local automation is enabled again.
    }
}
