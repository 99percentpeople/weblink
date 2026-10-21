//! Main-UI policies for the current verified peer channel. Never accepted over MCP/P2P.
use super::*;

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    #[default]
    Ask,
    Allow,
    Deny,
}
pub type PeerPolicy = HashMap<String, Decision>;

impl Service {
    pub(super) fn peer_decision(s: &State, p: &Principal, scope: &str) -> Decision {
        if p.kind != "peer" || !Self::principal_active(s, p) {
            return Decision::Ask;
        }
        let decision = s
            .peer_policies
            .get(&p.id)
            .and_then(|v| v.get(scope))
            .copied()
            .unwrap_or_default();
        if s.policies_suspended && decision == Decision::Allow {
            Decision::Ask
        } else {
            decision
        }
    }

    pub(super) fn policy_grant(s: &mut State, p: &Principal, scope: &str) {
        if s.grants.values().any(|g| {
            g.principal.id == p.id
                && g.principal.kind == p.kind
                && g.target == "local"
                && g.scopes.iter().any(|v| v == scope)
                && Self::grant_live(s, g)
        }) {
            return;
        }
        let scopes: Vec<String> = catalog::permission_scopes(scope)
            .iter()
            .filter(|member| Self::peer_decision(s, p, member) == Decision::Allow)
            .cloned()
            .collect();
        if !scopes.iter().any(|member| member == scope) {
            return;
        }
        let id = uuid::Uuid::new_v4().to_string();
        s.grants.insert(
            id.clone(),
            Grant {
                id,
                principal: p.clone(),
                target: "local".into(),
                scopes,
                expires_at: None,
            },
        );
    }

    pub(super) fn pause_policies(&self, s: &mut State) {
        s.policies_suspended = true;
        let grants: Vec<_> = s
            .grants
            .values()
            .filter(|g| g.expires_at.is_none())
            .map(|g| g.id.clone())
            .collect();
        for id in grants {
            self.revoke_locked(s, &id);
        }
    }

    pub(super) fn set_peer_policy(
        &self,
        epoch: &str,
        peer: &peers::Identity,
        policy: PeerPolicy,
    ) -> Result<(), String> {
        if policy.keys().any(|scope| {
            !catalog::tools()
                .iter()
                .any(|tool| tool["scope"] == scope.as_str())
        }) {
            return Err("INVALID_ARGUMENTS".into());
        }
        let mut s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        let principal = Self::peer_principal(&s, peer)?;
        let id = peer.id.as_str();
        if !Self::current(&s) || principal.kind != "peer" {
            return Err("SESSION_CLOSED".into());
        }
        let previous = s
            .peer_policies
            .insert(id.into(), policy.clone())
            .unwrap_or_default();
        let changed = |scope: &str| {
            previous.get(scope).copied().unwrap_or_default()
                != policy.get(scope).copied().unwrap_or_default()
        };
        let grants: Vec<_> = s
            .grants
            .values()
            .filter(|g| {
                g.principal.kind == "peer"
                    && g.principal.id == id
                    && g.scopes.iter().any(|scope| changed(scope))
            })
            .map(|g| g.id.clone())
            .collect();
        for grant in grants {
            self.revoke_locked(&mut s, &grant);
        }
        let pending: Vec<_> = s
            .pending
            .iter()
            .filter(|(_, p)| {
                p.principal.kind == "peer" && p.principal.id == id && changed(&p.scope)
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in pending {
            let p = s.pending.remove(&key).unwrap();
            let allow = p.deadline > Instant::now()
                && Self::peer_decision(&s, &principal, &p.scope) == Decision::Allow
                && p.call.arguments["target"] == "local";
            if allow {
                Self::policy_grant(&mut s, &principal, &p.scope);
            }
            let _ = p.answer.send(allow);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Shared, Principal) {
        let service = Arc::new(Service::default());
        let p = Principal {
            id: "paired-channel".into(),
            label: "Device".into(),
            kind: "peer".into(),
            generation: Some("connection-1".into()),
        };
        {
            let mut s = service.state.lock().unwrap();
            s.enabled = true;
            s.epoch = "epoch".into();
            s.heartbeat = Some(Instant::now());
            s.channel = Some(Channel::new(|_| Ok(())));
            s.peers.insert(p.id.clone(), p.clone());
        }
        (service, p)
    }
    fn policy(decision: Decision) -> PeerPolicy {
        HashMap::from([("diagnostics.read".into(), decision)])
    }
    fn call() -> Call {
        Call {
            source: None,
            name: "diagnostics.snapshot".into(),
            arguments: json!({"target":"local"}),
        }
    }
    #[test]
    fn permanent_group_consent_reuses_one_grant_and_preserves_legacy_ask_and_deny() {
        let (service, p) = fixture();
        let mut policy: PeerPolicy = catalog::permission_scopes("diagnostics.read")
            .iter()
            .map(|scope| (scope.clone(), Decision::Allow))
            .collect();
        service
            .set_peer_policy("epoch", &peers::Identity::from(&p), policy.clone())
            .unwrap();
        {
            let mut s = service.state.lock().unwrap();
            for scope in catalog::permission_scopes("diagnostics.read") {
                Service::policy_grant(&mut s, &p, scope);
            }
            assert_eq!(s.grants.len(), 1);
            assert_eq!(
                s.grants.values().next().unwrap().scopes,
                catalog::permission_scopes("diagnostics.read")
            );
        }
        policy.insert("screen.read".into(), Decision::Deny);
        policy.insert("accessibility.read".into(), Decision::Ask);
        service
            .set_peer_policy("epoch", &peers::Identity::from(&p), policy)
            .unwrap();
        let mut s = service.state.lock().unwrap();
        assert!(s.grants.is_empty());
        Service::policy_grant(&mut s, &p, "diagnostics.read");
        assert_eq!(
            s.grants.values().next().unwrap().scopes,
            vec!["diagnostics.read"]
        );
    }
    async fn until(check: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !check() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn permanent_policy_executes_without_prompt_and_deny_cancels_existing_tickets() {
        let (service, p) = fixture();
        service
            .set_peer_policy("epoch", &peers::Identity::from(&p), policy(Decision::Allow))
            .unwrap();
        let task = tokio::spawn(service.clone().invoke(p.clone(), "request".into(), call()));
        until(|| {
            service
                .state
                .lock()
                .unwrap()
                .tickets
                .contains_key("request")
        })
        .await;
        {
            let s = service.state.lock().unwrap();
            assert!(s.pending.is_empty());
            assert_eq!(s.grants.len(), 1);
            assert!(s
                .grants
                .values()
                .all(|g| g.expires_at.is_none() && Service::grant_live(&s, g)));
        }
        service
            .set_peer_policy("epoch", &peers::Identity::from(&p), policy(Decision::Deny))
            .unwrap();
        assert_eq!(task.await.unwrap()["error"]["code"], "CANCELLED");
        assert!(service.state.lock().unwrap().grants.is_empty());
        assert_eq!(
            service.clone().invoke(p, "denied".into(), call()).await["error"]["code"],
            "PERMISSION_DENIED"
        );
    }
    #[tokio::test]
    async fn editing_an_ask_policy_resolves_only_that_peers_pending_request() {
        let (service, p) = fixture();
        let task = tokio::spawn(service.clone().invoke(p.clone(), "request".into(), call()));
        until(|| {
            service
                .state
                .lock()
                .unwrap()
                .pending
                .contains_key("request")
        })
        .await;
        service
            .set_peer_policy("epoch", &peers::Identity::from(&p), policy(Decision::Allow))
            .unwrap();
        until(|| {
            service
                .state
                .lock()
                .unwrap()
                .tickets
                .contains_key("request")
        })
        .await;
        // An unrelated scope edit must not revoke this grant.
        let mut changed = policy(Decision::Allow);
        changed.insert("shell.execute".into(), Decision::Deny);
        service
            .set_peer_policy("epoch", &peers::Identity::from(&p), changed)
            .unwrap();
        assert!(service
            .state
            .lock()
            .unwrap()
            .tickets
            .contains_key("request"));
        service
            .set_peer_policy("epoch", &peers::Identity::from(&p), PeerPolicy::new())
            .unwrap();
        assert_eq!(task.await.unwrap()["error"]["code"], "CANCELLED");
    }
    #[tokio::test]
    async fn suspended_policies_cannot_reauthorize_after_stop_or_reconnect() {
        let (service, p) = fixture();
        service
            .set_peer_policy("epoch", &peers::Identity::from(&p), policy(Decision::Allow))
            .unwrap();
        {
            let mut s = service.state.lock().unwrap();
            Service::policy_grant(&mut s, &p, "diagnostics.read");
            service.pause_policies(&mut s);
            assert!(s.grants.is_empty());
            assert!(s.peer_policies.contains_key(&p.id));
            assert!(Service::peer_decision(&s, &p, "diagnostics.read") == Decision::Ask);
        }
        // Resubmitting the saved policy must not bypass an emergency pause.
        service
            .set_peer_policy("epoch", &peers::Identity::from(&p), policy(Decision::Allow))
            .unwrap();
        let task = tokio::spawn(service.clone().invoke(p, "request".into(), call()));
        until(|| {
            service
                .state
                .lock()
                .unwrap()
                .pending
                .contains_key("request")
        })
        .await;
        service.shutdown();
        assert_eq!(task.await.unwrap()["error"]["code"], "CANCELLED");
    }
    #[tokio::test]
    async fn stale_or_lookalike_peer_identity_does_not_inherit_policy() {
        let (service, p) = fixture();
        service
            .set_peer_policy("epoch", &peers::Identity::from(&p), policy(Decision::Allow))
            .unwrap();
        let other = Principal {
            id: "other-channel".into(),
            ..p.clone()
        };
        {
            let mut s = service.state.lock().unwrap();
            Service::policy_grant(&mut s, &p, "diagnostics.read");
            s.peers.remove(&p.id);
            s.peers.insert(other.id.clone(), other.clone());
            assert!(!Service::grant_live(&s, s.grants.values().next().unwrap()));
            assert!(Service::peer_decision(&s, &other, "diagnostics.read") == Decision::Ask);
        }
        assert!(service
            .set_peer_policy("epoch", &peers::Identity::from(&p), policy(Decision::Allow))
            .is_err());
        assert_eq!(
            service.clone().invoke(p, "stale".into(), call()).await["error"]["code"],
            "SESSION_CLOSED"
        );
        let task = tokio::spawn(service.clone().invoke(other, "new".into(), call()));
        until(|| service.state.lock().unwrap().pending.contains_key("new")).await;
        service.shutdown();
        assert_eq!(task.await.unwrap()["error"]["code"], "CANCELLED");
    }
    #[tokio::test]
    async fn policies_are_scoped_cannot_forward_and_never_authorize_mcp_tokens() {
        let (service, p) = fixture();
        service
            .set_peer_policy("epoch", &peers::Identity::from(&p), policy(Decision::Allow))
            .unwrap();
        let s = service.state.lock().unwrap();
        let mcp = Principal {
            kind: "mcp".into(),
            ..p.clone()
        };
        assert!(Service::peer_decision(&s, &mcp, "diagnostics.read") == Decision::Ask);
        assert!(Service::peer_decision(&s, &p, "shell.execute") == Decision::Ask);
        drop(s);
        assert!(service
            .set_peer_policy(
                "epoch",
                &peers::Identity::from(&p),
                HashMap::from([("made.up".into(), Decision::Allow)])
            )
            .is_err());
        assert!(service
            .set_peer_policy(
                "old-epoch",
                &peers::Identity::from(&p),
                policy(Decision::Allow)
            )
            .is_err());
        let mut remote = call();
        remote.arguments["target"] = json!("third-device");
        assert_eq!(
            service.invoke(p, "remote".into(), remote).await["error"]["code"],
            "PERMISSION_DENIED"
        );
    }
    #[tokio::test]
    async fn denying_shell_stops_owned_jobs_without_affecting_other_scopes() {
        let (service, p) = fixture();
        let saved = HashMap::from([
            ("shell.execute".into(), Decision::Allow),
            ("diagnostics.read".into(), Decision::Allow),
        ]);
        service
            .set_peer_policy("epoch", &peers::Identity::from(&p), saved)
            .unwrap();
        let grant = {
            let mut s = service.state.lock().unwrap();
            Service::policy_grant(&mut s, &p, "shell.execute");
            Service::policy_grant(&mut s, &p, "diagnostics.read");
            s.grants
                .values()
                .find(|g| g.scopes[0] == "shell.execute")
                .unwrap()
                .id
                .clone()
        };
        let script = if cfg!(windows) {
            "Start-Sleep -Seconds 30"
        } else {
            "sleep 30"
        };
        service
            .jobs
            .start(&p.id, &grant, &json!({"script":script}))
            .unwrap();
        service
            .set_peer_policy(
                "epoch",
                &peers::Identity::from(&p),
                HashMap::from([
                    ("shell.execute".into(), Decision::Deny),
                    ("diagnostics.read".into(), Decision::Allow),
                ]),
            )
            .unwrap();
        until(|| {
            service
                .jobs
                .list()
                .iter()
                .all(|job| job["status"] != "running")
        })
        .await;
        let s = service.state.lock().unwrap();
        assert_eq!(s.grants.len(), 1);
        assert_eq!(
            s.grants.values().next().unwrap().scopes[0],
            "diagnostics.read"
        );
        assert!(!s.policies_suspended);
    }
}
