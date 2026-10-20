use super::*;
use tauri::{Manager, State, WebviewWindow};
fn main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("PERMISSION_DENIED".into())
    }
}

// IPC handlers must not wait for authority/worker locks on the window thread.
// Native window discovery and input workers can need that thread to process messages.
async fn blocking<T: Send + 'static>(
    window: WebviewWindow,
    service: State<'_, Shared>,
    operation: impl FnOnce(tauri::AppHandle, Shared) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    main(&window)?;
    let app = window.app_handle().clone();
    let service = service.inner().clone();
    off_thread(move || operation(app, service)).await
}

async fn off_thread<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "EXECUTION_FAILED")?
}

#[tauri::command]
pub async fn automation_open(
    window: WebviewWindow,
    service: State<'_, Shared>,
    channel: Channel<Value>,
) -> Result<String, String> {
    blocking(window, service, move |app, service| {
        let _opening = service.opening.lock().unwrap();
        service.load_registry(
            app.path()
                .app_local_data_dir()
                .map_err(|_| "AUTOMATION_STORAGE_UNAVAILABLE")?
                .join("mcp-tokens.json"),
        )?;
        service.shutdown();
        native::sync_input(&app, &service);
        let epoch = {
            let mut s = service.state.lock().unwrap();
            s.epoch = uuid::Uuid::new_v4().to_string();
            s.heartbeat = Some(Instant::now());
            s.channel = Some(channel);
            s.epoch.clone()
        };
        let background = service.clone();
        let app = app.clone();
        let generation = epoch.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let app = app.clone();
                let background = background.clone();
                let generation = generation.clone();
                let current = off_thread(move || {
                    native::sync_input(&app, &background);
                    let s = background.state.lock().unwrap();
                    Ok(s.epoch == generation
                        && s.heartbeat
                            .is_some_and(|t| t.elapsed() <= Duration::from_secs(20)))
                })
                .await
                .unwrap_or(false);
                if !current {
                    break;
                }
            }
        });
        Ok(epoch)
    })
    .await
}
#[tauri::command]
pub async fn automation_heartbeat(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
) -> Result<(), String> {
    blocking(window, service, move |_app, service| {
        let mut s = service.state.lock().unwrap();
        Service::check(&s, &epoch)?;
        s.heartbeat = Some(Instant::now());
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn automation_close(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
) -> Result<(), String> {
    blocking(window, service, move |app, service| {
        service.close(&epoch)?;
        native::sync_input(&app, &service);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn automation_configure(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    enabled: bool,
) -> Result<(), String> {
    main(&window)?;
    let app = window.app_handle().clone();
    let authority = service.inner().clone();
    let generation = epoch.clone();
    let start = off_thread(move || {
        let mut s = authority.state.lock().unwrap();
        Service::check(&s, &generation)?;
        if s.enabled == enabled {
            return Ok(false);
        }
        s.enabled = enabled;
        if enabled {
            s.policies_suspended = false;
            return Ok(true);
        }
        s.endpoint.clear();
        s.active_server = None;
        s.grants.clear();
        Service::cancel_all(&mut s);
        s.peers.clear();
        s.peer_policies.clear();
        if let Some(c) = s.listener.take() {
            c.cancel();
        }
        authority.jobs.stop();
        drop(s);
        native::sync_input(&app, &authority);
        Ok(false)
    })
    .await?;
    if !start {
        return Ok(());
    }
    if let Err(error) = http::start(service.inner().clone(), epoch.clone()).await {
        let mut s = service.state.lock().unwrap();
        if s.epoch == epoch && s.listener.is_none() {
            s.enabled = false;
            s.endpoint.clear();
        }
        return Err(error);
    }
    Ok(())
}
#[tauri::command]
pub async fn automation_server_configure(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    config: server::ServerConfig,
) -> Result<(), String> {
    blocking(window, service, move |_app, service| {
        service.configure_server(&epoch, config)
    })
    .await
}
#[tauri::command]
pub async fn automation_snapshot(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
) -> Result<Value, String> {
    blocking(window, service, move |_app, service| {
    service.expire();
    let s = service.state.lock().unwrap();
    Service::check(&s, &epoch)?;
    let mut snapshot = json!({"activeCalls":s.tickets.keys().collect::<Vec<_>>(),"enabled":s.enabled,"endpoint":s.endpoint,"server":{"host":s.registry.host,"port":s.registry.port},"serverPending":server::pending(&s),"policiesSuspended":s.policies_suspended,"clients":s.registry.clients.values().map(registry::Client::summary).collect::<Vec<_>>(),"grants":s.grants.values().collect::<Vec<_>>(),"pending":s.pending.iter().map(|(id,p)|json!({"id":id,"principal":p.principal,"scope":p.scope,"tool":p.call.name,"source":p.call.source,"arguments":p.call.arguments,"expiresAt":now()+p.deadline.saturating_duration_since(Instant::now()).as_millis() as u64})).collect::<Vec<_>>(),"audit":s.audit,"jobs":service.jobs.list()});
    let active = s.active_server.clone();
    drop(s);
    snapshot["endpoints"] = json!(server::endpoints(active.as_ref()));
    Ok(snapshot)

    }).await
}
#[tauri::command]
pub async fn automation_client(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    label: String,
    expires_at: Option<u64>,
) -> Result<Value, String> {
    blocking(window, service, move |_app, service| {
        service.create_client(&epoch, label, expires_at)
    })
    .await
}
#[tauri::command]
pub async fn automation_client_update(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    id: String,
    label: String,
    expires_at: Option<u64>,
) -> Result<(), String> {
    blocking(window, service, move |app, service| {
        service.update_client(&epoch, &id, label, expires_at)?;
        native::sync_input(&app, &service);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn automation_client_remove(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    id: String,
) -> Result<(), String> {
    blocking(window, service, move |app, service| {
        service.remove_client(&epoch, &id)?;
        native::sync_input(&app, &service);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn automation_disconnect(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    principal: String,
) -> Result<(), String> {
    blocking(window, service, move |app, service| {
        let mut s = service.state.lock().unwrap();
        Service::check(&s, &epoch)?;
        s.peers.remove(&principal);
        s.peer_policies.remove(&principal);
        let ids: Vec<_> = s
            .grants
            .values()
            .filter(|g| g.principal.id == principal)
            .map(|g| g.id.clone())
            .collect();
        for id in ids {
            service.revoke_locked(&mut s, &id);
        }
        let pending: Vec<_> = s
            .pending
            .iter()
            .filter(|(_, p)| p.principal.id == principal)
            .map(|(id, _)| id.clone())
            .collect();
        for id in pending {
            Service::cancel_request(&mut s, &id);
        }
        drop(s);
        native::sync_input(&app, &service);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn automation_peer(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    label: String,
    fingerprint: String,
) -> Result<String, String> {
    blocking(window, service, move |_app, service| {
        let mut s = service.state.lock().unwrap();
        Service::check(&s, &epoch)?;
        if !s.enabled
            || s.peers.len() >= 32
            || label.len() > 128
            || fingerprint.len() != 64
            || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("INVALID_ARGUMENTS".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        s.peers.insert(
            id.clone(),
            Principal {
                id: id.clone(),
                label,
                kind: "peer".into(),
                fingerprint: Some(fingerprint),
            },
        );
        Ok(id)
    })
    .await
}
#[tauri::command]
pub async fn automation_peer_policy(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    principal: String,
    policy: policy::PeerPolicy,
) -> Result<(), String> {
    blocking(window, service, move |app, service| {
        service.set_peer_policy(&epoch, &principal, policy)?;
        native::sync_input(&app, &service);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn automation_decide(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    id: String,
    minutes: u32,
) -> Result<(), String> {
    blocking(window, service, move |_app, service| {
        service.decide(&epoch, &id, minutes)
    })
    .await
}
#[tauri::command]
pub async fn automation_revoke(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    id: Option<String>,
) -> Result<(), String> {
    blocking(window, service, move |app, service| {
        let mut s = service.state.lock().unwrap();
        Service::check(&s, &epoch)?;
        if let Some(id) = id {
            if s.grants.get(&id).is_some_and(|g| g.expires_at.is_none()) {
                service.pause_policies(&mut s);
            }
            service.revoke_locked(&mut s, &id);
        } else {
            let ids: Vec<_> = s.grants.keys().cloned().collect();
            for id in ids {
                service.revoke_locked(&mut s, &id);
            }
            Service::cancel_all(&mut s);
            s.policies_suspended = true;
            service.jobs.stop();
        }
        drop(s);
        native::sync_input(&app, &service);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn automation_call(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    principal: String,
    id: String,
    call: Call,
) -> Result<Value, String> {
    main(&window)?;
    let p = {
        let s = service.state.lock().unwrap();
        Service::check(&s, &epoch)?;
        s.peers
            .get(&principal)
            .cloned()
            .ok_or("PERMISSION_DENIED")?
    };
    if id.len() > 128 {
        return Err("INVALID_ARGUMENTS".into());
    }
    Ok(service.inner().clone().invoke(p, id, call).await)
}
#[tauri::command]
pub async fn automation_cancel(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    id: String,
) -> Result<(), String> {
    blocking(window, service, move |_app, service| {
        let mut s = service.state.lock().unwrap();
        Service::check(&s, &epoch)?;
        Service::cancel_request(&mut s, &id);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn automation_check(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    id: String,
) -> Result<(), String> {
    blocking(window, service, move |_app, service| {
        Service::check_call(&service.state.lock().unwrap(), &epoch, &id)
    })
    .await
}
#[tauri::command]
pub async fn automation_finish(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    id: String,
    result: Value,
) -> Result<(), String> {
    blocking(window, service, move |_app, service| {
        let mut s = service.state.lock().unwrap();
        Service::check(&s, &epoch)?;
        let valid = Service::check_call(&s, &epoch, &id).is_ok();
        let t = s.tickets.remove(&id).ok_or("CANCELLED")?;
        let _ = t.answer.send(if valid {
            result
        } else {
            error("GRANT_EXPIRED")
        });
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn automation_action(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    id: String,
    binding: Option<HashMap<String, String>>,
) -> Result<Value, String> {
    main(&window)?;
    native::action(
        window.app_handle().clone(),
        service.inner().clone(),
        epoch,
        id,
        binding.unwrap_or_default(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn management_waits_do_not_block_the_dispatch_runtime() {
        let (resume, waiting) = std::sync::mpsc::channel();
        let dispatch_thread = std::thread::current().id();
        let operation = off_thread(move || {
            assert_ne!(std::thread::current().id(), dispatch_thread);
            waiting
                .recv_timeout(Duration::from_secs(3))
                .map_err(|_| "Dispatch thread was blocked".to_string())
        });
        let dispatch = async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            resume.send(()).unwrap();
        };
        let (result, _) = tokio::join!(operation, dispatch);
        result.unwrap();
    }

    #[test]
    fn an_old_close_cannot_clear_the_replacement_authority() {
        let service = Service::default();
        {
            let mut s = service.state.lock().unwrap();
            s.epoch = "replacement".into();
            s.heartbeat = Some(Instant::now());
            s.enabled = true;
        }
        assert_eq!(service.close("old").unwrap_err(), "SESSION_CLOSED");
        assert!(service.state.lock().unwrap().enabled);
        service.close("replacement").unwrap();
        assert!(!service.state.lock().unwrap().enabled);
    }
}
