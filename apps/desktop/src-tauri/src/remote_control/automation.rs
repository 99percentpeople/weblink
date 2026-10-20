//! Automation shares the existing native authority, exclusivity and emergency shortcut.
use super::{host::Active, input_error, service::Service, Context};
use crate::automation::coordinates;
use serde_json::Value;
use std::sync::Arc;
use weblink_desktop_capture::{
    media::control::{Port, SendResult, Sender},
    CaptureService,
};
use weblink_desktop_input::{
    authorization::{Grant, RequestResult},
    input::{Event, Geometry},
    protocol::Signal,
    wire::Sequencer,
};
struct Sink;
impl Sender for Sink {
    fn send(&self, _: &[u8]) -> SendResult {
        SendResult::Sent
    }
    fn close(&self) {}
}
impl Service {
    pub fn automation_acquire(
        &self,
        capture: Arc<CaptureService>,
        principal: &str,
        session: String,
        source: String,
    ) -> Result<Value, String> {
        let owner = {
            let slot = self.owner.lock().unwrap_or_else(|e| e.into_inner());
            slot.as_ref().filter(|o| o.live()).cloned()
        };
        let owner = match owner {
            Some(o) => o,
            None => {
                let id = self.open_with_shortcut(None)?;
                self.owner(&id)?
            }
        };
        let media = uuid::Uuid::new_v4().to_string();
        let target = super::binding::resolve(
            &capture,
            &owner.id,
            Context {
                owner_id: owner.id.clone(),
                peer_generation: principal.into(),
                client_id: principal.into(),
                source_id: source,
            },
            session,
            media.clone(),
        )?;
        let binding = target.binding.clone();
        let source = capture
            .status(binding.capture_session_id.clone())?
            .source
            .ok_or("CAPTURE_REQUIRED")?;
        let mut result_geometry = coordinates::metadata(
            &source.id,
            &binding.target.geometry_revision,
            target.geometry,
        );
        result_geometry["acquired"] = serde_json::json!(true);
        let mut h = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        h.tick();
        if h.active.is_some() || !h.pending.is_empty() {
            return Err("BUSY".into());
        }
        let endpoint = h.register(capture, target)?;
        endpoint.opened(Arc::new(Sink));
        let result = (|| {
            let consent = match h
                .worker
                .request(
                    media.clone(),
                    Signal::Request {
                        request_id: uuid::Uuid::new_v4().to_string(),
                        target: binding.target.clone(),
                    },
                )
                .map_err(input_error)?
            {
                Some(RequestResult::Pending { consent_id }) => consent_id,
                _ => return Err("BUSY".into()),
            };
            let signal = h
                .worker
                .approve(consent)
                .map_err(input_error)?
                .ok_or("PERMISSION_DENIED")?;
            let Signal::Grant { grant_id, .. } = signal else {
                return Err("PERMISSION_DENIED".into());
            };
            h.active = Some(Active {
                gamepad_feedback: Default::default(),
                sequencer: Sequencer::new(
                    grant_id.clone(),
                    media.clone(),
                    binding.target.geometry_revision.clone(),
                ),
                grant: Grant {
                    id: grant_id,
                    binding,
                },
            });
            h.worker.flush().map_err(input_error)?;
            Ok(result_geometry)
        })();
        if result.is_err() {
            h.remove_peer(&media);
        }
        owner.publish(h.snapshot());
        result
    }
    pub fn automation_lease(&self, principal: &str) -> Result<String, String> {
        let owner = self
            .owner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or("CONTROL_REQUIRED")?;
        let h = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let grant = &h
            .active
            .as_ref()
            .filter(|a| a.grant.binding.client_id == principal)
            .ok_or("CONTROL_REQUIRED")?
            .grant;
        let status = h.worker.status();
        if status.input_suspended || status.grant.as_ref() != Some(grant) {
            return Err("CONTROL_REQUIRED".into());
        }
        Ok(grant.id.clone())
    }
    pub fn automation_window_bound(&self, principal: &str, lease: &str) -> Result<bool, String> {
        let owner = self
            .owner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or("CONTROL_REQUIRED")?;
        let h = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let grant = &h
            .active
            .as_ref()
            .filter(|a| a.grant.binding.client_id == principal && a.grant.id == lease)
            .ok_or("CONTROL_REQUIRED")?
            .grant;
        let status = h.worker.status();
        if status.input_suspended || status.grant.as_ref() != Some(grant) {
            return Err("CONTROL_REQUIRED".into());
        }
        Ok(status.window_bound)
    }
    pub fn automation_bind_window(
        &self,
        principal: &str,
        lease: &str,
        window: weblink_desktop_input::window::BoundWindow,
    ) -> Result<(), String> {
        let owner = self
            .owner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or("CONTROL_REQUIRED")?;
        let h = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let grant = &h
            .active
            .as_ref()
            .filter(|a| a.grant.binding.client_id == principal && a.grant.id == lease)
            .ok_or("CONTROL_REQUIRED")?
            .grant;
        if h.worker.status().window_bound {
            return Err("WINDOW_ALREADY_BOUND".into());
        }
        h.worker
            .bind_window(grant.clone(), window)
            .map_err(input_error)
    }
    pub fn automation_matches(&self, principal: &str, lease: &str) -> bool {
        self.automation_lease(principal).as_deref() == Ok(lease)
    }
    pub fn automation_input(
        &self,
        principal: &str,
        lease: &str,
        events: Vec<Event>,
    ) -> Result<(), String> {
        let owner = self
            .owner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or("CONTROL_REQUIRED")?;
        let h = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let grant = &h
            .active
            .as_ref()
            .filter(|a| a.grant.binding.client_id == principal && a.grant.id == lease)
            .ok_or("CONTROL_REQUIRED")?
            .grant;
        if !h.worker.renew(grant.clone()).map_err(input_error)? {
            return Err("CONTROL_REQUIRED".into());
        }
        for event in events {
            h.worker.input(grant.clone(), event).map_err(input_error)?;
            let status = h.worker.flush().map_err(input_error)?;
            if let Some(error) = status.failure {
                return Err(input_error(error));
            }
            if status.input_suspended || status.grant.as_ref() != Some(grant) {
                return Err("CONTROL_REQUIRED".into());
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
        let owner = self
            .owner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or("CONTROL_REQUIRED")?;
        let h = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let grant = &h
            .active
            .as_ref()
            .filter(|a| a.grant.binding.client_id == principal && a.grant.id == lease)
            .ok_or("CONTROL_REQUIRED")?
            .grant;
        if !h.worker.renew(grant.clone()).map_err(input_error)? {
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
    pub fn automation_active(&self, principal: &str) -> bool {
        self.automation_lease(principal).is_ok()
    }
    pub fn automation_sync(&self, principals: &[String]) {
        let Some(owner) = self.owner.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
            return;
        };
        let h = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        // Only the automation IDs supplied here may be renewed. Other controls remain untouched.
        if let Some(a) = h.active.as_ref() {
            if principals.contains(&a.grant.binding.client_id) {
                let _ = h.worker.renew(a.grant.clone());
            }
        }
    }
    pub fn automation_release(&self, principal: &str) {
        self.automation_release_matching(principal, None);
    }
    pub fn automation_revoke_lease(&self, principal: &str, lease: &str) {
        self.automation_release_matching(principal, Some(lease));
    }
    fn automation_release_matching(&self, principal: &str, lease: Option<&str>) {
        let Some(owner) = self.owner.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
            return;
        };
        let mut h = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let media = h
            .active
            .as_ref()
            .filter(|a| {
                a.grant.binding.client_id == principal
                    && lease.is_none_or(|lease| a.grant.id == lease)
            })
            .map(|a| a.grant.binding.target.media_id.clone());
        if let Some(media) = media {
            let _ = h.worker.revoke();
            h.end_grant();
            h.remove_peer(&media);
            owner.publish(h.snapshot());
        }
    }
}
