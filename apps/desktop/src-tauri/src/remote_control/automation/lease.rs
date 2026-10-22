//! A borrowed automation lease retains the manual grant and its transport identity.
use super::*;
use crate::remote_control::host::{Active, AutomationReuse};
use weblink_desktop_capture::media::control::Port;
use weblink_desktop_input::{
    authorization::{Grant, RequestResult},
    engine::TrustedTarget,
    protocol::Signal,
    wire::Sequencer,
};

impl Host {
    pub(in crate::remote_control) fn automation_grant(
        &mut self,
        principal: &str,
        lease: Option<&str>,
    ) -> Result<(&Grant, &str), String> {
        self.automation_authority(principal, lease)?;
        if let Some(error) = self.check_automation_window() {
            return Err(input_error(error));
        }
        self.automation_authority(principal, lease)
    }

    /// Latch scope failure until the authority sampler consumes it. Keeping the
    /// reason separate from revocation preserves permissions without reviving
    /// this lease when focus returns. Only this borrower's held inputs are released.
    pub(in crate::remote_control) fn check_automation_window(
        &mut self,
    ) -> Option<weblink_desktop_input::input::Error> {
        let active = self.active.as_mut()?;
        let reuse = active.reuse.as_mut()?;
        if let Some(error) = reuse.window_error {
            return Some(error);
        }
        let error = reuse.window.as_ref()?.check(None).err()?;
        reuse.window_error = Some(error);
        reuse.window = None;
        let held = std::mem::take(&mut reuse.held);
        if !held.is_empty() && self.worker.status().grant.as_ref() == Some(&active.grant) {
            let _ = self
                .worker
                .input(active.grant.clone(), Event::ReleaseInputs(held));
            let _ = self.worker.flush();
        }
        Some(error)
    }

    /// Permission lifetime is independent of a borrowed invocation's window scope.
    /// Losing that window must reject input, not look like emergency revocation
    /// to the automation heartbeat and suspend every permission group.
    pub(in crate::remote_control) fn automation_authority(
        &self,
        principal: &str,
        lease: Option<&str>,
    ) -> Result<(&Grant, &str), String> {
        let active = self.active.as_ref().ok_or("CONTROL_REQUIRED")?;
        let peer = self
            .peers
            .get(&active.grant.binding.target.media_id)
            .ok_or("CONTROL_REQUIRED")?;
        let id = if active.kind == ControllerKind::Automation {
            if active.grant.binding.client_id != principal {
                return Err("CONTROL_REQUIRED".into());
            }
            active.grant.id.as_str()
        } else {
            let reuse = active
                .reuse
                .as_ref()
                .filter(|reuse| {
                    reuse.principal == principal
                        && active.grant.binding.client_id == principal
                        && peer.connection_generation.as_deref() == Some(reuse.generation.as_str())
                })
                .ok_or("CONTROL_REQUIRED")?;
            reuse.id.as_str()
        };
        let status = self.worker.status();
        if lease.is_some_and(|lease| lease != id)
            || status.input_suspended
            || status.grant.as_ref() != Some(&active.grant)
            || peer.endpoint.is_closed()
            || !peer.capture.is_current(&peer.binding)
        {
            return Err("CONTROL_REQUIRED".into());
        }
        Ok((&active.grant, id))
    }

    pub(in crate::remote_control) fn acquire_automation(
        &mut self,
        capture: Arc<dyn GeometrySource>,
        target: TrustedTarget,
        reuse_remote: bool,
    ) -> Result<bool, String> {
        self.tick();
        if !self.pending.is_empty() {
            return Err("BUSY".into());
        }
        if let Some(active) = self.active.as_ref() {
            let binding = &active.grant.binding;
            let requested = &target.binding;
            if binding.client_id != requested.client_id
                || binding.room_generation != requested.room_generation
                || binding.capture_session_id != requested.capture_session_id
                || binding.target.source_id != requested.target.source_id
                || binding.target.geometry_revision != requested.target.geometry_revision
            {
                return Err("BUSY".into());
            }
            if active.kind == ControllerKind::Automation {
                if binding.peer_generation != requested.peer_generation {
                    return Err("BUSY".into());
                }
                self.automation_grant(&requested.client_id, None)?;
                return Ok(false);
            }
            let peer = self.peers.get(&binding.target.media_id).ok_or("BUSY")?;
            let status = self.worker.status();
            // Only the authenticated peer principal can borrow. Source labels and
            // local MCP token IDs never supply a verified connection identity.
            if !reuse_remote
                || peer.connection_generation.as_deref() != Some(requested.peer_generation.as_str())
                || status.input_suspended
                || status.grant.as_ref() != Some(&active.grant)
                || peer.endpoint.is_closed()
                || !peer.capture.is_current(binding)
            {
                return Err("BUSY".into());
            }
            if let Some(reuse) = &active.reuse {
                if reuse.principal != requested.client_id
                    || reuse.generation != requested.peer_generation
                {
                    return Err("BUSY".into());
                }
            }
            if active
                .reuse
                .as_ref()
                .is_none_or(|reuse| reuse.window_error.is_some())
            {
                self.active.as_mut().unwrap().reuse = Some(AutomationReuse {
                    id: uuid::Uuid::new_v4().to_string(),
                    principal: requested.client_id.clone(),
                    generation: requested.peer_generation.clone(),
                    held: vec![],
                    window: None,
                    window_error: None,
                });
            }
            return Ok(true);
        }
        let binding = target.binding.clone();
        let media = binding.target.media_id.clone();
        let endpoint = self.register(capture, target, None)?;
        endpoint.opened(Arc::new(Sink));
        let result = (|| {
            let consent = match self
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
            let signal = self
                .worker
                .approve(consent)
                .map_err(input_error)?
                .ok_or("PERMISSION_DENIED")?;
            let Signal::Grant { grant_id, .. } = signal else {
                return Err("PERMISSION_DENIED".into());
            };
            self.active = Some(Active {
                reuse: None,
                kind: ControllerKind::Automation,
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
            self.worker.flush().map_err(input_error)?;
            Ok(false)
        })();
        if result.is_err() {
            self.remove_peer(&media);
        }
        result
    }
}
