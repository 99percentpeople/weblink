mod accessibility;
mod approvals;
mod cancellation;
mod catalog;
mod command_run;
mod commands;
pub(crate) mod coordinates;
mod http;
mod input_action;
mod input_holds;
mod input_runner;
mod input_sequence;
mod jobs;
mod keyboard;
mod native;
mod native_read;
mod pointer;
mod policy;
mod registry;
mod server;
mod token_authority;
pub use commands::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub id: String,
    pub label: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Source {
    pub kind: String,
    pub label: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Call {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    pub name: String,
    pub arguments: Value,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    target: String,
    id: String,
    principal: Principal,
    scopes: Vec<String>,
    expires_at: Option<u64>,
}
struct Pending {
    principal: Principal,
    call: Call,
    scope: String,
    deadline: Instant,
    answer: oneshot::Sender<bool>,
}
struct Ticket {
    principal: Principal,
    call: Call,
    grant: String,
    deadline: Instant,
    answer: oneshot::Sender<Value>,
    used: bool,
}
#[derive(Default)]
struct State {
    epoch: String,
    heartbeat: Option<Instant>,
    enabled: bool,
    channel: Option<Channel<Value>>,
    endpoint: String,
    active_server: Option<server::ServerConfig>,
    registry: registry::Registry,
    registry_path: Option<std::path::PathBuf>,
    peers: HashMap<String, Principal>,
    peer_policies: HashMap<String, policy::PeerPolicy>,
    policies_suspended: bool,
    grants: HashMap<String, Grant>,
    pending: HashMap<String, Pending>,
    tickets: HashMap<String, Ticket>,
    requests: HashMap<String, String>,
    audit: Vec<Value>,
    listener: Option<CancellationToken>,
    input_owners: Vec<String>,
}
#[derive(Default)]
pub struct Service {
    state: Mutex<State>,
    opening: Mutex<()>,
    native_read: Mutex<()>,
    jobs: jobs::Jobs,
    input_queue: input_sequence::Queue,
    input_holds: Mutex<input_holds::Holds>,
    accessibility: weblink_desktop_accessibility::Client,
}
pub type Shared = Arc<Service>;
struct RequestCleanup {
    service: Shared,
    id: String,
    generation: String,
}
impl Drop for RequestCleanup {
    fn drop(&mut self) {
        let mut s = self.service.state.lock().unwrap();
        if s.requests.get(&self.id) == Some(&self.generation) {
            Service::cancel_request(&mut s, &self.id);
        }
    }
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn error(code: &str) -> Value {
    json!({"ok":false,"error":{"code":code,"message":code}})
}
impl Service {
    fn check(s: &State, epoch: &str) -> Result<(), String> {
        if s.epoch != epoch
            || s.heartbeat
                .is_none_or(|t| t.elapsed() > Duration::from_secs(20))
        {
            Err("SESSION_CLOSED".into())
        } else {
            Ok(())
        }
    }
    fn current(s: &State) -> bool {
        s.enabled
            && s.heartbeat
                .is_some_and(|t| t.elapsed() < Duration::from_secs(20))
    }
    pub fn shutdown(&self) {
        let mut s = self.state.lock().unwrap();
        self.shutdown_locked(&mut s);
    }
    fn close(&self, epoch: &str) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        Self::check(&s, epoch)?;
        self.shutdown_locked(&mut s);
        Ok(())
    }
    fn shutdown_locked(&self, s: &mut State) {
        if let Some(cancel) = s.listener.take() {
            cancel.cancel();
        }
        s.enabled = false;
        s.endpoint.clear();
        s.active_server = None;
        s.grants.clear();
        Self::cancel_all(s);
        s.peers.clear();
        s.peer_policies.clear();
        s.channel = None;
        s.heartbeat = None;
        s.epoch.clear();
        self.jobs.stop();
    }
    fn revoke_locked(&self, s: &mut State, id: &str) {
        s.grants.remove(id);
        self.jobs.cancel_grant(id);
        let calls: Vec<_> = s
            .tickets
            .iter()
            .filter(|(_, t)| t.grant == id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in calls {
            Self::cancel_request(s, &id);
        }
    }
    fn expire(&self) {
        let mut s = self.state.lock().unwrap();
        let closed = s
            .heartbeat
            .is_some_and(|t| t.elapsed() > Duration::from_secs(20));
        let expired: Vec<_> = s
            .grants
            .values()
            .filter(|g| closed || !Self::grant_live(&s, g))
            .map(|g| g.id.clone())
            .collect();
        for id in expired {
            self.revoke_locked(&mut s, &id);
        }
        let inactive: Vec<_> = s
            .pending
            .values()
            .filter(|p| !Self::principal_active(&s, &p.principal))
            .map(|p| p.principal.id.clone())
            .collect();
        let calls: Vec<_> = s
            .pending
            .iter()
            .filter(|(_, p)| {
                closed || p.deadline <= Instant::now() || inactive.contains(&p.principal.id)
            })
            .map(|(id, _)| id.clone())
            .chain(
                s.tickets
                    .iter()
                    .filter(|(_, t)| closed || t.deadline <= Instant::now())
                    .map(|(id, _)| id.clone()),
            )
            .collect();
        for id in calls {
            Self::cancel_request(&mut s, &id);
        }
        if closed {
            Self::cancel_all(&mut s);
            s.enabled = false;
            s.endpoint.clear();
            s.active_server = None;
            s.peers.clear();
            s.peer_policies.clear();
            if let Some(c) = s.listener.take() {
                c.cancel();
            }
        }
    }
    fn authenticate(&self, token: &str) -> Option<Principal> {
        let s = self.state.lock().unwrap();
        if !Self::current(&s) {
            return None;
        }
        if token.len() > 256 {
            return None;
        }
        let digest = registry::digest(token);
        s.registry
            .clients
            .values()
            .find(|c| c.active() && constant_eq(&c.token_hash, &digest))
            .map(registry::Client::principal)
    }
    async fn invoke(self: Arc<Self>, principal: Principal, id: String, mut call: Call) -> Value {
        if principal.kind == "mcp" {
            call.source = Some(Source {
                kind: "mcp".into(),
                label: principal.label.clone(),
            });
        }
        let cleanup = {
            let mut s = self.state.lock().unwrap();
            if id.is_empty() || id.len() > 128 {
                return error("INVALID_ARGUMENTS");
            }
            if s.requests.contains_key(&id)
                || s.pending.contains_key(&id)
                || s.tickets.contains_key(&id)
            {
                return error("DUPLICATE_REQUEST");
            }
            if s.requests.len() >= 16 {
                return error("BUSY");
            }
            let generation = uuid::Uuid::new_v4().to_string();
            s.requests.insert(id.clone(), generation.clone());
            RequestCleanup {
                service: self.clone(),
                id: id.clone(),
                generation,
            }
        };
        let result = self
            .execute(
                principal.clone(),
                id.clone(),
                &cleanup.generation,
                call.clone(),
            )
            .await
            .unwrap_or_else(|e| error(&e));
        let mut s = self.state.lock().unwrap();
        s.audit.push(json!({"id":id,"at":now(),"principal":principal.label,"tool":call.name,"target":call.arguments["target"],"status":if result["ok"]==true {"ok"}else{result["error"]["code"].as_str().unwrap_or("error")}}));
        if s.audit.len() > 1000 {
            s.audit.remove(0);
        }
        result
    }
    async fn execute(
        &self,
        principal: Principal,
        id: String,
        generation: &str,
        call: Call,
    ) -> Result<Value, String> {
        if call
            .source
            .as_ref()
            .is_some_and(|s| !["mcp", "webmcp"].contains(&s.kind.as_str()) || s.label.len() > 128)
        {
            return Err("INVALID_ARGUMENTS".into());
        }
        let tool = catalog::validate(&call.name, &call.arguments)?;
        let scope = tool["scope"].as_str().unwrap().to_string();
        self.expire();
        let (grant, approval) = {
            let mut s = self.state.lock().unwrap();
            if s.requests.get(&id).map(String::as_str) != Some(generation) {
                return Err("CANCELLED".into());
            }
            if !Self::current(&s) {
                return Err("DISABLED".into());
            }
            if !Self::principal_active(&s, &principal) {
                return Err("SESSION_CLOSED".into());
            }
            if s.tickets.contains_key(&id) || s.pending.contains_key(&id) {
                return Err("DUPLICATE_REQUEST".into());
            }
            if s.tickets.len() + s.pending.len() >= 16 {
                return Err("BUSY".into());
            }
            if principal.kind == "peer" && call.arguments["target"] != "local" {
                return Err("PERMISSION_DENIED".into());
            }
            if principal.kind == "mcp" {
                Self::token_grant(&mut s, &principal, &call.arguments["target"])?;
            }
            let decision = Self::peer_decision(&s, &principal, &scope);
            if decision == policy::Decision::Deny {
                return Err("PERMISSION_DENIED".into());
            }
            if decision == policy::Decision::Allow {
                Self::policy_grant(&mut s, &principal, &scope);
            }
            let grant = s
                .grants
                .values()
                .find(|g| {
                    g.principal.id == principal.id
                        && g.principal.kind == principal.kind
                        && g.scopes.contains(&scope)
                        && g.covers_target(&call.arguments["target"])
                        && Self::grant_live(&s, g)
                })
                .map(|g| g.id.clone());
            if grant.is_none() {
                if s.pending.len() >= 8 {
                    return Err("BUSY".into());
                }
                let (tx, rx) = oneshot::channel();
                s.pending.insert(
                    id.clone(),
                    Pending {
                        principal: principal.clone(),
                        call: call.clone(),
                        scope: scope.clone(),
                        deadline: Instant::now() + Duration::from_secs(120),
                        answer: tx,
                    },
                );
                (None, Some(rx))
            } else {
                (grant, None)
            }
        };
        if let Some(approval) = approval {
            if !tokio::time::timeout(Duration::from_secs(120), approval)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(false)
            {
                return Err("PERMISSION_DENIED".into());
            }
        }
        let rx = {
            let mut s = self.state.lock().unwrap();
            if s.requests.get(&id).map(String::as_str) != Some(generation) {
                return Err("CANCELLED".into());
            }
            if !Self::current(&s) {
                return Err("SESSION_CLOSED".into());
            }
            let grant = grant
                .or_else(|| {
                    s.grants
                        .values()
                        .find(|g| {
                            g.principal.id == principal.id
                                && g.principal.kind == principal.kind
                                && g.scopes.contains(&scope)
                                && g.covers_target(&call.arguments["target"])
                                && Self::grant_live(&s, g)
                        })
                        .map(|g| g.id.clone())
                })
                .ok_or("GRANT_EXPIRED")?;
            if !s
                .grants
                .get(&grant)
                .is_some_and(|g| Self::grant_live(&s, g))
            {
                return Err("GRANT_EXPIRED".into());
            }
            let (tx, rx) = oneshot::channel();
            s.tickets.insert(
                id.clone(),
                Ticket {
                    principal: principal.clone(),
                    call: call.clone(),
                    grant,
                    deadline: Instant::now() + Duration::from_secs(150),
                    answer: tx,
                    used: false,
                },
            );
            if s.channel
                .as_ref()
                .ok_or("APP_NOT_READY")?
                .send(json!({"kind":"call","id":id,"principal":principal,"call":call}))
                .is_err()
            {
                s.tickets.remove(&id);
                return Err("APP_NOT_READY".into());
            }
            rx
        };
        tokio::time::timeout(Duration::from_secs(150), rx)
            .await
            .map_err(|_| "TIMEOUT".to_string())?
            .map_err(|_| "CANCELLED".into())
    }
}
fn constant_eq(left: &str, right: &str) -> bool {
    let mut diff = left.len() ^ right.len();
    for (a, b) in left.bytes().zip(right.bytes()) {
        diff |= (a ^ b) as usize;
    }
    diff == 0
}
#[cfg(test)]
mod tests;
