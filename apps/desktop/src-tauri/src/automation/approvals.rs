//! Consent is grouped by purpose while tickets retain exact tool scopes.
use super::*;

impl Service {
    #[cfg(test)]
    pub(super) fn decide(&self, epoch: &str, id: &str, accepted: bool) -> Result<(), String> {
        self.decide_remembered(epoch, id, accepted, false)
    }

    pub(super) fn decide_remembered(
        &self,
        epoch: &str,
        id: &str,
        accepted: bool,
        remember: bool,
    ) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        let p = s.pending.remove(id).ok_or("REQUEST_EXPIRED")?;
        let group = catalog::permission_scopes(&p.scope);
        if remember {
            if p.principal.kind != "peer"
                || p.call.arguments["target"] != "local"
                || !Self::current(&s)
                || !Self::call_enabled(&s, &p.principal, &p.call)
                || !Self::principal_active(&s, &p.principal)
                || p.deadline <= Instant::now()
                || Self::peer_decision(&s, &p.principal, &p.scope) == policy::Decision::Deny
            {
                let _ = p.answer.send(false);
                return Err("REQUEST_EXPIRED".into());
            }
            let decision = if accepted {
                policy::Decision::Allow
            } else {
                policy::Decision::Deny
            };
            let policy = s.peer_policies.entry(p.principal.id.clone()).or_default();
            let changed: Vec<_> = group
                .iter()
                .filter(|scope| policy.get(*scope).copied().unwrap_or_default() != decision)
                .cloned()
                .collect();
            for scope in group {
                policy.insert(scope.clone(), decision);
            }
            let grants: Vec<_> = s
                .grants
                .values()
                .filter(|grant| {
                    grant.principal.kind == "peer"
                        && grant.principal.id == p.principal.id
                        && grant.scopes.iter().any(|scope| changed.contains(scope))
                })
                .map(|grant| grant.id.clone())
                .collect();
            for id in grants {
                self.revoke_locked(&mut s, &id);
            }
        }
        let scopes: Vec<String> = group
            .iter()
            .filter(|scope| Self::peer_decision(&s, &p.principal, scope) != policy::Decision::Deny)
            .cloned()
            .collect();
        let allow = Self::current(&s)
            && Self::call_enabled(&s, &p.principal, &p.call)
            && Self::principal_active(&s, &p.principal)
            && scopes.contains(&p.scope)
            && accepted
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
                    expires_at: None,
                    source: GrantSource::Consent,
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
    async fn notification_consent_lasts_for_the_connection_without_changing_saved_policies() {
        let (service, principal) = fixture();
        let answer = pending(&service, &principal, "review", "shell.execute", "local");
        service.decide("epoch", "review", true).unwrap();
        assert!(answer.await.unwrap());
        service.expire();
        let previous = {
            let s = service.state.lock().unwrap();
            let grant = s.grants.values().next().unwrap();
            assert!(grant.expires_at.is_none());
            assert!(grant.source == GrantSource::Consent);
            assert!(Service::grant_live(&s, grant));
            assert!(s.peer_policies.is_empty());
            assert!(
                Service::peer_decision(&s, &principal, "shell.execute") == policy::Decision::Ask
            );
            grant.clone()
        };
        let old = peers::Identity::from(&principal);
        service.disconnect_peer("epoch", &old).unwrap();
        assert!(service.state.lock().unwrap().grants.is_empty());
        let replacement = peers::Identity {
            generation: "connection-2".into(),
            ..old.clone()
        };
        service
            .connect_peer("epoch", replacement.clone(), "Device".into())
            .unwrap();
        let s = service.state.lock().unwrap();
        assert!(!Service::grant_live(&s, &previous));
        let current = Service::peer_principal(&s, &replacement).unwrap();
        assert!(Service::peer_decision(&s, &current, "shell.execute") == policy::Decision::Ask);
        assert!(s.grants.is_empty());
    }

    #[tokio::test]
    async fn remembered_decisions_settle_the_group_and_survive_renderer_policy_sync() {
        for accepted in [true, false] {
            let (service, principal) = fixture();
            service
                .set_peer_policy(
                    "epoch",
                    &peers::Identity::from(&principal),
                    HashMap::from([
                        ("screen.read".into(), policy::Decision::Deny),
                        ("shell.execute".into(), policy::Decision::Deny),
                    ]),
                )
                .unwrap();
            let first = pending(&service, &principal, "first", "diagnostics.read", "local");
            let sibling = pending(&service, &principal, "sibling", "screen.read", "local");
            let _unrelated = pending(&service, &principal, "unrelated", "shell.execute", "local");
            service
                .decide_remembered("epoch", "first", accepted, true)
                .unwrap();
            assert_eq!(first.await.unwrap(), accepted);
            assert_eq!(sibling.await.unwrap(), accepted);
            let (saved, grant_ids) = {
                let s = service.state.lock().unwrap();
                let policy = s.peer_policies.get(&principal.id).unwrap();
                for scope in catalog::permission_scopes("diagnostics.read") {
                    assert!(
                        policy.get(scope)
                            == Some(&if accepted {
                                policy::Decision::Allow
                            } else {
                                policy::Decision::Deny
                            })
                    );
                }
                assert!(policy.get("shell.execute") == Some(&policy::Decision::Deny));
                assert!(s.pending.contains_key("unrelated"));
                (policy.clone(), s.grants.keys().cloned().collect::<Vec<_>>())
            };
            service
                .set_peer_policy("epoch", &peers::Identity::from(&principal), saved)
                .unwrap();
            let s = service.state.lock().unwrap();
            assert_eq!(s.grants.len(), grant_ids.len());
            assert!(grant_ids.iter().all(|id| s.grants.contains_key(id)));
        }
    }

    #[tokio::test]
    async fn stale_remembered_answers_never_change_device_policy() {
        for reason in [
            "expired",
            "disconnected",
            "disabled",
            "forwarded",
            "local-token",
        ] {
            let (service, mut principal) = fixture();
            if reason == "local-token" {
                principal.kind = "mcp".into();
            }
            let answer = pending(
                &service,
                &principal,
                "first",
                "diagnostics.read",
                if reason == "forwarded" {
                    "remote"
                } else {
                    "local"
                },
            );
            {
                let mut s = service.state.lock().unwrap();
                match reason {
                    "expired" => {
                        s.pending.get_mut("first").unwrap().deadline =
                            Instant::now() - Duration::from_secs(1)
                    }
                    "disconnected" => s.peers.clear(),
                    "disabled" => s.enabled = false,
                    _ => {}
                }
            }
            assert!(
                service
                    .decide_remembered("epoch", "first", true, true)
                    .is_err(),
                "{reason}"
            );
            assert!(!answer.await.unwrap(), "{reason}");
            let s = service.state.lock().unwrap();
            assert!(s.peer_policies.is_empty(), "{reason}");
            assert!(s.grants.is_empty(), "{reason}");
        }
    }

    #[tokio::test]
    async fn session_consent_ends_on_shutdown_or_automation_disable() {
        for shutdown in [false, true] {
            let (service, principal) = fixture();
            let answer = pending(&service, &principal, "review", "shell.execute", "local");
            service.decide("epoch", "review", true).unwrap();
            assert!(answer.await.unwrap());
            if shutdown {
                service.shutdown();
            } else {
                let mut s = service.state.lock().unwrap();
                service.configure_locked(&mut s, false, false);
                service.configure_locked(&mut s, false, true);
            }
            assert!(service.state.lock().unwrap().grants.is_empty());
        }
    }

    #[tokio::test]
    async fn session_consent_and_saved_policy_revocation_remain_independent() {
        for revoke_consent in [false, true] {
            let (service, principal) = fixture();
            service
                .set_peer_policy(
                    "epoch",
                    &peers::Identity::from(&principal),
                    HashMap::from([("diagnostics.read".into(), policy::Decision::Allow)]),
                )
                .unwrap();
            let answer = pending(&service, &principal, "review", "shell.execute", "local");
            service.decide("epoch", "review", true).unwrap();
            assert!(answer.await.unwrap());
            let mut s = service.state.lock().unwrap();
            Service::policy_grant(&mut s, &principal, "diagnostics.read");
            let consent = s
                .grants
                .values()
                .find(|g| g.source == GrantSource::Consent)
                .unwrap()
                .id
                .clone();
            let policy = s
                .grants
                .values()
                .find(|g| g.source == GrantSource::Policy)
                .unwrap()
                .id
                .clone();
            let (revoked, retained) = if revoke_consent {
                (&consent, &policy)
            } else {
                (&policy, &consent)
            };
            service.revoke_grant(&mut s, revoked);
            assert!(!s.grants.contains_key(revoked));
            assert!(Service::grant_live(&s, &s.grants[retained]));
            assert!(s.policy_generation.is_empty());
            assert!(!s.mcp_suspended);
            assert!(
                Service::peer_decision(&s, &principal, "diagnostics.read")
                    == policy::Decision::Allow
            );
        }
    }

    #[tokio::test]
    async fn changing_device_policy_revokes_session_consent_without_global_pause() {
        for decision in [policy::Decision::Allow, policy::Decision::Deny] {
            let (service, principal) = fixture();
            let answer = pending(&service, &principal, "review", "shell.execute", "local");
            service.decide("epoch", "review", true).unwrap();
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
            assert!(s.policy_generation.is_empty());
            assert!(!s.mcp_suspended);
            Service::policy_grant(&mut s, &principal, "shell.execute");
            assert_eq!(
                s.grants.len(),
                usize::from(decision == policy::Decision::Allow)
            );
        }
    }

    #[tokio::test]
    async fn emergency_stop_clears_notification_reviews_and_session_consent() {
        let (service, principal) = fixture();
        let approved = pending(&service, &principal, "approved", "shell.execute", "local");
        service.decide("epoch", "approved", true).unwrap();
        assert!(approved.await.unwrap());
        let waiting = pending(&service, &principal, "waiting", "input.control", "local");
        service.emergency_observer()();
        service.expire();
        assert!(waiting.await.is_err());
        assert_eq!(
            service.decide("epoch", "waiting", true).unwrap_err(),
            "REQUEST_EXPIRED"
        );
        let s = service.state.lock().unwrap();
        assert!(s.grants.is_empty());
        assert!(s.pending.is_empty());
        assert!(!s.policy_generation.is_empty());
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
        service.decide("epoch", "first", true).unwrap();
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
        service.decide("epoch", "first", true).unwrap();
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
                .decide("epoch", "first", reason != "rejected")
                .unwrap();
            assert!(!answer.await.unwrap(), "{reason}");
            assert!(!sibling.await.unwrap(), "{reason}");
            assert!(service.state.lock().unwrap().grants.is_empty(), "{reason}");
        }
    }
}
