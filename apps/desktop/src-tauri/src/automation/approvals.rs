//! Timed consent is grouped by purpose while tickets retain exact tool scopes.
use super::*;

impl Service {
    pub(super) fn decide(&self, epoch: &str, id: &str, minutes: u32) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        let p = s.pending.remove(id).ok_or("REQUEST_EXPIRED")?;
        let group = catalog::permission_scopes(&p.scope);
        let scopes: Vec<String> = group
            .iter()
            .filter(|scope| Self::peer_decision(&s, &p.principal, scope) != policy::Decision::Deny)
            .cloned()
            .collect();
        let allow = Self::current(&s)
            && Self::call_enabled(&s, &p.principal, &p.call)
            && Self::principal_active(&s, &p.principal)
            && scopes.contains(&p.scope)
            && [5, 15, 60].contains(&minutes)
            && p.deadline > Instant::now();
        if allow {
            let id = uuid::Uuid::new_v4().to_string();
            s.grants.insert(
                id.clone(),
                Grant {
                    target: p.call.arguments["target"].as_str().unwrap_or("").into(),
                    id,
                    principal: p.principal.clone(),
                    scopes: scopes.clone(),
                    expires_at: Some(now() + minutes as u64 * 60000),
                },
            );
        }
        // A single review resolves concurrent requests in the same group only.
        let matching: Vec<_> = s
            .pending
            .iter()
            .filter(|(_, other)| {
                other.principal.id == p.principal.id
                    && other.principal.kind == p.principal.kind
                    && other.call.arguments["target"] == p.call.arguments["target"]
                    && group.contains(&other.scope)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in matching {
            let other = s.pending.remove(&id).unwrap();
            let permitted =
                allow && scopes.contains(&other.scope) && other.deadline > Instant::now();
            let _ = other.answer.send(permitted);
        }
        let _ = p.answer.send(allow);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Shared, Principal) {
        let service = Arc::new(Service::default());
        let principal = Principal {
            id: "verified-channel".into(),
            label: "Device".into(),
            kind: "peer".into(),
            generation: Some("connection-1".into()),
        };
        {
            let mut s = service.state.lock().unwrap();
            s.epoch = "epoch".into();
            s.enabled = true;
            s.channel = Some(Channel::new(|_| Ok(())));
            s.peers.insert(principal.id.clone(), principal.clone());
        }
        (service, principal)
    }

    fn pending(
        service: &Shared,
        principal: &Principal,
        id: &str,
        scope: &str,
        target: &str,
    ) -> oneshot::Receiver<bool> {
        let (answer, receiver) = oneshot::channel();
        service.state.lock().unwrap().pending.insert(
            id.into(),
            Pending {
                principal: principal.clone(),
                scope: scope.into(),
                call: Call {
                    name: "fixture".into(),
                    source: None,
                    arguments: json!({"target":target}),
                },
                deadline: Instant::now() + Duration::from_secs(120),
                answer,
            },
        );
        receiver
    }

    #[tokio::test]
    async fn notification_consent_preserves_duration_without_changing_saved_policies() {
        for minutes in [5, 15, 60] {
            let (service, principal) = fixture();
            let answer = pending(&service, &principal, "review", "shell.execute", "local");
            let before = now();
            service.decide("epoch", "review", minutes).unwrap();
            assert!(answer.await.unwrap());
            let mut s = service.state.lock().unwrap();
            let grant = s.grants.values().next().unwrap();
            let expires = grant.expires_at.unwrap();
            let duration = u64::from(minutes) * 60_000;
            assert!((before + duration..=now() + duration).contains(&expires));
            assert!(Service::grant_live(&s, grant));
            assert!(s.peer_policies.is_empty());
            assert!(
                Service::peer_decision(&s, &principal, "shell.execute") == policy::Decision::Ask
            );
            let id = grant.id.clone();
            s.grants.get_mut(&id).unwrap().expires_at = Some(now() - 1);
            drop(s);
            service.expire();
            assert!(service.state.lock().unwrap().grants.is_empty());
        }
    }

    #[tokio::test]
    async fn changing_device_policy_revokes_temporary_consent_without_global_pause() {
        for decision in [policy::Decision::Allow, policy::Decision::Deny] {
            let (service, principal) = fixture();
            let answer = pending(&service, &principal, "review", "shell.execute", "local");
            service.decide("epoch", "review", 15).unwrap();
            assert!(answer.await.unwrap());
            let id = service
                .state
                .lock()
                .unwrap()
                .grants
                .keys()
                .next()
                .unwrap()
                .clone();
            service
                .set_peer_policy(
                    "epoch",
                    &peers::Identity::from(&principal),
                    HashMap::from([("shell.execute".into(), decision)]),
                )
                .unwrap();
            let mut s = service.state.lock().unwrap();
            assert!(!s.grants.contains_key(&id));
            assert!(!s.policies_suspended);
            assert!(!s.mcp_suspended);
            Service::policy_grant(&mut s, &principal, "shell.execute");
            assert_eq!(
                s.grants.len(),
                usize::from(decision == policy::Decision::Allow)
            );
        }
    }

    #[tokio::test]
    async fn emergency_stop_clears_notification_reviews_and_temporary_consent() {
        let (service, principal) = fixture();
        let approved = pending(&service, &principal, "approved", "shell.execute", "local");
        service.decide("epoch", "approved", 15).unwrap();
        assert!(approved.await.unwrap());
        let waiting = pending(&service, &principal, "waiting", "input.control", "local");
        service.emergency_observer()();
        service.expire();
        assert!(waiting.await.is_err());
        assert_eq!(
            service.decide("epoch", "waiting", 15).unwrap_err(),
            "REQUEST_EXPIRED"
        );
        let s = service.state.lock().unwrap();
        assert!(s.grants.is_empty());
        assert!(s.pending.is_empty());
        assert!(s.policies_suspended);
        assert!(s.mcp_suspended);
    }

    #[tokio::test]
    async fn grouped_consent_keeps_other_principals_targets_and_groups_pending() {
        let (service, principal) = fixture();
        let first = pending(&service, &principal, "first", "diagnostics.read", "local");
        let screen = pending(&service, &principal, "screen", "screen.read", "local");
        let other = Principal {
            id: "another-channel".into(),
            ..principal.clone()
        };
        let mut other_peer = pending(&service, &other, "other", "diagnostics.read", "local");
        let mut remote = pending(&service, &principal, "remote", "diagnostics.read", "remote");
        let mut control = pending(&service, &principal, "control", "input.control", "local");
        let mut terminal = pending(&service, &principal, "terminal", "shell.execute", "local");
        service.decide("epoch", "first", 15).unwrap();
        assert!(first.await.unwrap());
        assert!(screen.await.unwrap());
        for receiver in [&mut other_peer, &mut remote, &mut control, &mut terminal] {
            assert!(matches!(
                receiver.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
        }
        let mut s = service.state.lock().unwrap();
        assert_eq!(s.grants.len(), 1);
        let grant = s.grants.values().next().unwrap();
        assert_eq!(grant.scopes, catalog::permission_scopes("diagnostics.read"));
        assert_eq!(grant.target, "local");
        let id = grant.id.clone();
        service.revoke_locked(&mut s, &id);
        assert!(s.grants.is_empty());
    }

    #[tokio::test]
    async fn legacy_denials_are_excluded_from_group_consent_and_pending_replies() {
        let (service, principal) = fixture();
        service
            .set_peer_policy(
                "epoch",
                &peers::Identity::from(&principal),
                HashMap::from([("screen.read".into(), policy::Decision::Deny)]),
            )
            .unwrap();
        let first = pending(&service, &principal, "first", "diagnostics.read", "local");
        let denied = pending(&service, &principal, "denied", "screen.read", "local");
        service.decide("epoch", "first", 5).unwrap();
        assert!(first.await.unwrap());
        assert!(!denied.await.unwrap());
        let s = service.state.lock().unwrap();
        let grant = s.grants.values().next().unwrap();
        assert!(grant.scopes.contains(&"accessibility.read".into()));
        assert!(!grant.scopes.contains(&"screen.read".into()));
    }

    #[tokio::test]
    async fn expired_disconnected_rejected_or_denied_requests_never_grant_a_group() {
        for reason in ["expired", "disconnected", "rejected", "denied"] {
            let (service, principal) = fixture();
            let answer = pending(&service, &principal, "first", "diagnostics.read", "local");
            let sibling = pending(&service, &principal, "second", "screen.read", "local");
            {
                let mut s = service.state.lock().unwrap();
                match reason {
                    "expired" => {
                        s.pending.get_mut("first").unwrap().deadline =
                            Instant::now() - Duration::from_secs(1)
                    }
                    "disconnected" => {
                        s.peers.clear();
                    }
                    "denied" => {
                        s.peer_policies.insert(
                            principal.id.clone(),
                            HashMap::from([("diagnostics.read".into(), policy::Decision::Deny)]),
                        );
                    }
                    _ => {}
                }
            }
            service
                .decide("epoch", "first", if reason == "rejected" { 0 } else { 15 })
                .unwrap();
            assert!(!answer.await.unwrap(), "{reason}");
            assert!(!sibling.await.unwrap(), "{reason}");
            assert!(service.state.lock().unwrap().grants.is_empty(), "{reason}");
        }
    }
}
