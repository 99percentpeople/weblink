//! The shared host shortcut fences calls immediately; cleanup runs off the hook thread.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;

#[derive(Default)]
pub(super) struct Emergency {
    pending: AtomicBool,
    pub wake: Notify,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emergency_resets_allowed_policies_preserves_denials_and_cannot_be_undone_by_a_toggle() {
        let service = Service::default();
        let mut s = service.state.lock().unwrap();
        s.epoch = "epoch".into();
        s.peer_policies.insert(
            "device".into(),
            HashMap::from([
                ("diagnostics.read".into(), policy::Decision::Allow),
                ("shell.execute".into(), policy::Decision::Deny),
                ("input.control".into(), policy::Decision::Ask),
            ]),
        );
        // Reading/diagnostics still has saved policies with both switches off.
        s.emergency.signal();
        service.consume_emergency(&mut s);
        let generation = s.policy_generation.clone();
        assert!(!generation.is_empty());
        assert!(s.peer_policies["device"]["diagnostics.read"] == policy::Decision::Ask);
        assert!(s.peer_policies["device"]["shell.execute"] == policy::Decision::Deny);
        service.configure_locked(&mut s, false, true);
        assert_eq!(s.policy_generation, generation);
        assert!(s.peer_policies["device"]["diagnostics.read"] == policy::Decision::Ask);
    }

    #[test]
    fn unavailable_listener_cancels_work_without_changing_saved_policies() {
        let service = Service::default();
        let mut s = service.state.lock().unwrap();
        s.enabled = true;
        s.peer_policies.insert(
            "device".into(),
            HashMap::from([("shell.execute".into(), policy::Decision::Allow)]),
        );
        service.update_native_error(&mut s, Some("input desktop unavailable".into()));
        service.update_native_error(&mut s, Some("input desktop unavailable".into()));
        assert!(s.policy_generation.is_empty());
        assert!(s.peer_policies["device"]["shell.execute"] == policy::Decision::Allow);
        assert_eq!(s.audit.len(), 1);
        let p = Principal {
            id: "device".into(),
            kind: "peer".into(),
            label: "Device".into(),
            generation: None,
        };
        let call = Call {
            name: "commands.run".into(),
            source: None,
            arguments: json!({"target":"local"}),
        };
        assert!(!Service::call_enabled(&s, &p, &call));
        service.update_native_error(&mut s, None);
        assert!(Service::call_enabled(&s, &p, &call));
        assert!(s.policy_generation.is_empty());
    }
}
impl Emergency {
    pub fn pending(&self) -> bool {
        self.pending.load(Ordering::Acquire)
    }
    fn signal(&self) {
        self.pending.store(true, Ordering::Release);
        self.wake.notify_one();
    }
}
impl Service {
    pub fn emergency_observer(&self) -> Arc<dyn Fn() + Send + Sync> {
        let emergency = self.state.lock().unwrap().emergency.clone();
        Arc::new(move || emergency.signal())
    }
    pub(super) fn consume_emergency(&self, s: &mut State) {
        // Consume under the authority lock. A subsequent signal remains pending.
        if s.emergency.pending.swap(false, Ordering::AcqRel) {
            self.stop_locked(s);
        }
    }
    pub(super) fn stop_locked(&self, s: &mut State) {
        s.policy_generation = uuid::Uuid::new_v4().to_string();
        for policy in s.peer_policies.values_mut() {
            for decision in policy.values_mut() {
                if *decision == policy::Decision::Allow {
                    *decision = policy::Decision::Ask;
                }
            }
        }
        s.mcp_suspended = true;
        Self::audit_stop(s, "EMERGENCY_STOP");
        self.cancel_authority(s);
        // The page persists the same reset for offline devices as well. The
        // generation is checked on policy writes and retained across page reloads.
        if let Some(channel) = &s.channel {
            let _ = channel.send(json!({
                "kind": "policies-reset", "generation": s.policy_generation,
            }));
        }
    }

    pub(super) fn update_native_error(&self, s: &mut State, error: Option<String>) {
        if s.native_error == error {
            return;
        }
        s.native_error = error;
        if let Some(error) = s.native_error.clone() {
            // An unavailable emergency listener is a runtime failure, not a
            // user revocation. Preserve saved decisions and reject native work.
            s.mcp_suspended = true;
            Self::audit_stop(s, &format!("EMERGENCY_LISTENER_UNAVAILABLE: {error}"));
            self.cancel_authority(s);
        }
    }

    fn audit_stop(s: &mut State, reason: &str) {
        s.audit.push(json!({
            "id": uuid::Uuid::new_v4().to_string(), "at": now(),
            "principal": "Weblink", "tool": "automation.stop",
            "target": "local", "status": reason,
        }));
        if s.audit.len() > 1000 {
            s.audit.remove(0);
        }
    }

    fn cancel_authority(&self, s: &mut State) {
        s.grants.clear();
        Self::cancel_all(s);
        *self.input_holds.lock().unwrap() = input_holds::Holds::default();
        self.jobs.stop();
    }
}
