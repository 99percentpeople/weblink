//! Local MCP credentials only. Remote devices have a separate identity and policy.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

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
fn validate(r: &Registry) -> Result<(), String> {
    if r.version != 1 || r.port == 0 || r.clients.len() > 64 {
        return Err("INVALID_AUTOMATION_REGISTRY".into());
    }
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
fn read(path: &Path) -> Result<Registry, String> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Registry::default()),
        Err(_) => return Err("AUTOMATION_STORAGE_UNAVAILABLE".into()),
    };
    let mut bytes = Vec::new();
    file.take(512 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "AUTOMATION_STORAGE_UNAVAILABLE")?;
    if bytes.len() > 512 * 1024 {
        return Err("INVALID_AUTOMATION_REGISTRY".into());
    }
    let registry = serde_json::from_slice(&bytes).map_err(|_| "INVALID_AUTOMATION_REGISTRY")?;
    validate(&registry)?;
    Ok(registry)
}
fn write(path: &Path, registry: &Registry) -> Result<(), String> {
    validate(registry)?;
    let parent = path.parent().ok_or("AUTOMATION_STORAGE_UNAVAILABLE")?;
    std::fs::create_dir_all(parent).map_err(|_| "AUTOMATION_STORAGE_UNAVAILABLE")?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "AUTOMATION_STORAGE_UNAVAILABLE")?;
    temp.write_all(&serde_json::to_vec(registry).map_err(|_| "INVALID_AUTOMATION_REGISTRY")?)
        .map_err(|_| "AUTOMATION_STORAGE_UNAVAILABLE")?;
    temp.as_file()
        .sync_all()
        .map_err(|_| "AUTOMATION_STORAGE_UNAVAILABLE")?;
    temp.persist(path)
        .map_err(|_| "AUTOMATION_STORAGE_UNAVAILABLE")?;
    Ok(())
}
impl Service {
    pub fn load_registry(&self, path: PathBuf) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        if s.registry_path.is_none() {
            s.registry = read(&path)?;
            s.registry_path = Some(path);
        }
        Ok(())
    }
    pub(super) fn commit_registry(s: &mut State, registry: Registry) -> Result<(), String> {
        if let Some(path) = &s.registry_path {
            write(path, &registry)?;
        }
        s.registry = registry;
        Ok(())
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
        g.expires_at.is_none_or(|at| at > now())
            && Self::principal_active(s, &g.principal)
            && if g.principal.kind == "mcp" {
                !s.policies_suspended
            } else {
                g.scopes.iter().all(|scope| {
                    let decision = Self::peer_decision(s, &g.principal, scope);
                    decision != policy::Decision::Deny
                        && (g.expires_at.is_some() || decision == policy::Decision::Allow)
                })
            }
    }
    pub(super) fn create_client(
        &self,
        epoch: &str,
        label: String,
        expires_at: Option<u64>,
    ) -> Result<Value, String> {
        let mut s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        let label = label.trim().to_string();
        if s.registry.clients.len() >= 64 || label.is_empty() || label.len() > 128 {
            return Err("INVALID_ARGUMENTS".into());
        }
        let expires_at = expiration(expires_at)?;
        let id = uuid::Uuid::new_v4().to_string();
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let client = Client {
            id: id.clone(),
            label,
            token_hash: digest(&token),
            prefix: token[..8].into(),
            created_at: now(),
            expires_at,
        };
        let mut registry = s.registry.clone();
        registry.clients.insert(id.clone(), client);
        Self::commit_registry(&mut s, registry)?;
        let endpoint = if Self::current(&s) && !s.endpoint.is_empty() {
            s.endpoint.clone()
        } else {
            server::endpoint(s.registry.host, s.registry.port)
        };
        Ok(json!({"id":id,"token":token,"endpoint":endpoint}))
    }
    pub(super) fn update_client(
        &self,
        epoch: &str,
        id: &str,
        label: String,
        expires_at: Option<u64>,
    ) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        let label = label.trim().to_string();
        if label.is_empty() || label.len() > 128 {
            return Err("INVALID_ARGUMENTS".into());
        }
        let expires_at = expiration(expires_at)?;
        let mut registry = s.registry.clone();
        let client = registry.clients.get_mut(id).ok_or("CLIENT_NOT_FOUND")?;
        let previous_expiry = client.expires_at;
        client.label = label;
        client.expires_at = expires_at;
        Self::commit_registry(&mut s, registry)?;
        // Renewal authenticates future requests; it must not revive authority
        // that expired before the periodic cleanup (or during the disk write).
        if previous_expiry.is_some_and(|at| at <= now()) {
            self.revoke_client(&mut s, id);
        }
        Ok(())
    }
    pub(super) fn remove_client(&self, epoch: &str, id: &str) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        let mut registry = s.registry.clone();
        registry.clients.remove(id).ok_or("CLIENT_NOT_FOUND")?;
        Self::commit_registry(&mut s, registry)?;
        self.revoke_client(&mut s, id);
        Ok(())
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
        s.epoch = "epoch".into();
        s.heartbeat = Some(Instant::now());
    }
    #[tokio::test]
    async fn restart_reuses_endpoint_and_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tokens.json");
        let first = Arc::new(Service::default());
        first.load_registry(path.clone()).unwrap();
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
        second.load_registry(path).unwrap();
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
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tokens.json");
        let service = Service::default();
        service.load_registry(path.clone()).unwrap();
        start(&service);
        let saved = service
            .create_client("epoch", "Local agent".into(), None)
            .unwrap();
        let token = saved["token"].as_str().unwrap();
        let id = saved["id"].as_str().unwrap();
        let bytes = std::fs::read_to_string(&path).unwrap();
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
        next.load_registry(path.clone()).unwrap();
        start(&next);
        assert_eq!(next.authenticate(token).unwrap().id, id);
        next.update_client("epoch", id, "Renamed".into(), Some(now() + 86400000))
            .unwrap();
        assert_eq!(next.authenticate(token).unwrap().label, "Renamed");
        next.update_client("epoch", id, "Renamed".into(), None)
            .unwrap();
        assert!(read(&path).unwrap().clients[id].expires_at.is_none());
        next.remove_client("epoch", id).unwrap();
        assert!(next.authenticate(token).is_none());
        assert!(read(&path).unwrap().clients.is_empty());
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
    fn invalid_expiry_corrupt_storage_and_failed_writes_fail_closed() {
        let service = Service::default();
        start(&service);
        for expiry in [0, now() - 1, u64::MAX] {
            assert!(service
                .create_client("epoch", "Agent".into(), Some(expiry))
                .is_err());
        }
        assert!(service.state.lock().unwrap().registry.clients.is_empty());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tokens.json");
        std::fs::write(&path, b"corrupt").unwrap();
        assert!(service.load_registry(path.clone()).is_err());
        assert!(service.state.lock().unwrap().registry_path.is_none());
        std::fs::remove_file(&path).unwrap();
        service.load_registry(path.clone()).unwrap();
        // A directory at the destination makes atomic replacement fail.
        std::fs::create_dir(&path).unwrap();
        assert!(service
            .create_client("epoch", "Agent".into(), None)
            .is_err());
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
