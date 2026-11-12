//! Change notifications are coalesced natively; idle pages never poll status.
use super::*;
use tauri::Manager;
use tokio::sync::watch;

#[cfg(test)]
mod tests;

pub(super) struct Changes(watch::Sender<u64>);
impl Default for Changes {
    fn default() -> Self {
        Self(watch::channel(0).0)
    }
}
impl Changes {
    pub fn notify(&self) {
        self.0.send_modify(|revision| *revision += 1);
    }
    pub fn revision(&self) -> u64 {
        *self.0.borrow()
    }
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.0.subscribe()
    }
}

impl Service {
    pub fn status_observer(&self) -> Arc<dyn Fn() + Send + Sync> {
        let changes = self.changes.clone();
        Arc::new(move || changes.notify())
    }
    pub(super) fn status_snapshot(
        &self,
        epoch: &str,
        control: &crate::remote_control::Service,
        include_clients: bool,
    ) -> Result<Value, String> {
        let s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        // Stamp before reading jobs: a concurrent process transition then gets
        // a later revision and its own notification, never an older stamp.
        let revision = self.changes.revision();
        let mut snapshot = json!({
            "revision": revision,
            "activeCalls": s.tickets.keys().collect::<Vec<_>>(),
            "enabled": s.enabled, "mcpEnabled": s.mcp_enabled,
            "endpoint": s.endpoint,
            "server": {"host": s.registry.host, "port": s.registry.port},
            "serverPending": server::pending(&s),
            "mcpSuspended": s.mcp_enabled && s.mcp_suspended,
            "policyGeneration": s.policy_generation, "nativeError": s.native_error,
            "grants": s.grants.values().filter(|g| g.principal.kind == "peer").collect::<Vec<_>>(),
            "pending": s.pending.iter().map(|(id,p)| json!({
                "id": id, "principal": p.principal, "scope": p.scope,
                "tool": p.call.name, "source": p.call.source, "arguments": p.call.arguments,
                "expiresAt": now() + p.deadline.saturating_duration_since(Instant::now()).as_millis() as u64
            })).collect::<Vec<_>>(),
            "audit": s.audit, "jobs": self.jobs.list(),
            "screenGrants": native::screen_grants(&s, None),
        });
        if include_clients {
            snapshot["clients"] = json!(s
                .registry
                .clients
                .values()
                .map(registry::Client::summary)
                .collect::<Vec<_>>());
        }
        let controller = native::controller(&s, control);
        snapshot["controlLeaseId"] = json!(controller
            .as_ref()
            .and_then(|p| control.automation_lease(&p.id).ok()));
        snapshot["controller"] = json!(controller);
        let active = s.active_server.clone();
        drop(s);
        snapshot["endpoints"] = json!(server::endpoints(active.as_ref()));
        Ok(snapshot)
    }
}

pub(super) fn start(app: tauri::AppHandle, service: Shared, epoch: String) {
    let mut changes = service.changes.subscribe();
    let cancel = CancellationToken::new();
    {
        let mut s = service.state.lock().unwrap();
        if Service::check(&s, &epoch).is_err() {
            return;
        }
        if let Some(previous) = s.status_stop.replace(cancel.clone()) {
            previous.cancel();
        }
    }
    network::start(service.clone(), cancel.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                result = changes.changed() => if result.is_err() { break; },
            }
            let app = app.clone();
            let service = service.clone();
            let epoch = epoch.clone();
            let delivered = tauri::async_runtime::spawn_blocking(move || {
                let snapshot = service.status_snapshot(
                    &epoch,
                    &app.state::<crate::remote_control::Shared>(),
                    false,
                )?;
                let s = service.state.lock().unwrap();
                Service::check(&s, &epoch)?;
                s.channel
                    .as_ref()
                    .ok_or("SESSION_CLOSED")?
                    .send(json!({"kind": "status", "epoch": epoch, "snapshot": snapshot}))
                    .map_err(|_| "APP_NOT_READY".to_string())
            })
            .await;
            if !matches!(delivered, Ok(Ok(()))) {
                cancel.cancel();
                break;
            }
        }
    });
}
