//! Desktop-owned listener configuration, separate from client credentials.
use super::*;
use std::net::{IpAddr, Ipv4Addr};

pub(super) const DEFAULT_PORT: u16 = 32100;
pub(super) fn default_port() -> u16 {
    DEFAULT_PORT
}
// Old registries may contain null before their first automatic allocation.
pub(super) fn read_port<'de, D: serde::Deserializer<'de>>(value: D) -> Result<u16, D::Error> {
    Ok(Option::<u16>::deserialize(value)?.unwrap_or(DEFAULT_PORT))
}

pub(super) fn default_host() -> IpAddr {
    Ipv4Addr::LOCALHOST.into()
}

pub(super) fn endpoint(ip: IpAddr, port: u16) -> String {
    let ip = match ip {
        IpAddr::V4(ip) if ip.is_unspecified() => Ipv4Addr::LOCALHOST.into(),
        IpAddr::V6(ip) if ip.is_unspecified() => std::net::Ipv6Addr::LOCALHOST.into(),
        ip => ip.to_canonical(),
    };
    format!("http://{}/mcp", std::net::SocketAddr::new(ip, port))
}

/// Advertise the running listener, never settings awaiting the next start.
/// Re-enumerate interfaces so a network change is reflected in status polling.
pub(super) fn endpoints(active: Option<&ServerConfig>) -> Vec<String> {
    let Some(active) = active else {
        return Vec::new();
    };
    let Ok(ip) = active.host.parse::<IpAddr>() else {
        return Vec::new();
    };
    let addresses = if ip.is_unspecified() {
        if_addrs::get_if_addrs()
            .unwrap_or_default()
            .into_iter()
            .filter(|interface| interface.is_oper_up())
            .map(|interface| interface.ip())
            .collect()
    } else {
        Vec::new()
    };
    endpoints_for(ip, active.port, addresses)
}

fn endpoints_for(ip: IpAddr, port: u16, addresses: Vec<IpAddr>) -> Vec<String> {
    let mut urls = vec![endpoint(ip, port)];
    if !ip.is_unspecified() {
        return urls;
    }
    let addresses: std::collections::BTreeSet<_> = addresses
        .into_iter()
        .filter(|address| {
            address.is_ipv4() == ip.is_ipv4()
                && !address.is_unspecified()
                && !address.is_loopback()
                && !address.is_multicast()
                && match address {
                    IpAddr::V4(address) => !address.is_broadcast(),
                    // A link-local IPv6 URL needs the caller's interface scope.
                    // Our local interface index is not usable on another device.
                    IpAddr::V6(address) => !address.is_unicast_link_local(),
                }
        })
        .collect();
    urls.extend(addresses.into_iter().map(|address| endpoint(address, port)));
    urls
}

pub(super) fn pending(s: &State) -> bool {
    s.mcp_enabled
        && s.active_server.as_ref().is_some_and(|active| {
            active.host != s.registry.host.to_string() || active.port != s.registry.port
        })
}

/// A bind can overlap a settings write. Record the live address without replacing
/// the latest desired settings.
pub(super) fn activate(s: &mut State, epoch: &str, ip: IpAddr, port: u16) -> Result<(), String> {
    Service::check(s, epoch)?;
    if !s.mcp_enabled {
        return Err("DISABLED".into());
    }
    s.endpoint = endpoint(ip, port);
    s.active_server = Some(ServerConfig {
        host: ip.to_string(),
        port,
    });
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

impl ServerConfig {
    pub(super) fn address(&self) -> Result<IpAddr, String> {
        let host = self.host.trim();
        let host = if host.eq_ignore_ascii_case("localhost") {
            "127.0.0.1"
        } else {
            host.strip_prefix('[')
                .and_then(|h| h.strip_suffix(']'))
                .unwrap_or(host)
        };
        let ip: IpAddr = host.parse().map_err(|_| "INVALID_MCP_HOST")?;
        if ip.is_multicast() || ip == IpAddr::V4(Ipv4Addr::BROADCAST) {
            return Err("INVALID_MCP_HOST".into());
        }
        if self.port == 0 {
            return Err("INVALID_MCP_PORT".into());
        }
        Ok(ip)
    }
}

#[cfg(test)]
impl Service {
    pub(super) fn configure_server(&self, epoch: &str, config: ServerConfig) -> Result<(), String> {
        self.change_registry(epoch, registry::Change::Server(config))
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn available_port(host: &str) -> u16 {
        std::net::TcpListener::bind((host, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }
    fn fixture() -> Shared {
        let service = Arc::new(Service::default());
        {
            let mut s = service.state.lock().unwrap();
            s.epoch = "epoch".into();
        }
        service
    }
    fn config(host: &str, port: u16) -> ServerConfig {
        ServerConfig {
            host: host.into(),
            port,
        }
    }
    #[test]
    fn wildcard_endpoints_include_complete_unique_addresses_for_the_bound_family() {
        let addresses = [
            "192.168.1.20",
            "10.0.0.5",
            "192.168.1.20",
            "127.0.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "fd00::5",
            "::1",
            "::",
            "fe80::1",
            "ff02::1",
        ]
        .map(|ip| ip.parse().unwrap())
        .to_vec();
        assert_eq!(
            endpoints_for("0.0.0.0".parse().unwrap(), 32100, addresses.clone()),
            [
                "http://127.0.0.1:32100/mcp",
                "http://10.0.0.5:32100/mcp",
                "http://192.168.1.20:32100/mcp",
            ]
        );
        assert_eq!(
            endpoints_for("::".parse().unwrap(), 4321, addresses),
            ["http://[::1]:4321/mcp", "http://[fd00::5]:4321/mcp"]
        );
    }

    #[test]
    fn concrete_bindings_and_unavailable_interfaces_keep_only_the_usable_endpoint() {
        assert_eq!(
            endpoints_for(
                "192.168.1.20".parse().unwrap(),
                32100,
                vec!["10.0.0.5".parse().unwrap()],
            ),
            ["http://192.168.1.20:32100/mcp"]
        );
        assert_eq!(
            endpoints_for("0.0.0.0".parse().unwrap(), 32100, Vec::new()),
            ["http://127.0.0.1:32100/mcp"]
        );
        assert!(endpoints(None).is_empty());
    }

    #[test]
    fn validates_listener_addresses_and_ports() {
        for (input, expected) in [
            (" localhost ", "127.0.0.1"),
            ("127.0.0.1", "127.0.0.1"),
            ("0.0.0.0", "0.0.0.0"),
            ("[::1]", "::1"),
            ("::", "::"),
        ] {
            assert_eq!(
                config(input, 65535).address().unwrap().to_string(),
                expected
            );
        }
        for host in [
            "",
            "example.com",
            "http://127.0.0.1",
            "127.0.0.1:123",
            "127.0.0.1/path",
            "999.0.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "ff02::1",
        ] {
            assert_eq!(config(host, 123).address().unwrap_err(), "INVALID_MCP_HOST");
        }
        assert_eq!(
            config("127.0.0.1", 0).address().unwrap_err(),
            "INVALID_MCP_PORT"
        );
        for port in [-1, 65536] {
            assert!(serde_json::from_value::<ServerConfig>(
                json!({"host":"127.0.0.1", "port":port})
            )
            .is_err());
        }
        assert!(config("127.0.0.1", DEFAULT_PORT).address().is_ok());
        assert!(
            serde_json::from_value::<ServerConfig>(json!({"host":"127.0.0.1", "port":null}))
                .is_err()
        );
    }
    #[test]
    fn new_and_legacy_unallocated_ports_use_the_fixed_default() {
        assert_eq!(registry::Registry::default().port, 32100);
        for json in [
            r#"{"version":1,"port":null,"clients":{}}"#,
            r#"{"version":1,"clients":{}}"#,
        ] {
            let service = fixture();
            service
                .load_registry(serde_json::from_str(json).unwrap())
                .unwrap();
            assert_eq!(service.state.lock().unwrap().registry.port, 32100);
        }
    }
    #[test]
    fn restores_stored_port_and_keeps_credentials_when_saving_listener() {
        let service = fixture();
        service
            .load_registry(
                serde_json::from_str(r#"{"version":1,"port":4321,"clients":{}}"#).unwrap(),
            )
            .unwrap();
        {
            let s = service.state.lock().unwrap();
            assert_eq!(s.registry.host.to_string(), "127.0.0.1");
            assert_eq!(s.registry.port, 4321);
        }
        service.state.lock().unwrap().mcp_enabled = true;
        let token = service
            .create_client("epoch", "Saved agent".into(), None)
            .unwrap();
        service.state.lock().unwrap().mcp_enabled = false;
        service
            .configure_server("epoch", config("::1", 65535))
            .unwrap();
        let restored = fixture();
        restored.load_registry(service.stored_registry()).unwrap();
        {
            let s = restored.state.lock().unwrap();
            assert_eq!(s.registry.host.to_string(), "::1");
            assert_eq!(s.registry.port, 65535);
            assert!(!s.mcp_enabled);
            assert_eq!(s.registry.clients.len(), 1);
        }
        restored.state.lock().unwrap().mcp_enabled = true;
        assert!(restored
            .authenticate(token["token"].as_str().unwrap())
            .is_some());
        assert!(!serde_json::to_string(&service.stored_registry())
            .unwrap()
            .contains(token["token"].as_str().unwrap()));
    }
    #[test]
    fn rejects_stale_changes_and_preserves_config_on_invalid_registry() {
        let service = fixture();
        assert_eq!(
            service
                .configure_server("old-epoch", config("::1", DEFAULT_PORT))
                .unwrap_err(),
            "SESSION_CLOSED"
        );
        let mut prepared = service
            .prepare_registry("epoch", registry::Change::Server(config("::1", 1234)))
            .unwrap();
        prepared.registry.port = 0;
        assert!(service
            .apply_registry("epoch", prepared.revision, prepared.registry)
            .is_err());
        let s = service.state.lock().unwrap();
        assert_eq!(s.registry.host.to_string(), "127.0.0.1");
        assert_eq!(s.registry.port, DEFAULT_PORT);
    }
    #[test]
    fn a_setting_written_during_bind_survives_activation() {
        let service = fixture();
        service.state.lock().unwrap().mcp_enabled = true;
        service
            .configure_server("epoch", config("::1", 4321))
            .unwrap();
        let mut s = service.state.lock().unwrap();
        activate(&mut s, "epoch", default_host(), 1234).unwrap();
        assert_eq!(s.registry.host.to_string(), "::1");
        assert_eq!(s.registry.port, 4321);
        assert_eq!(s.endpoint, "http://127.0.0.1:1234/mcp");
        assert!(pending(&s));
    }
    #[test]
    fn tokens_can_be_created_offline_without_enabling_any_authority() {
        let service = fixture();
        let token = service
            .create_client("epoch", "Offline agent".into(), None)
            .unwrap();
        assert_eq!(token["endpoint"], "http://127.0.0.1:32100/mcp");
        assert!(service
            .authenticate(token["token"].as_str().unwrap())
            .is_none());
        service
            .configure_server("epoch", config("::", 4321))
            .unwrap();
        let next = service
            .create_client("epoch", "Prepared agent".into(), Some(now() + 60000))
            .unwrap();
        assert_eq!(next["endpoint"], "http://[::1]:4321/mcp");
        assert!(service
            .create_client("old-epoch", "Invalid".into(), None)
            .is_err());
        let s = service.state.lock().unwrap();
        assert!(!s.mcp_enabled);
        assert!(s.listener.is_none());
        assert!(s.grants.is_empty());
        assert!(s.peers.is_empty());
        assert_eq!(s.registry.clients.len(), 2);
    }
    #[tokio::test]
    async fn live_settings_preserve_listener_and_grants_until_restart() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let service = fixture();
        let token = service
            .create_client("epoch", "Offline agent".into(), None)
            .unwrap();
        service
            .configure_server("epoch", config("127.0.0.1", available_port("127.0.0.1")))
            .unwrap();
        service.state.lock().unwrap().mcp_enabled = true;
        http::start(service.clone(), "epoch".into()).await.unwrap();
        let secret = token["token"].as_str().unwrap();
        let principal = service.authenticate(secret).unwrap();
        let url = service.state.lock().unwrap().endpoint.clone();
        let listener = service.state.lock().unwrap().listener.clone().unwrap();
        service.state.lock().unwrap().grants.insert(
            "active".into(),
            Grant {
                id: "active".into(),
                target: "local".into(),
                principal,
                scopes: vec!["diagnostics.read".into()],
                expires_at: Some(now() + 60000),
                source: GrantSource::Token,
            },
        );
        service
            .configure_server("epoch", config("0.0.0.0", available_port("127.0.0.1")))
            .unwrap();
        {
            let s = service.state.lock().unwrap();
            assert!(pending(&s));
            assert_eq!(s.endpoint, url);
            assert_eq!(endpoints(s.active_server.as_ref()), [url.clone()]);
            assert!(!listener.is_cancelled());
            assert!(Service::grant_live(&s, &s.grants["active"]));
        }
        let response = reqwest::Client::builder().no_proxy().build().unwrap()
            .post(&url).bearer_auth(secret).header("accept", "application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}))
            .send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        service.shutdown();
        let restarted = fixture();
        restarted.load_registry(service.stored_registry()).unwrap();
        restarted.state.lock().unwrap().mcp_enabled = true;
        http::start(restarted.clone(), "epoch".into())
            .await
            .unwrap();
        {
            let s = restarted.state.lock().unwrap();
            assert!(!pending(&s));
            assert_eq!(s.active_server.as_ref().unwrap().host, "0.0.0.0");
        }
        assert!(restarted.authenticate(secret).is_some());
        restarted.shutdown();
    }
    #[tokio::test]
    async fn occupied_port_is_an_error_without_silently_switching_ports() {
        let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = occupied.local_addr().unwrap().port();
        let service = fixture();
        service
            .configure_server("epoch", config("127.0.0.1", port))
            .unwrap();
        service.state.lock().unwrap().mcp_enabled = true;
        assert!(http::start(service.clone(), "epoch".into()).await.is_err());
        let s = service.state.lock().unwrap();
        assert_eq!(s.registry.port, port);
        assert!(s.endpoint.is_empty());
        assert!(s.listener.is_none());
    }
    async fn exercise_listener(host: &str, port: u16) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let service = fixture();
        service
            .configure_server("epoch", config(host, port))
            .unwrap();
        service.state.lock().unwrap().mcp_enabled = true;
        http::start(service.clone(), "epoch".into()).await.unwrap();
        let token = service
            .create_client("epoch", "Agent".into(), None)
            .unwrap();
        let url = token["endpoint"].as_str().unwrap();
        let token = token["token"].as_str().unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let advertised = endpoints(service.state.lock().unwrap().active_server.as_ref());
        assert_eq!(advertised.first().map(String::as_str), Some(url));
        for url in advertised {
            let request = || {
                client.post(&url).bearer_auth(token)
                .header("accept", "application/json, text/event-stream")
                .json(&json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"protocolVersion":"2025-03-26", "capabilities":{}, "clientInfo":{"name":"test", "version":"1"}}}))
            };
            let response = request().send().await.unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            let body: Value = response.json().await.unwrap();
            assert!(body["result"]["capabilities"].is_object());
            for (header, value) in [
                ("host", "evil.test"),
                ("host", "127.0.0.1:1"),
                ("origin", "http://evil.test"),
                ("origin", "null"),
            ] {
                assert_eq!(
                    request()
                        .header(header, value)
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    reqwest::StatusCode::FORBIDDEN
                );
            }
            assert_eq!(
                client.post(&url).send().await.unwrap().status(),
                reqwest::StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                request()
                    .header("origin", url.strip_suffix("/mcp").unwrap())
                    .send()
                    .await
                    .unwrap()
                    .status(),
                reqwest::StatusCode::OK
            );
        }
        let s = service.state.lock().unwrap();
        assert_eq!(s.registry.port, port);
        drop(s);
        service.shutdown();
        assert!(service.state.lock().unwrap().endpoint.is_empty());
    }
    #[tokio::test]
    async fn explicit_ipv4_port_serves_authenticated_mcp() {
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        exercise_listener("127.0.0.1", port).await;
    }
    #[tokio::test]
    async fn wildcard_binding_uses_concrete_socket_host_and_preserves_origin_checks() {
        exercise_listener("0.0.0.0", available_port("127.0.0.1")).await;
    }
    #[tokio::test]
    async fn ipv6_binding_has_a_usable_endpoint_and_origin() {
        exercise_listener("::1", available_port("::1")).await;
    }
}
