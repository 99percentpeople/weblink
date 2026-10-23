use super::*;
use axum::{
    body::Body,
    extract::{connect_info::Connected, ConnectInfo, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use rmcp::{
    model::*,
    service::RequestContext,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData, RoleServer, ServerHandler,
};
#[derive(Clone)]
struct Handler(Shared);
impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_instructions("Weblink automation. Explicit targets. A valid MCP token authorizes forwarding and device discovery. Other local calls also require local automation to be enabled. Remote calls follow the destination device's permissions. Calls never approve their own remote permissions.")
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {tools:catalog::tools().iter().map(|t|serde_json::from_value(json!({"name":t["name"],"description":t["description"],"inputSchema":t["inputSchema"],"outputSchema":t["outputSchema"],"annotations":{"readOnlyHint":t["readOnly"],"destructiveHint":!t["readOnly"].as_bool().unwrap_or(false)}})).expect("tool catalog")).collect(),..Default::default()})
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let principal = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|p| p.extensions.get::<Principal>())
            .cloned();
        let Some(principal) = principal else {
            return Ok(CallToolResult::error(vec![ContentBlock::text("PERMISSION_DENIED")]).into());
        };
        let id = uuid::Uuid::new_v4().to_string();
        let call = Call {
            source: None,
            name: request.name.to_string(),
            arguments: Value::Object(request.arguments.unwrap_or_default()),
        };
        let future = self.0.clone().invoke(principal, id.clone(), call);
        let result = tokio::select! { result=future=>result,_=context.ct.cancelled()=>{let mut s=self.0.state.lock().unwrap();Service::cancel_request(&mut s,&id);error("CANCELLED")} };
        let failed = result["ok"] != true;
        let mut output = if failed {
            CallToolResult::error(vec![ContentBlock::text(result.to_string())])
        } else {
            CallToolResult::success(vec![ContentBlock::text(result.to_string())])
        };
        if !failed {
            if let (Some(data), Some(mime)) = (
                result["data"]["data"].as_str(),
                result["data"]["mimeType"].as_str(),
            ) {
                if mime == "image/png" {
                    output.content.push(ContentBlock::image(data, mime));
                }
            }
        }
        output.structured_content = Some(result);
        Ok(output.into())
    }
}
#[derive(Clone)]
struct Auth {
    service: Shared,
    cancel: CancellationToken,
}
// Use the accepted socket's destination, including when bound to a wildcard.
// Never trust an arbitrary DNS Host or a forwarded header to pick an origin.
#[derive(Clone)]
struct LocalAddress(Option<std::net::SocketAddr>);
impl Connected<axum::serve::IncomingStream<'_, tokio::net::TcpListener>> for LocalAddress {
    fn connect_info(stream: axum::serve::IncomingStream<'_, tokio::net::TcpListener>) -> Self {
        Self(
            stream.io().local_addr().ok().map(|address| {
                std::net::SocketAddr::new(address.ip().to_canonical(), address.port())
            }),
        )
    }
}
fn valid_origin(origin: Option<&str>, host: &str) -> bool {
    origin.is_none_or(|origin| {
        origin == format!("http://{host}")
            || host
                .strip_suffix(":80")
                .is_some_and(|host| origin == format!("http://{host}"))
    })
}
fn valid_host(host: Option<&str>, local: std::net::SocketAddr) -> bool {
    let authority = local.to_string();
    host.is_some_and(|host| {
        host == authority || (local.port() == 80 && Some(host) == authority.strip_suffix(":80"))
    })
}
async fn authorize(
    State(auth): State<Auth>,
    ConnectInfo(local): ConnectInfo<LocalAddress>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let Some(local) = local.0 else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let host = local.to_string();
    if auth.cancel.is_cancelled()
        || !valid_host(
            request.headers().get("host").and_then(|h| h.to_str().ok()),
            local,
        )
        || !valid_origin(
            request
                .headers()
                .get("origin")
                .map(|h| h.to_str().unwrap_or("invalid")),
            &host,
        )
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let principal = request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .map(|v| v.strip_prefix("Bearer ").unwrap_or(v))
        .and_then(|t| auth.service.authenticate(t));
    let Some(principal) = principal else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    request.extensions_mut().insert(principal);
    next.run(request).await
}
pub async fn start(service: Shared, epoch: String) -> Result<(), String> {
    let (ip, port) = {
        let s = service.state.lock().unwrap();
        (s.registry.host, s.registry.port)
    };
    let listener = tokio::net::TcpListener::bind((ip, port))
        .await
        .map_err(|e| e.to_string())?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    let cancel = CancellationToken::new();
    {
        let mut s = service.state.lock().unwrap();
        server::activate(&mut s, &epoch, ip, address.port())?;
        s.listener = Some(cancel.clone());
    }
    let factory = service.clone();
    let mcp = StreamableHttpService::new(
        move || Ok(Handler(factory.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            // authorize validates Host against the accepted socket's actual IP
            // and port, including new interfaces on a wildcard listener. The
            // SDK's static loopback-only list would reject those valid requests.
            .disable_allowed_hosts()
            .with_legacy_session_mode(false)
            .with_cancellation_token(cancel.clone())
            .with_json_response(true)
            .with_max_request_body_bytes(128 * 1024),
    );
    let app = Router::new()
        .nest_service("/mcp", mcp)
        .layer(middleware::from_fn_with_state(
            Auth {
                service,
                cancel: cancel.clone(),
            },
            authorize,
        ));
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<LocalAddress>(),
        )
        .with_graceful_shutdown(cancel.cancelled_owned())
        .await;
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origin_is_exact() {
        assert!(valid_origin(None, "127.0.0.1:123"));
        assert!(valid_origin(Some("http://127.0.0.1:123"), "127.0.0.1:123"));
        for o in [
            "null",
            "https://127.0.0.1:123",
            "http://evil.test",
            "http://127.0.0.1:124",
        ] {
            assert!(!valid_origin(Some(o), "127.0.0.1:123"));
        }
    }
}
