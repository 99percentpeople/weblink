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
    registry: Option<registry::Registry>,
) -> Result<Value, String> {
    // Capture before dispatch: a queued open from an unloaded page cannot revive it.
    let page = service.page.lock().unwrap().clone();
    blocking(window, service, move |app, service| {
        let _opening = service.opening.lock().unwrap();
        if !page.live() {
            return Err("SESSION_CLOSED".into());
        }
        let registry = registry.unwrap_or_default();
        registry::validate(&registry)?;
        service.shutdown();
        native::sync_input(&app, &service);
        let epoch = {
            let mut s = service.state.lock().unwrap();
            if !page.live() {
                return Err("SESSION_CLOSED".into());
            }
            s.epoch = uuid::Uuid::new_v4().to_string();
            s.page = page;
            s.channel = Some(channel);
            s.registry = registry.clone();
            s.registry_revision = 0;
            s.epoch.clone()
        };
        status::start(app.clone(), service.clone(), epoch.clone());
        maintenance::start(app, service.clone(), epoch.clone());
        Ok(json!({"epoch":epoch,"registry":registry}))
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
    configure(window, service, epoch, false, enabled).await
}
#[tauri::command]
pub async fn automation_mcp_configure(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    enabled: bool,
) -> Result<(), String> {
    configure(window, service, epoch, true, enabled).await
}
async fn configure(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    mcp: bool,
    enabled: bool,
) -> Result<(), String> {
    main(&window)?;
    let app = window.app_handle().clone();
    let authority = service.inner().clone();
    let generation = epoch.clone();
    let start = off_thread(move || {
        let mut s = authority.state.lock().unwrap();
        Service::check(&s, &generation)?;
        authority.consume_emergency(&mut s);
        if (if mcp { s.mcp_enabled } else { s.enabled }) == enabled {
            return Ok(false);
        }
        let active = enabled || if mcp { s.enabled } else { s.mcp_enabled };
        app.state::<crate::remote_control::Shared>()
            .automation_listener(active)?;
        authority.configure_locked(&mut s, mcp, enabled);
        drop(s);
        native::sync_input(&app, &authority);
        Ok(mcp && enabled)
    })
    .await?;
    if start {
        if let Err(error) = http::start(service.inner().clone(), epoch.clone()).await {
            let app = window.app_handle().clone();
            let authority = service.inner().clone();
            off_thread(move || {
                let mut s = authority.state.lock().unwrap();
                if s.epoch == epoch && s.listener.is_none() {
                    authority.configure_locked(&mut s, true, false);
                }
                drop(s);
                native::sync_input(&app, &authority);
                Ok(())
            })
            .await?;
            return Err(error);
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn automation_server_configure(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    config: server::ServerConfig,
) -> Result<registry::Prepared, String> {
    blocking(window, service, move |_app, service| {
        service.prepare_registry(&epoch, registry::Change::Server(config))
    })
    .await
}
#[tauri::command]
pub async fn automation_snapshot(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    include_clients: Option<bool>,
) -> Result<Value, String> {
    blocking(window, service, move |app, service| {
        service.expire();
        service.status_snapshot(
            &epoch,
            &app.state::<crate::remote_control::Shared>(),
            include_clients.unwrap_or(true),
        )
    })
    .await
}
#[tauri::command]
pub async fn automation_client(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    label: String,
    expires_at: Option<u64>,
) -> Result<registry::Prepared, String> {
    blocking(window, service, move |_app, service| {
        service.prepare_registry(&epoch, registry::Change::Create { label, expires_at })
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
) -> Result<registry::Prepared, String> {
    blocking(window, service, move |_app, service| {
        service.prepare_registry(
            &epoch,
            registry::Change::Update {
                id,
                label,
                expires_at,
            },
        )
    })
    .await
}
#[tauri::command]
pub async fn automation_client_remove(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    id: String,
) -> Result<registry::Prepared, String> {
    blocking(window, service, move |_app, service| {
        service.prepare_registry(&epoch, registry::Change::Remove { id })
    })
    .await
}
#[tauri::command]
pub async fn automation_registry_apply(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    revision: u64,
    registry: registry::Registry,
) -> Result<(), String> {
    blocking(window, service, move |app, service| {
        service.apply_registry(&epoch, revision, registry)?;
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
    principal: peers::Identity,
) -> Result<(), String> {
    blocking(window, service, move |app, service| {
        service.disconnect_peer(&epoch, &principal)?;
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
    principal: peers::Identity,
    label: String,
) -> Result<(), String> {
    blocking(window, service, move |app, service| {
        service.connect_peer(&epoch, principal, label)?;
        native::sync_input(&app, &service);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn automation_peer_policy(
    window: WebviewWindow,
    service: State<'_, Shared>,
    epoch: String,
    principal: peers::Identity,
    policy: policy::PeerPolicy,
    generation: Option<String>,
) -> Result<(), String> {
    blocking(window, service, move |app, service| {
        service.set_peer_policy_at_generation(
            &epoch,
            &principal,
            policy,
            generation.as_deref().unwrap_or_default(),
        )?;
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
    accepted: bool,
    remember: Option<bool>,
) -> Result<(), String> {
    blocking(window, service, move |_app, service| {
        service.decide_remembered(&epoch, &id, accepted, remember.unwrap_or(false))
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
            service.revoke_grant(&mut s, &id);
        } else {
            service.stop_locked(&mut s);
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
    principal: peers::Identity,
    id: String,
    call: Call,
) -> Result<Value, String> {
    main(&window)?;
    let p = {
        let s = service.state.lock().unwrap();
        Service::check(&s, &epoch)?;
        Service::peer_principal(&s, &principal)?
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
        s.changes.notify();
        let _ = t.answer.send(if valid {
            result
        } else {
            errors::after_revocation(&t.call.name, &result)
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
            s.enabled = true;
            s.mcp_enabled = true;
        }
        assert_eq!(service.close("old").unwrap_err(), "SESSION_CLOSED");
        assert!(service.state.lock().unwrap().enabled);
        service.close("replacement").unwrap();
        assert!(!service.state.lock().unwrap().enabled);
    }
}
