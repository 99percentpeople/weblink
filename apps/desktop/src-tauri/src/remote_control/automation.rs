//! Automation can own a grant or borrow the same verified device's manual grant.
use super::{
    binding::GeometrySource,
    host::Host,
    input_error,
    service::{Owner, Service},
    Context, ControllerKind,
};
use crate::automation::coordinates;
use serde_json::Value;
use std::sync::Arc;
use weblink_desktop_capture::{
    media::control::{SendResult, Sender},
    CaptureService,
};
use weblink_desktop_input::input::{Event, Geometry, Held};
mod lease;

struct Sink;
impl Sender for Sink {
    fn send(&self, _: &[u8]) -> SendResult {
        SendResult::Sent
    }
    fn close(&self) {}
}
impl Service {
    fn automation_owner(&self) -> Result<Arc<Owner>, String> {
        self.owner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|owner| owner.live())
            .cloned()
            .ok_or_else(|| "CONTROL_REQUIRED".into())
    }
    pub fn automation_acquire(
        &self,
        capture: Arc<CaptureService>,
        principal: &str,
        generation: &str,
        reuse_remote: bool,
        session: String,
        source: String,
    ) -> Result<Value, String> {
        let owner = match self.automation_owner() {
            Ok(owner) => owner,
            Err(_) => {
                let id = self.open_with_shortcut(None)?;
                self.owner(&id)?
            }
        };
        let target = super::binding::resolve(
            &capture,
            &owner.id,
            Context {
                owner_id: owner.id.clone(),
                peer_generation: generation.into(),
                connection_generation: None,
                client_id: principal.into(),
                source_id: source,
            },
            session,
            uuid::Uuid::new_v4().to_string(),
        )?;
        let source = capture
            .status(target.binding.capture_session_id.clone())?
            .source
            .ok_or("CAPTURE_REQUIRED")?;
        let mut result = coordinates::metadata(
            &source.id,
            &target.binding.target.geometry_revision,
            target.geometry,
        );
        let mut host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let reused = host.acquire_automation(capture, target, reuse_remote)?;
        owner.publish(host.snapshot());
        result["acquired"] = serde_json::json!(true);
        result["reused"] = serde_json::json!(reused);
        Ok(result)
    }
    pub fn automation_lease(&self, principal: &str) -> Result<String, String> {
        let owner = self.automation_owner()?;
        let mut host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        Ok(host.automation_grant(principal, None)?.1.to_owned())
    }
    pub fn automation_matches(&self, principal: &str, lease: &str) -> bool {
        self.automation_lease(principal).as_deref() == Ok(lease)
    }
    pub fn automation_active(&self, principal: &str) -> bool {
        let Ok(owner) = self.automation_owner() else {
            return false;
        };
        let host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        host.automation_authority(principal, None).is_ok()
    }
    pub fn automation_window_bound(&self, principal: &str, lease: &str) -> Result<bool, String> {
        let owner = self.automation_owner()?;
        let mut host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        host.automation_grant(principal, Some(lease))?;
        Ok(host
            .active
            .as_ref()
            .and_then(|active| active.reuse.as_ref())
            .map_or_else(
                || host.worker.status().window_bound,
                |reuse| reuse.window.is_some(),
            ))
    }
    pub fn automation_bind_window(
        &self,
        principal: &str,
        lease: &str,
        window: weblink_desktop_input::window::BoundWindow,
    ) -> Result<(), String> {
        let owner = self.automation_owner()?;
        let mut host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let grant = host.automation_grant(principal, Some(lease))?.0.clone();
        if self.automation_bound(&host) {
            return Err("WINDOW_ALREADY_BOUND".into());
        }
        if !host.worker.status().held.is_empty() {
            return Err("INPUT_HELD".into());
        }
        if host.active.as_ref().is_some_and(|a| a.reuse.is_some()) {
            window.activate().map_err(input_error)?;
            window.check(None).map_err(input_error)?;
            host.active.as_mut().unwrap().reuse.as_mut().unwrap().window = Some(window);
            if let Some(wake) = &host.wake {
                wake.unpark();
            }
            Ok(())
        } else {
            host.worker.bind_window(grant, window).map_err(input_error)
        }
    }
    fn automation_bound(&self, host: &Host) -> bool {
        host.active
            .as_ref()
            .and_then(|active| active.reuse.as_ref())
            .map_or_else(
                || host.worker.status().window_bound,
                |reuse| reuse.window.is_some(),
            )
    }
    pub fn automation_input(
        &self,
        principal: &str,
        lease: &str,
        events: Vec<Event>,
    ) -> Result<(), String> {
        let owner = self.automation_owner()?;
        let mut host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let grant = host.automation_grant(principal, Some(lease))?.0.clone();
        if !host.worker.renew(grant.clone()).map_err(input_error)? {
            return Err("CONTROL_REQUIRED".into());
        }
        for event in events {
            let transition = match &event {
                Event::Key { key, down } => Some((Held::Key(*key), *down)),
                Event::Button { button, down, .. } => Some((Held::Button(*button), *down)),
                _ => None,
            };
            let held = host.worker.status().held;
            let window = if let Some(reuse) = host.active.as_mut().and_then(|a| a.reuse.as_mut()) {
                reuse.held.retain(|input| held.contains(input));
                // Never inherit a human's held modifier/button or release it on failure.
                if held.iter().any(|input| !reuse.held.contains(input)) {
                    return Err("INPUT_HELD".into());
                }
                if let Some((input, down)) = transition {
                    if down {
                        if !reuse.held.contains(&input) {
                            reuse.held.push(input);
                        }
                    } else if !reuse.held.contains(&input) {
                        return Err("INPUT_HELD".into());
                    }
                }
                reuse.window.clone()
            } else {
                None
            };
            if host
                .active
                .as_ref()
                .is_some_and(|active| active.reuse.is_some())
            {
                host.worker
                    .input_scoped(grant.clone(), event, window)
                    .map_err(input_error)?;
            } else {
                host.worker
                    .input(grant.clone(), event)
                    .map_err(input_error)?;
            }
            let status = host.worker.flush().map_err(input_error)?;
            if let Some(error) = status.failure {
                return Err(input_error(error));
            }
            if status.input_suspended || status.grant.as_ref() != Some(&grant) {
                return Err("CONTROL_REQUIRED".into());
            }
            if let Some((input, false)) = transition {
                if let Some(reuse) = host.active.as_mut().and_then(|a| a.reuse.as_mut()) {
                    reuse.held.retain(|held| *held != input);
                }
            }
        }
        Ok(())
    }
    pub fn automation_geometry(
        &self,
        capture: &CaptureService,
        principal: &str,
        lease: &str,
        source_id: &str,
        revision: &str,
    ) -> Result<Geometry, String> {
        let owner = self.automation_owner()?;
        let mut host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let grant = host.automation_grant(principal, Some(lease))?.0.clone();
        if !host.worker.renew(grant.clone()).map_err(input_error)? {
            return Err("CONTROL_REQUIRED".into());
        }
        let binding = &grant.binding;
        let layout = capture.display_geometry(binding.capture_session_id.clone())?;
        if layout.revision != binding.target.geometry_revision || layout.revision != revision {
            return Err("GEOMETRY_CHANGED".into());
        }
        let source = capture
            .status(binding.capture_session_id.clone())?
            .source
            .ok_or("CAPTURE_REQUIRED")?;
        if source.id != source_id {
            return Err("SOURCE_MISMATCH".into());
        }
        let display = layout
            .displays
            .iter()
            .find(|d| d.source_id == source.id)
            .ok_or("SOURCE_UNAVAILABLE")?;
        Ok(Geometry {
            display: coordinates::rect(&display.bounds),
            desktop: coordinates::rect(&layout.virtual_bounds),
        })
    }
    pub fn automation_sync(&self, principals: &[String]) {
        let Ok(owner) = self.automation_owner() else {
            return;
        };
        let host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        for principal in principals {
            if let Ok((grant, _)) = host.automation_authority(principal, None) {
                let _ = host.worker.renew(grant.clone());
            }
        }
    }
    /// Consume a window-scope interruption while the automation authority lock
    /// is held. Real revocation wins if the underlying native grant also ended.
    pub(crate) fn automation_take_window_interruption(&self, principal: &str) -> Option<String> {
        let owner = self.automation_owner().ok()?;
        let mut host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let active = host.active.as_ref()?;
        if active.kind == ControllerKind::Automation {
            let status = host.worker.status();
            if active.grant.binding.client_id != principal
                || status.grant.as_ref() != Some(&active.grant)
                || status.window_error.is_none()
                || status.failure.is_some()
            {
                return None;
            }
            let grant = active.grant.clone();
            // The actor rechecks its exact grant, including a pending emergency.
            if !host.worker.revoke_matching(grant.clone()).ok()? {
                return None;
            }
            host.end_grant();
            host.remove_peer(&grant.binding.target.media_id);
            owner.publish(host.snapshot());
            return Some(grant.id);
        }
        host.automation_authority(principal, None).ok()?;
        host.check_automation_window()?;
        host.automation_authority(principal, None).ok()?;
        Some(host.active.as_mut()?.reuse.take()?.id)
    }
    pub fn automation_release(&self, principal: &str) {
        self.automation_release_matching(principal, None);
    }
    pub fn automation_revoke_lease(&self, principal: &str, lease: &str) -> bool {
        self.automation_release_matching(principal, Some(lease))
    }
    fn automation_release_matching(&self, principal: &str, lease: Option<&str>) -> bool {
        let Ok(owner) = self.automation_owner() else {
            return false;
        };
        let mut host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let Some(active) = host.active.as_mut() else {
            return false;
        };
        let mut released = false;
        if active.kind == ControllerKind::Remote {
            if active.reuse.as_ref().is_some_and(|reuse| {
                reuse.principal == principal && lease.is_none_or(|lease| reuse.id == lease)
            }) {
                let reuse = active.reuse.take().unwrap();
                let grant = active.grant.clone();
                if !reuse.held.is_empty() && host.worker.status().grant.as_ref() == Some(&grant) {
                    let _ = host
                        .worker
                        .input(grant.clone(), Event::ReleaseInputs(reuse.held));
                }
                // Flush also observes an emergency already pending on the input actor.
                released = host.worker.flush().is_ok_and(|status| {
                    status.grant.as_ref() == Some(&grant)
                        && !status.input_suspended
                        && status.failure.is_none()
                });
            }
        } else if active.grant.binding.client_id == principal
            && lease.is_none_or(|lease| active.grant.id == lease)
        {
            let media = active.grant.binding.target.media_id.clone();
            let grant = active.grant.clone();
            released = host.worker.revoke_matching(grant).unwrap_or(false);
            host.end_grant();
            host.remove_peer(&media);
        }
        owner.publish(host.snapshot());
        released
    }
}
