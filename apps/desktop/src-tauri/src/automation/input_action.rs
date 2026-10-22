//! Execute bounded pointer, key and text plans against an exact native lease.
use super::*;
use tauri::Manager;
use weblink_desktop_input::input::Event;

/// Called under the automation authority lock by its existing lifecycle sampler.
pub(super) fn expire_holds(
    control: &crate::remote_control::Service,
    service: &Service,
    interrupted: bool,
) {
    if let Some((principal, lease)) = service
        .input_holds
        .lock()
        .unwrap()
        .expired(Instant::now(), interrupted)
    {
        control.automation_revoke_lease(&principal, &lease);
    }
}
struct NativeSink {
    app: tauri::AppHandle,
    service: Shared,
    epoch: String,
    id: String,
    principal: String,
    lease: String,
    geometry: Option<(String, String)>,
    cancel: CancellationToken,
}
impl NativeSink {
    fn authority(&self, s: &State) -> Result<(), String> {
        if self.cancel.is_cancelled() {
            return Err("CANCELLED".into());
        }
        let ticket = input_sequence::check(s, &self.epoch, &self.id)?;
        if ticket.principal.id != self.principal {
            return Err("CANCELLED".into());
        }
        if !self
            .app
            .state::<crate::remote_control::Shared>()
            .automation_matches(&self.principal, &self.lease)
        {
            return Err("CONTROL_REQUIRED".into());
        }
        if !self.service.input_holds.lock().unwrap().live(&self.lease) {
            return Err("HOLD_EXPIRED".into());
        }
        Ok(())
    }
}
impl input_runner::Sink for NativeSink {
    fn check(&self) -> Result<(), String> {
        self.authority(&self.service.state.lock().unwrap())
    }
    fn send(&self, events: Vec<Event>) -> Result<(), String> {
        let s = self.service.state.lock().unwrap();
        self.authority(&s)?;
        let control = self.app.state::<crate::remote_control::Shared>();
        if let Some((source, revision)) = &self.geometry {
            control.automation_geometry(
                self.app.state::<crate::capture::Service>().inner(),
                &self.principal,
                &self.lease,
                source,
                revision,
            )?;
        }
        // Record before dispatch, including a partial native button injection.
        self.service.input_holds.lock().unwrap().update(
            &self.principal,
            &self.lease,
            &events,
            Instant::now(),
        );
        control.automation_input(&self.principal, &self.lease, events)
    }
    fn abort(&self) {
        let mut state = self.service.state.lock().unwrap_or_else(|e| e.into_inner());
        let control = self.app.state::<crate::remote_control::Shared>();
        control.automation_revoke_lease(&self.principal, &self.lease);
        // This invocation ended its own lease; it is not an external emergency stop.
        if !control.automation_active(&self.principal) {
            state
                .input_owners
                .retain(|principal| principal != &self.principal);
        }
        self.service
            .input_holds
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear(&self.lease);
    }
}
pub async fn action(
    app: tauri::AppHandle,
    service: Shared,
    epoch: String,
    id: String,
    turn: input_sequence::Turn,
) -> Result<Value, String> {
    let cancel = CancellationToken::new();
    let _on_drop = cancel.clone().drop_guard();
    tauri::async_runtime::spawn_blocking(move || {
        // Keep serialization until the worker exits, even if its awaiting future is dropped.
        let _turn = turn;
        let (name, args, principal, lease) = {
            let mut s = service.state.lock().unwrap();
            let t = input_sequence::check(&s, &epoch, &id)?;
            if t.used || t.principal.id != _turn.principal {
                return Err("CANCELLED".into());
            }
            let t_name = t.call.name.clone();
            let args = t.call.arguments.clone();
            let principal = t.principal.id.clone();
            let lease = _turn.lease.clone().ok_or("CONTROL_REQUIRED")?;
            s.tickets.get_mut(&id).unwrap().used = true;
            (t_name, args, principal, lease)
        };
        let geometry = if name == "control.pointer" {
            Some((
                args["sourceId"].as_str().ok_or("INVALID_ARGUMENTS")?.into(),
                args["geometryRevision"]
                    .as_str()
                    .ok_or("INVALID_ARGUMENTS")?
                    .into(),
            ))
        } else {
            None
        };
        let sink = NativeSink {
            app,
            service,
            epoch,
            id,
            principal,
            lease,
            geometry,
            cancel,
        };
        let plan = {
            let s = sink.service.state.lock().unwrap();
            sink.authority(&s)?;
            let held = sink.service.input_holds.lock().unwrap();
            match name.as_str() {
                "control.pointer" => {
                    let (source, revision) = sink.geometry.as_ref().ok_or("INVALID_ARGUMENTS")?;
                    let geometry = sink
                        .app
                        .state::<crate::remote_control::Shared>()
                        .automation_geometry(
                            sink.app.state::<crate::capture::Service>().inner(),
                            &sink.principal,
                            &sink.lease,
                            source,
                            revision,
                        )?;
                    input_runner::Plan::pointer(&args, geometry, &held.buttons(&sink.lease))?
                }
                "control.key" => input_runner::Plan::key(&args, &held.keys(&sink.lease))?,
                "control.text" => input_runner::Plan::text(&args, held.any(&sink.lease))?,
                _ => return Err("UNSUPPORTED".into()),
            }
        };
        let samples = input_runner::run(plan, &sink)?;
        let mut result = sink.service.input_holds.lock().unwrap().result(&sink.lease);
        result["applied"] = json!(true);
        result["samples"] = json!(samples);
        Ok(result)
    })
    .await
    .map_err(|_| "EXECUTION_FAILED")?
}
