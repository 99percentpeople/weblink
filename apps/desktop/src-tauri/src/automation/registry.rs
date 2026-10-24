//! Local MCP credentials only. Remote devices have a separate identity and policy.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Client {
    pub id: String,
    pub label: String,
    pub token_hash: String,
    pub prefix: String,
    pub created_at: u64,
    pub expires_at: Option<u64>,
}
impl Client {
    pub fn active(&self) -> bool {
        self.expires_at.is_none_or(|at| at > now())
    }
    pub fn principal(&self) -> Principal {
        Principal {
            id: self.id.clone(),
            label: self.label.clone(),
            kind: "mcp".into(),
            generation: None,
        }
    }
    pub fn summary(&self) -> Value {
        json!({"id":self.id,"label":self.label,"prefix":self.prefix,"createdAt":self.created_at,"expiresAt":self.expires_at,"expired":!self.active()})
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registry {
    pub version: u32,
    #[serde(default = "server::default_host")]
    pub host: std::net::IpAddr,
    #[serde(
        default = "server::default_port",
        deserialize_with = "server::read_port"
    )]
    pub port: u16,
    pub clients: HashMap<String, Client>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            version: 1,
            host: server::default_host(),
            port: server::DEFAULT_PORT,
            clients: HashMap::new(),
        }
    }
}
pub fn digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
fn expiration(value: Option<u64>) -> Result<Option<u64>, String> {
    if value.is_some_and(|v| v <= now() || v > 253402300799999) {
        return Err("INVALID_EXPIRATION".into());
    }
    Ok(value)
}
pub(super) fn validate(r: &Registry) -> Result<(), String> {
    if r.version != 1 || r.port == 0 || r.clients.len() > 64 {
        return Err("INVALID_AUTOMATION_REGISTRY".into());
    }
    server::ServerConfig {
        host: r.host.to_string(),
        port: r.port,
    }
    .address()
    .map_err(|_| "INVALID_AUTOMATION_REGISTRY")?;
    for (id, c) in &r.clients {
        if id != &c.id
            || id.is_empty()
            || id.len() > 128
            || c.label.trim().is_empty()
            || c.label.len() > 128
            || c.token_hash.len() != 64
            || !c.token_hash.bytes().all(|v| v.is_ascii_hexdigit())
            || c.prefix.len() > 16
            || c.expires_at.is_some_and(|v| v > 253402300799999)
        {
            return Err("INVALID_AUTOMATION_REGISTRY".into());
        }
    }
    Ok(())
}
#[derive(Serialize)]
pub struct Prepared {
    pub revision: u64,
    pub registry: Registry,
    pub result: Value,
}
pub(super) enum Change {
    Server(server::ServerConfig),
    Create {
        label: String,
        expires_at: Option<u64>,
    },
    Update {
        id: String,
        label: String,
        expires_at: Option<u64>,
    },
    Remove {
        id: String,
    },
}
impl Service {
    // Prepare without changing active credentials. The renderer stores only
    // `registry` in localStorage, then applies it through the same page epoch.
    pub(super) fn prepare_registry(&self, epoch: &str, change: Change) -> Result<Prepared, String> {
        let s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        let mut registry = s.registry.clone();
        let result = match change {
            Change::Server(config) => {
                registry.host = config.address()?;
                registry.port = config.port;
                Value::Null
            }
            Change::Create { label, expires_at } => {
                let label = label.trim().to_string();
                if registry.clients.len() >= 64 || label.is_empty() || label.len() > 128 {
                    return Err("INVALID_ARGUMENTS".into());
                }
                let expires_at = expiration(expires_at)?;
                let mut secret = [0u8; 32];
                getrandom::fill(&mut secret).map_err(|_| "TOKEN_GENERATION_FAILED")?;
                let token = format!("sk-{}", URL_SAFE_NO_PAD.encode(secret));
                let id = uuid::Uuid::new_v4().to_string();
                registry.clients.insert(
                    id.clone(),
                    Client {
                        id: id.clone(),
                        label,
                        token_hash: digest(&token),
                        prefix: token[..11].into(),
                        created_at: now(),
                        expires_at,
                    },
                );
                let endpoint = if Self::current(&s) && !s.endpoint.is_empty() {
                    s.endpoint.clone()
                } else {
                    server::endpoint(registry.host, registry.port)
                };
                json!({"id":id,"token":token,"endpoint":endpoint})
            }
            Change::Update {
                id,
                label,
                expires_at,
            } => {
                let label = label.trim().to_string();
                if label.is_empty() || label.len() > 128 {
                    return Err("INVALID_ARGUMENTS".into());
                }
                let expires_at = expiration(expires_at)?;
                let client = registry.clients.get_mut(&id).ok_or("CLIENT_NOT_FOUND")?;
                client.label = label;
                client.expires_at = expires_at;
                Value::Null
            }
            Change::Remove { id } => {
                registry.clients.remove(&id).ok_or("CLIENT_NOT_FOUND")?;
                Value::Null
            }
        };
        Ok(Prepared {
            revision: s.registry_revision,
            registry,
            result,
        })
    }
    pub(super) fn apply_registry(
        &self,
        epoch: &str,
        revision: u64,
        registry: Registry,
    ) -> Result<(), String> {
        validate(&registry)?;
        let mut s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        if s.registry_revision != revision {
            return Err("REGISTRY_CHANGED".into());
        }
        let revoked: Vec<_> = s
            .registry
            .clients
            .iter()
            .filter(|(id, old)| {
                !old.active()
                    || registry
                        .clients
                        .get(*id)
                        .is_none_or(|new| !new.active() || new.token_hash != old.token_hash)
            })
            .map(|(id, _)| id.clone())
            .collect();
        s.registry = registry;
        s.registry_revision += 1;
        for id in revoked {
            self.revoke_client(&mut s, &id);
        }
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn stored_registry(&self) -> Registry {
        let json = serde_json::to_string(&self.state.lock().unwrap().registry).unwrap();
        serde_json::from_str(&json).unwrap()
    }
    #[cfg(test)]
    pub(super) fn load_registry(&self, registry: Registry) -> Result<(), String> {
        validate(&registry)?;
        self.state.lock().unwrap().registry = registry;
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn change_registry(&self, epoch: &str, change: Change) -> Result<Value, String> {
        let prepared = self.prepare_registry(epoch, change)?;
        self.apply_registry(epoch, prepared.revision, prepared.registry)?;
        Ok(prepared.result)
    }
    pub(super) fn principal_active(s: &State, p: &Principal) -> bool {
        match p.kind.as_str() {
            "mcp" => s.registry.clients.get(&p.id).is_some_and(Client::active),
            "peer" => s
                .peers
                .get(&p.id)
                .is_some_and(|current| current.generation == p.generation),
            _ => false,
        }
    }
    pub(super) fn grant_live(s: &State, g: &Grant) -> bool {
        s.page.live()
            && !s.emergency.pending()
            && g.expires_at.is_none_or(|at| at > now())
            && Self::principal_active(s, &g.principal)
            && if g.principal.kind == "mcp" {
                s.mcp_enabled && !s.mcp_suspended
            } else {
                (s.enabled || Self::diagnostic_grant(g))
                    && g.scopes.iter().all(|scope| {
                        let decision = Self::peer_decision(s, &g.principal, scope);
                        decision != policy::Decision::Deny
                            && (g.source == GrantSource::Consent
                                || decision == policy::Decision::Allow)
                    })
            }
    }
    #[cfg(test)]
    pub(super) fn create_client(
        &self,
        epoch: &str,
        label: String,
        expires_at: Option<u64>,
    ) -> Result<Value, String> {
        self.change_registry(epoch, Change::Create { label, expires_at })
    }
    #[cfg(test)]
    pub(super) fn update_client(
        &self,
        epoch: &str,
        id: &str,
        label: String,
        expires_at: Option<u64>,
    ) -> Result<(), String> {
        self.change_registry(
            epoch,
            Change::Update {
                id: id.into(),
                label,
                expires_at,
            },
        )
        .map(|_| ())
    }
    #[cfg(test)]
    pub(super) fn remove_client(&self, epoch: &str, id: &str) -> Result<(), String> {
        self.change_registry(epoch, Change::Remove { id: id.into() })
            .map(|_| ())
    }
    fn revoke_client(&self, s: &mut State, id: &str) {
        let ids: Vec<_> = s
            .grants
            .values()
            .filter(|g| g.principal.kind == "mcp" && g.principal.id == id)
            .map(|g| g.id.clone())
            .collect();
        for id in ids {
            self.revoke_locked(s, &id);
        }
        let pending: Vec<_> = s
            .pending
            .iter()
            .filter(|(_, p)| p.principal.kind == "mcp" && p.principal.id == id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in pending {
            Self::cancel_request(s, &id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn start(service: &Service) {
        let mut s = service.state.lock().unwrap();
        s.enabled = true;
        s.mcp_enabled = true;
        s.epoch = "epoch".into();
    }
    #[test]
    fn prepared_credentials_are_inactive_until_saved_and_applied() {
        let service = Service::default();
        start(&service);
        let prepared = service
            .prepare_registry(
                "epoch",
                Change::Create {
                    label: "Agent".into(),
                    expires_at: None,
                },
            )
            .unwrap();
        let token = prepared.result["token"].as_str().unwrap();
        assert!(service.authenticate(token).is_none());
        let stored = serde_json::to_string(&prepared.registry).unwrap();
        assert!(!stored.contains(token));
        assert!(stored.contains(&digest(token)));
        let candidate = serde_json::from_str(&stored).unwrap();
        service
            .apply_registry("epoch", prepared.revision, candidate)
            .unwrap();
        assert!(service.authenticate(token).is_some());
        assert_eq!(
            service
                .apply_registry("epoch", prepared.revision, prepared.registry)
                .unwrap_err(),
            "REGISTRY_CHANGED"
        );
    }
    #[test]
    fn stale_prepared_changes_cannot_restore_a_deleted_token_or_cross_pages() {
        let service = Service::default();
        start(&service);
        let token = service
            .create_client("epoch", "Agent".into(), None)
            .unwrap();
        let id = token["id"].as_str().unwrap();
        let old = service
            .prepare_registry(
                "epoch",
                Change::Update {
                    id: id.into(),
                    label: "Old edit".into(),
                    expires_at: None,
                },
            )
            .unwrap();
        service.remove_client("epoch", id).unwrap();
        assert_eq!(
            service
                .apply_registry("epoch", old.revision, old.registry.clone())
                .unwrap_err(),
            "REGISTRY_CHANGED"
        );
        service.shutdown();
        service.state.lock().unwrap().epoch = "new-page".into();
        assert_eq!(
            service
                .apply_registry("epoch", old.revision, old.registry)
                .unwrap_err(),
            "SESSION_CLOSED"
        );
        assert!(service.stored_registry().clients.is_empty());
    }
    #[test]
    fn new_credentials_use_compact_sk_tokens_and_authenticate_the_whole_secret() {
        let service = Service::default();
        start(&service);
        let mut tokens = Vec::new();
        for _ in 0..2 {
            let saved = service
                .create_client("epoch", "Agent".into(), None)
                .unwrap();
            let token = saved["token"].as_str().unwrap();
            let payload = token.strip_prefix("sk-").unwrap();
            assert_eq!(token.len(), 46);
            assert!(payload
                .bytes()
                .all(|v| v.is_ascii_alphanumeric() || v == b'-' || v == b'_'));
            assert_eq!(URL_SAFE_NO_PAD.decode(payload).unwrap().len(), 32);
            let id = saved["id"].as_str().unwrap();
            assert_eq!(service.authenticate(token).unwrap().id, id);
            assert!(service.authenticate(payload).is_none());
            let last = if token.ends_with('A') { 'B' } else { 'A' };
            assert!(service
                .authenticate(&format!("{}{last}", &token[..45]))
                .is_none());
            let summary = service.state.lock().unwrap().registry.clients[id].summary();
            assert_eq!(summary["prefix"], &token[..11]);
            assert!(summary.get("token").is_none());
            assert!(!summary.to_string().contains(token));
            tokens.push(token.to_owned());
        }
        assert_ne!(tokens[0], tokens[1]);
    }

    #[test]
    fn legacy_hex_credentials_coexist_with_new_tokens_after_restart() {
        let legacy = "0123456789abcdef".repeat(4);
        let mut registry = Registry::default();
        registry.clients.insert(
            "legacy".into(),
            Client {
                id: "legacy".into(),
                label: "Existing agent".into(),
                token_hash: digest(&legacy),
                prefix: legacy[..8].into(),
                created_at: now(),
                expires_at: None,
            },
        );
        let service = Service::default();
        service.load_registry(registry).unwrap();
        start(&service);
        assert_eq!(service.authenticate(&legacy).unwrap().id, "legacy");
        let saved = service
            .create_client("epoch", "New agent".into(), None)
            .unwrap();
        let token = saved["token"].as_str().unwrap();
        assert!(token.starts_with("sk-"));
        service.shutdown();

        let next = Service::default();
        next.load_registry(service.stored_registry()).unwrap();
        start(&next);
        assert_eq!(next.authenticate(&legacy).unwrap().id, "legacy");
        assert_eq!(
            next.authenticate(token).unwrap().id,
            saved["id"].as_str().unwrap()
        );
        assert_eq!(
            next.stored_registry().clients["legacy"].prefix,
            &legacy[..8]
        );
        let persisted = serde_json::to_string(&next.stored_registry()).unwrap();
        assert!(!persisted.contains(&legacy));
        assert!(!persisted.contains(token));
    }

    #[tokio::test]
    async fn restart_reuses_endpoint_and_credentials() {
        let first = Arc::new(Service::default());
        start(&first);
        first
            .configure_server(
                "epoch",
                server::ServerConfig {
                    host: "127.0.0.1".into(),
                    port: std::net::TcpListener::bind("127.0.0.1:0")
                        .unwrap()
                        .local_addr()
                        .unwrap()
                        .port(),
                },
            )
            .unwrap();
        http::start(first.clone(), "epoch".into()).await.unwrap();
        let token = first.create_client("epoch", "Agent".into(), None).unwrap();
        first.shutdown();
        let second = Arc::new(Service::default());
        second.load_registry(first.stored_registry()).unwrap();
        start(&second);
        tokio::time::timeout(Duration::from_secs(3), async {
            while http::start(second.clone(), "epoch".into()).await.is_err() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            second.state.lock().unwrap().endpoint,
            token["endpoint"].as_str().unwrap()
        );
        assert!(second
            .authenticate(token["token"].as_str().unwrap())
            .is_some());
        second.shutdown();
    }
    #[test]
    fn credentials_persist_as_hashes_and_never_create_peer_authority() {
        let service = Service::default();
        start(&service);
        let saved = service
            .create_client("epoch", "Local agent".into(), None)
            .unwrap();
        let token = saved["token"].as_str().unwrap();
        let id = saved["id"].as_str().unwrap();
        let bytes = serde_json::to_string(&service.stored_registry()).unwrap();
        assert!(!bytes.contains(token));
        assert!(bytes.contains(&digest(token)));
        let p = service.authenticate(token).unwrap();
        assert_eq!(p.kind, "mcp");
        assert!(!Service::principal_active(
            &service.state.lock().unwrap(),
            &Principal {
                kind: "peer".into(),
                ..p
            }
        ));
        service.shutdown();
        assert!(service.authenticate(token).is_none());
        let next = Service::default();
        next.load_registry(service.stored_registry()).unwrap();
        start(&next);
        assert_eq!(next.authenticate(token).unwrap().id, id);
        next.update_client("epoch", id, "Renamed".into(), Some(now() + 86400000))
            .unwrap();
        assert_eq!(next.authenticate(token).unwrap().label, "Renamed");
        next.update_client("epoch", id, "Renamed".into(), None)
            .unwrap();
        assert!(next.stored_registry().clients[id].expires_at.is_none());
        next.remove_client("epoch", id).unwrap();
        assert!(next.authenticate(token).is_none());
        assert!(next.stored_registry().clients.is_empty());
    }
    #[test]
    fn expired_token_blocks_existing_grants_before_background_cleanup() {
        let service = Service::default();
        start(&service);
        let saved = service
            .create_client("epoch", "Agent".into(), Some(now() + 60000))
            .unwrap();
        let p = service
            .authenticate(saved["token"].as_str().unwrap())
            .unwrap();
        let (tx, rx) = oneshot::channel();
        {
            let mut s = service.state.lock().unwrap();
            s.grants.insert(
                "grant".into(),
                Grant {
                    target: "local".into(),
                    id: "grant".into(),
                    principal: p.clone(),
                    scopes: vec!["shell.execute".into()],
                    expires_at: Some(now() + 60000),
                    source: if p.kind == "mcp" {
                        GrantSource::Token
                    } else {
                        GrantSource::Consent
                    },
                },
            );
            s.pending.insert(
                "pending".into(),
                Pending {
                    principal: p.clone(),
                    scope: "shell.execute".into(),
                    call: Call {
                        source: None,
                        name: "commands.start".into(),
                        arguments: json!({"target":"local","script":"echo test"}),
                    },
                    deadline: Instant::now() + Duration::from_secs(60),
                    answer: tx,
                },
            );
            s.registry.clients.get_mut(&p.id).unwrap().expires_at = Some(now() - 1);
            assert!(!Service::grant_live(&s, &s.grants["grant"]));
        }
        assert!(service
            .authenticate(saved["token"].as_str().unwrap())
            .is_none());
        service.expire();
        assert!(service.state.lock().unwrap().grants.is_empty());
        assert!(service.state.lock().unwrap().pending.is_empty());
        assert!(rx.blocking_recv().is_err());
    }
    #[test]
    fn renewing_an_expired_token_invalidates_old_authority_even_before_cleanup_tick() {
        let service = Service::default();
        start(&service);
        let saved = service
            .create_client("epoch", "Agent".into(), None)
            .unwrap();
        let p = service
            .authenticate(saved["token"].as_str().unwrap())
            .unwrap();
        let (tx, rx) = oneshot::channel();
        {
            let mut s = service.state.lock().unwrap();
            s.grants.insert(
                "old".into(),
                Grant {
                    id: "old".into(),
                    target: "local".into(),
                    principal: p.clone(),
                    scopes: vec!["shell.execute".into()],
                    expires_at: Some(now() + 60000),
                    source: if p.kind == "mcp" {
                        GrantSource::Token
                    } else {
                        GrantSource::Consent
                    },
                },
            );
            s.pending.insert(
                "pending".into(),
                Pending {
                    principal: p.clone(),
                    scope: "shell.execute".into(),
                    call: Call {
                        source: None,
                        name: "commands.start".into(),
                        arguments: json!({"target":"local","script":"echo ok"}),
                    },
                    deadline: Instant::now() + Duration::from_secs(60),
                    answer: tx,
                },
            );
            s.registry.clients.get_mut(&p.id).unwrap().expires_at = Some(now() - 1);
        }
        service
            .update_client("epoch", &p.id, "Renewed".into(), None)
            .unwrap();
        assert!(service
            .authenticate(saved["token"].as_str().unwrap())
            .is_some());
        assert!(service.state.lock().unwrap().grants.is_empty());
        assert!(service.state.lock().unwrap().pending.is_empty());
        assert!(rx.blocking_recv().is_err());
    }
    #[test]
    fn invalid_expiry_and_corrupt_registry_fail_closed() {
        let service = Service::default();
        start(&service);
        for expiry in [0, now() - 1, u64::MAX] {
            assert!(service
                .create_client("epoch", "Agent".into(), Some(expiry))
                .is_err());
        }
        assert!(serde_json::from_str::<Registry>("corrupt").is_err());
        let mut invalid = Registry::default();
        invalid.version = 2;
        assert!(service.load_registry(invalid).is_err());
        assert!(service.state.lock().unwrap().registry.clients.is_empty());
    }
    #[test]
    fn deleting_local_token_preserves_remote_permissions_and_cancels_local_tickets() {
        let service = Service::default();
        start(&service);
        let token = service
            .create_client("epoch", "Agent".into(), None)
            .unwrap();
        let local = service
            .authenticate(token["token"].as_str().unwrap())
            .unwrap();
        let peer = Principal {
            id: "remote".into(),
            label: "Device".into(),
            kind: "peer".into(),
            generation: Some("connection-1".into()),
        };
        let (tx, rx) = oneshot::channel();
        {
            let mut s = service.state.lock().unwrap();
            s.peers.insert(peer.id.clone(), peer.clone());
            for p in [&local, &peer] {
                s.grants.insert(
                    p.id.clone(),
                    Grant {
                        id: p.id.clone(),
                        target: "local".into(),
                        principal: p.clone(),
                        scopes: vec!["diagnostics.read".into()],
                        expires_at: Some(now() + 60000),
                        source: if p.kind == "mcp" {
                            GrantSource::Token
                        } else {
                            GrantSource::Consent
                        },
                    },
                );
            }
            s.tickets.insert(
                "ticket".into(),
                Ticket {
                    principal: local.clone(),
                    call: Call {
                        source: None,
                        name: "diagnostics.snapshot".into(),
                        arguments: json!({"target":"local"}),
                    },
                    grant: local.id.clone(),
                    deadline: Instant::now() + Duration::from_secs(60),
                    answer: tx,
                    used: false,
                },
            );
        }
        service.remove_client("epoch", &local.id).unwrap();
        let s = service.state.lock().unwrap();
        assert_eq!(s.grants.len(), 1);
        assert!(Service::grant_live(&s, &s.grants[&peer.id]));
        assert!(s.tickets.is_empty());
        assert!(rx.blocking_recv().is_err());
    }
}
