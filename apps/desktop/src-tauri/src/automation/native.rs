use super::*;
use tauri::Manager;
#[cfg(test)]
mod tests;
pub fn sync_input(app: &tauri::AppHandle, service: &Service) {
    sync_input_control(service, &app.state::<crate::remote_control::Shared>());
}
/// Local renderer ownership metadata; never accepted from tool arguments.
pub(super) fn screen_grants(s: &State, principal: Option<&Principal>) -> Vec<String> {
    s.grants
        .values()
        .filter(|g| {
            s.enabled
                && g.target == "local"
                && g.scopes.iter().any(|scope| scope == "screen.manage")
                && Service::grant_live(s, g)
                && principal.is_none_or(|p| {
                    g.principal.id == p.id
                        && g.principal.kind == p.kind
                        && g.principal.generation == p.generation
                })
        })
        .map(|g| g.id.clone())
        .collect()
}
/// Report an actual input lease, not merely permission to acquire one.
pub(super) fn controller(s: &State, control: &crate::remote_control::Service) -> Option<Principal> {
    s.grants
        .values()
        .find(|grant| {
            s.enabled
                && grant.target == "local"
                && grant.scopes.iter().any(|scope| scope == "input.control")
                && s.input_owners.contains(&grant.principal.id)
                && Service::grant_live(s, grant)
                && control.automation_active(&grant.principal.id)
        })
        .map(|grant| grant.principal.clone())
}
fn retire_input_interruption(
    service: &Service,
    control: &crate::remote_control::Service,
    principal: &str,
) -> bool {
    if let Some(lease) = control.automation_take_window_interruption(principal) {
        service.input_holds.lock().unwrap().clear(&lease);
        return true;
    }
    if control.automation_active(principal) {
        return false;
    }
    // A capture ending, input interruption or hold timeout ends only this lease.
    // Emergency authority is fenced independently by the shared shortcut observer.
    control.automation_release(principal);
    service
        .input_holds
        .lock()
        .unwrap()
        .clear_principal(principal);
    true
}
fn sync_input_control(service: &Service, control: &crate::remote_control::Service) {
    service.expire();
    let mut s = service.state.lock().unwrap();
    // The host can be replaced by room teardown. Keep the same shortcut available
    // for background commands even when automation holds no native input lease.
    let active = s.enabled || s.mcp_enabled;
    if control.automation_listener(active).is_err() && active {
        service.stop_locked(&mut s);
    }
    super::input_action::expire_holds(control, service, !s.pending.is_empty());
    s.input_owners
        .retain(|principal| !retire_input_interruption(service, control, principal));
    let allowed: Vec<String> = s
        .grants
        .values()
        .filter(|g| {
            s.enabled
                && Service::grant_live(&s, g)
                && g.target == "local"
                && g.scopes.iter().any(|v| v == "input.control")
        })
        .map(|g| g.principal.id.clone())
        .collect();
    for id in &s.input_owners {
        if !allowed.contains(id) {
            if let Ok(lease) = control.automation_lease(id) {
                service.input_holds.lock().unwrap().clear(&lease);
            }
            control.automation_release(id);
        }
    }
    s.input_owners.retain(|id| allowed.contains(id));
    control.automation_sync(&s.input_owners);
}
pub async fn action(
    app: tauri::AppHandle,
    service: Shared,
    epoch: String,
    id: String,
    binding: HashMap<String, String>,
) -> Result<Value, String> {
    let name = service
        .state
        .lock()
        .unwrap()
        .tickets
        .get(&id)
        .ok_or("CANCELLED")?
        .call
        .name
        .clone();
    if name == "commands.run" {
        return super::command_run::action(service, epoch, id).await;
    }
    if super::native_read::handles(&name) {
        return super::native_read::action(
            app.state::<crate::capture::Service>().inner().clone(),
            service,
            epoch,
            id,
        )
        .await;
    }
    let turn = if catalog::find(&name)?["scope"] == "input.control" && name != "control.release" {
        Some(super::input_sequence::enter(&app, &service, &epoch, &id).await?)
    } else {
        None
    };
    if matches!(
        name.as_str(),
        "control.pointer" | "control.key" | "control.text"
    ) || name.starts_with("accessibility.")
        || name == "control.bindWindow"
    {
        let window = turn.as_ref().and_then(|turn| turn.window.clone());
        let result = if name.starts_with("accessibility.") || name == "control.bindWindow" {
            super::accessibility::action(app, service.clone(), epoch.clone(), id.clone(), turn)
                .await
        } else {
            super::input_action::action(
                app,
                service.clone(),
                epoch.clone(),
                id.clone(),
                turn.ok_or("CONTROL_REQUIRED")?,
            )
            .await
        };
        return super::input_sequence::window_result(result, window.as_ref(), || {
            super::input_sequence::check(&service.state.lock().unwrap(), &epoch, &id).map(|_| ())
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _turn = turn;
        let mut s = service.state.lock().unwrap();
        Service::check_call(&s, &epoch, &id)?;
        let t = s.tickets.get(&id).ok_or("CANCELLED")?;
        if t.used {
            return Err("CANCELLED".into());
        }
        if t.call.arguments["target"] != "local" {
            return Err("INVALID_TARGET".into());
        }
        let call = t.call.clone();
        let principal = t.principal.id.clone();
        let reuse_remote = t.principal.kind == "peer";
        let generation = t
            .principal
            .generation
            .clone()
            .unwrap_or_else(|| epoch.clone());
        let grant = t.grant.clone();
        if let Some(turn) = &_turn {
            super::input_sequence::check(&s, &epoch, &id)?;
            if turn.principal != principal {
                return Err("CANCELLED".into());
            }
            if turn.lease.as_ref().is_some_and(|lease| {
                !app.state::<crate::remote_control::Shared>()
                    .automation_matches(&principal, lease)
            }) {
                return Err("CONTROL_REQUIRED".into());
            }
        }
        s.tickets.get_mut(&id).unwrap().used = true;
        // Serialize permission revocation with the final native side effect.
        let args = &call.arguments;
        let control = app.state::<crate::remote_control::Shared>();
        let capture = app.state::<crate::capture::Service>();
        if catalog::find(&call.name)?["scope"] == "input.control"
            && call.name != "control.release"
            && !s.pending.is_empty()
        {
            return Err("APPROVAL_PENDING".into());
        }
        if s.input_owners.contains(&principal)
            && retire_input_interruption(&service, &control, &principal)
        {
            s.input_owners.retain(|id| id != &principal);
        }
        match call.name.as_str() {
            "commands.capabilities" => Ok(super::jobs::capabilities()),
            "commands.start" => service.jobs.start(&principal, &grant, args),
            "commands.status" | "commands.read" | "commands.send" => {
                service.jobs.access(&principal, &grant, &call.name, args)
            }
            "control.acquire" => {
                let session = binding.get("sessionId").ok_or("CAPTURE_REQUIRED")?;
                let source = binding.get("sourceId").ok_or("CAPTURE_REQUIRED")?;
                let mut result = control.automation_acquire(
                    capture.inner().clone(),
                    &principal,
                    &generation,
                    reuse_remote,
                    session.clone(),
                    source.clone(),
                )?;
                // Renderer-only lifetime marker. The adapter strips it before
                // returning the public tool result over MCP/P2P.
                result["controlLeaseId"] = json!(control.automation_lease(&principal)?);
                if !s.input_owners.contains(&principal) {
                    s.input_owners.push(principal);
                }
                Ok(result)
            }
            "control.release" => {
                control.automation_release(&principal);
                s.input_owners.retain(|id| id != &principal);
                Ok(json!({"released":true}))
            }
            _ => Err("UNSUPPORTED".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
