//! Reuse verified device IDs; the shared connection generation fences reconnects.
use super::*;

#[derive(Clone, Deserialize)]
pub struct Identity {
    pub id: String,
    pub generation: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reconnect_reuses_device_id_but_not_authority_and_stale_cleanup_is_harmless() {
        let (service, _) = crate::automation::tests::fixture();
        let old = Identity {
            id: "paired-device".into(),
            generation: "connection-1".into(),
        };
        service
            .connect_peer("epoch", old.clone(), "Device".into())
            .unwrap();
        let principal = Service::peer_principal(&service.state.lock().unwrap(), &old).unwrap();
        assert_eq!(principal.id, old.id);
        let policy = HashMap::from([("diagnostics.read".into(), policy::Decision::Allow)]);
        service
            .set_peer_policy("epoch", &old, policy.clone())
            .unwrap();
        let task = tokio::spawn(service.clone().invoke(
            principal.clone(),
            "old-call".into(),
            Call {
                name: "diagnostics.snapshot".into(),
                source: None,
                arguments: json!({"target":"local"}),
            },
        ));
        tokio::time::timeout(Duration::from_secs(3), async {
            while !service
                .state
                .lock()
                .unwrap()
                .tickets
                .contains_key("old-call")
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let replacement = Identity {
            generation: "connection-2".into(),
            ..old.clone()
        };
        service
            .connect_peer("epoch", replacement.clone(), "Device".into())
            .unwrap();
        assert_eq!(task.await.unwrap()["error"]["code"], "CANCELLED");
        {
            let s = service.state.lock().unwrap();
            assert!(s.grants.is_empty());
            assert!(s.peer_policies.is_empty());
            assert!(!Service::principal_active(&s, &principal));
            assert!(Service::peer_principal(&s, &old).is_err());
        }
        assert!(service
            .set_peer_policy("epoch", &old, policy.clone())
            .is_err());
        service
            .set_peer_policy("epoch", &replacement, policy)
            .unwrap();
        service.disconnect_peer("epoch", &old).unwrap();
        {
            let s = service.state.lock().unwrap();
            assert!(Service::peer_principal(&s, &replacement).is_ok());
            assert!(s.peer_policies.contains_key(&replacement.id));
        }
        service.disconnect_peer("epoch", &replacement).unwrap();
        assert!(service.state.lock().unwrap().peers.is_empty());
    }
}

#[cfg(test)]
impl From<&Principal> for Identity {
    fn from(principal: &Principal) -> Self {
        Self {
            id: principal.id.clone(),
            generation: principal.generation.clone().unwrap(),
        }
    }
}

impl Service {
    pub(super) fn peer_principal(s: &State, peer: &Identity) -> Result<Principal, String> {
        s.peers
            .get(&peer.id)
            .filter(|p| p.generation.as_deref() == Some(peer.generation.as_str()))
            .cloned()
            .ok_or_else(|| "SESSION_CLOSED".into())
    }

    pub(super) fn connect_peer(
        &self,
        epoch: &str,
        peer: Identity,
        label: String,
    ) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        if !s.enabled
            || (s.peers.len() >= 32 && !s.peers.contains_key(&peer.id))
            || peer.id.is_empty()
            || peer.id.len() > 128
            || label.len() > 128
            || peer.generation.is_empty()
            || peer.generation.len() > 128
        {
            return Err("INVALID_ARGUMENTS".into());
        }
        if Self::peer_principal(&s, &peer).is_err() {
            self.remove_peer(&mut s, &peer.id);
        }
        s.peers.insert(
            peer.id.clone(),
            Principal {
                id: peer.id,
                label,
                kind: "peer".into(),
                generation: Some(peer.generation),
            },
        );
        Ok(())
    }

    pub(super) fn disconnect_peer(&self, epoch: &str, peer: &Identity) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        if Self::peer_principal(&s, peer).is_ok() {
            self.remove_peer(&mut s, &peer.id);
        }
        Ok(())
    }

    fn remove_peer(&self, s: &mut State, id: &str) {
        s.peers.remove(id);
        s.peer_policies.remove(id);
        let grants: Vec<_> = s
            .grants
            .values()
            .filter(|g| g.principal.kind == "peer" && g.principal.id == id)
            .map(|g| g.id.clone())
            .collect();
        for grant in grants {
            self.revoke_locked(s, &grant);
        }
        let pending: Vec<_> = s
            .pending
            .iter()
            .filter(|(_, p)| p.principal.kind == "peer" && p.principal.id == id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in pending {
            Self::cancel_request(s, &id);
        }
    }
}
