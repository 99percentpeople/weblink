//! Deliver invalidation to the UI immediately, including application-side tools.
use super::*;

impl Service {
    pub(super) fn cancel_request(s: &mut State, id: &str) {
        if let Some(signal) = s.accessibility_waits.remove(id) {
            signal.cancel();
        }
        s.pending.remove(id);
        s.requests.remove(id);
        if s.tickets.remove(id).is_some() {
            if let Some(channel) = &s.channel {
                let _ = channel.send(json!({"kind":"cancel","id":id}));
            }
        }
    }
    pub(super) fn cancel_all(s: &mut State) {
        for (_, signal) in s.accessibility_waits.drain() {
            signal.cancel();
        }
        let ids: Vec<_> = s.tickets.keys().cloned().collect();
        for id in ids {
            Self::cancel_request(s, &id);
        }
        s.pending.clear();
        s.requests.clear();
    }
    pub(super) fn check_call(s: &State, epoch: &str, id: &str) -> Result<(), String> {
        Self::check(s, epoch)?;
        let t = s.tickets.get(id).ok_or("CANCELLED")?;
        if !Self::current(s)
            || !Self::call_enabled(s, &t.principal, &t.call)
            || t.deadline <= Instant::now()
            || !s.grants.get(&t.grant).is_some_and(|g| {
                Self::grant_live(s, g)
                    && g.principal.id == t.principal.id
                    && g.principal.kind == t.principal.kind
                    && g.covers_target(&t.call.arguments["target"])
                    && catalog::find(&t.call.name)
                        .is_ok_and(|tool| g.scopes.iter().any(|scope| tool["scope"] == *scope))
            })
            || (t.call.name == "control.acquire"
                && t.call.arguments.get("sourceId").is_some()
                && !t
                    .screen_grant
                    .as_ref()
                    .and_then(|id| s.grants.get(id))
                    .is_some_and(|g| {
                        Self::grant_live(s, g)
                            && g.principal.id == t.principal.id
                            && g.principal.kind == t.principal.kind
                            && g.covers_target(&t.call.arguments["target"])
                            && g.scopes.iter().any(|scope| scope == "screen.manage")
                    }))
        {
            return Err("GRANT_EXPIRED".into());
        }
        Ok(())
    }
}
