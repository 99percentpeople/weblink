//! Sleep until authority deadlines or changes; input leases alone need renewal.
use super::*;

impl Service {
    pub(super) fn maintenance_delay(&self, epoch: &str) -> Result<Option<Duration>, String> {
        let s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        let instant = Instant::now();
        let wall = now();
        let mut wait = s
            .pending
            .values()
            .map(|p| p.deadline.saturating_duration_since(instant))
            .chain(
                s.tickets
                    .values()
                    .map(|t| t.deadline.saturating_duration_since(instant)),
            )
            .min();
        for grant in s.grants.values() {
            let expiry = grant
                .expires_at
                .into_iter()
                .chain(
                    s.registry
                        .clients
                        .get(&grant.principal.id)
                        .filter(|_| grant.principal.kind == "mcp")
                        .and_then(|client| client.expires_at),
                )
                .min();
            if let Some(at) = expiry {
                let remaining = Duration::from_millis(at.saturating_sub(wall));
                wait = Some(wait.map_or(remaining, |wait| wait.min(remaining)));
            }
        }
        // Native lease renewal/held-input cleanup and recovery of a failed
        // emergency listener are safety work, not settings/status polling.
        if !s.input_owners.is_empty() || s.native_error.is_some() {
            let safety = Duration::from_secs(1);
            wait = Some(wait.map_or(safety, |wait| wait.min(safety)));
        }
        Ok(wait)
    }
}

pub(super) fn start(app: tauri::AppHandle, service: Shared, epoch: String) {
    let mut changes = service.changes.subscribe();
    let emergency = service.state.lock().unwrap().emergency.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let app = app.clone();
            let background = service.clone();
            let generation = epoch.clone();
            let next = tauri::async_runtime::spawn_blocking(move || {
                // A late cleanup always rechecks the current page's authority.
                native::sync_input(&app, &background);
                background.maintenance_delay(&generation)
            })
            .await;
            let Ok(Ok(next)) = next else {
                break;
            };
            tokio::select! {
                result = changes.changed() => if result.is_err() { break; },
                _ = emergency.wake.notified() => {},
                _ = async {
                    match next {
                        Some(wait) => tokio::time::sleep(wait).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {},
            }
        }
    });
}
