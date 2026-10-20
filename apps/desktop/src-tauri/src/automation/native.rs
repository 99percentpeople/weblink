use super::*;
use tauri::Manager;
pub fn sync_input(app: &tauri::AppHandle, service: &Service) {
    service.expire();
    let mut s = service.state.lock().unwrap();
    let control = app.state::<crate::remote_control::Shared>();
    super::input_action::expire_holds(app, service, !s.pending.is_empty());
    let ended: Vec<_> = s
        .input_owners
        .iter()
        .filter(|id| !control.automation_active(id))
        .cloned()
        .collect();
    let revoked: Vec<_> = s
        .grants
        .values()
        .filter(|g| {
            ended.contains(&g.principal.id)
                && g.scopes.iter().any(|v| v == "input.control")
                && g.target == "local"
        })
        .map(|g| g.id.clone())
        .collect();
    // Disconnect/revocation already removed its grants. Only a still-authorized
    // owner ending externally needs to suspend automatic reacquisition.
    if !revoked.is_empty() {
        service.pause_policies(&mut s);
    }
    for id in revoked {
        service.revoke_locked(&mut s, &id);
    }
    let allowed: Vec<String> = s
        .grants
        .values()
        .filter(|g| {
            Service::grant_live(&s, g)
                && g.target == "local"
                && g.scopes.iter().any(|v| v == "input.control")
        })
        .map(|g| g.principal.id.clone())
        .collect();
    for id in &s.input_owners {
        if !allowed.contains(id) {
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
    let turn = if catalog::find(&name)?["scope"] == "input.control" && name != "control.release" {
        Some(super::input_sequence::enter(&app, &service, &epoch, &id).await?)
    } else {
        None
    };
    if matches!(
        name.as_str(),
        "control.pointer" | "control.key" | "control.text"
    ) {
        return super::input_action::action(
            app,
            service,
            epoch,
            id,
            turn.ok_or("CONTROL_REQUIRED")?,
        )
        .await;
    }
    if name.starts_with("accessibility.") || name == "control.bindWindow" {
        return super::accessibility::action(app, service, epoch, id, turn).await;
    }
    tauri::async_runtime::spawn_blocking(move||{
        let _turn=turn;
        let mut s=service.state.lock().unwrap();Service::check(&s,&epoch)?;
        let t=s.tickets.get(&id).ok_or("CANCELLED")?;
        if t.used||t.deadline<=Instant::now()||!Service::current(&s)||!s.grants.get(&t.grant).is_some_and(|g|Service::grant_live(&s,g)){return Err("GRANT_EXPIRED".into());}
        if t.call.arguments["target"]!="local"{return Err("INVALID_TARGET".into());}
        let call=t.call.clone();let principal=t.principal.id.clone();let grant=t.grant.clone();
        if let Some(turn)=&_turn {
            super::input_sequence::check(&s,&epoch,&id)?;
            if turn.principal != principal {return Err("CANCELLED".into());}
            if turn.lease.as_ref().is_some_and(|lease| !app.state::<crate::remote_control::Shared>().automation_matches(&principal,lease)) {return Err("CONTROL_REQUIRED".into());}
        }
        s.tickets.get_mut(&id).unwrap().used=true;
        // Serialize permission revocation with the final native side effect.
        let args=&call.arguments;let control=app.state::<crate::remote_control::Shared>();let capture=app.state::<crate::capture::Service>();
        if catalog::find(&call.name)?["scope"]=="input.control" && call.name!="control.release" && !s.pending.is_empty() {
            return Err("APPROVAL_PENDING".into());
        }
        if catalog::find(&call.name)?["scope"]=="input.control" && s.input_owners.contains(&principal) && !control.automation_active(&principal) {
            service.pause_policies(&mut s);service.revoke_locked(&mut s,&grant);s.input_owners.retain(|id|id!=&principal);return Err("GRANT_EXPIRED".into());
        }
        match call.name.as_str(){
            "commands.start"=>service.jobs.start(&principal,&grant,args),
            "commands.status"|"commands.read"|"commands.cancel"=>service.jobs.access(&principal,&grant,&call.name,args),
            "screen.sources"=>{
                let sources = capture.sources()?;
                // Preserve source discovery on platforms without native geometry support.
                match capture.display_layout() {
                    Ok(layout) => Ok(json!({"sources":sources,"coordinateSpace":"desktopPhysicalPixels","geometryRevision":layout.revision,"virtualBounds":layout.virtual_bounds,"displays":layout.displays})),
                    Err(_) => Ok(json!({"sources":sources})),
                }
            },
            "control.screenshot"=>{
                let source = args["sourceId"].as_str().ok_or("INVALID_ARGUMENTS")?;
                super::coordinates::screenshot(source, capture.snapshot(source.into())?)
            },
            "control.acquire"=>{
                let session=binding.get("sessionId").ok_or("CAPTURE_REQUIRED")?;let source=binding.get("sourceId").ok_or("CAPTURE_REQUIRED")?;
                let result = control.automation_acquire(capture.inner().clone(),&principal,session.clone(),source.clone())?;
                if !s.input_owners.contains(&principal){s.input_owners.push(principal);}Ok(result)
            },
            "control.release"=>{control.automation_release(&principal);s.input_owners.retain(|id|id!=&principal);Ok(json!({"released":true}))},
            _=>Err("UNSUPPORTED".into())
        }
    }).await.map_err(|e|e.to_string())?
}
