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
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_instructions(concat!(
            "Weblink automation. Use explicit targets. ",
            "For desktop input, choose kind=monitor from screen.sources, then call control.acquire with that sourceId to prepare sharing and control in one step. ",
            "Use screen.start for sharing without control. An existing live native monitor trackId from sessions.list is also accepted by control.acquire; supply only one ID. ",
            "After acquisition, call control.pointer/key/text directly, then control.release to end input. Successful sharing persists after control release or caller disconnection; use screen.stop to close the picture for the entire room. No bindWindow or accessibility focus call is needed. ",
            "Keep the returned trackId for screen.configure; sourceId and geometryRevision address physical pointer coordinates. ",
            "A valid MCP token authorizes forwarding and device discovery. Local diagnostic tools are always available; other local calls require local automation to be enabled. ",
            "Remote calls follow the destination device's permissions. Calls never approve their own remote permissions. ",
            "Keys/text go to the current foreground application; pointer actions use physical desktop coordinates. ",
            "Use bindWindow only when window confinement is explicitly wanted. To remove an existing binding, release and acquire again. ",
            "Loss of the bound window during input or accessibility actions is reported as WINDOW_FOCUS_LOST, including closure. ",
            "The action may already have taken effect. Re-observe with accessibility.windows or control.screenshot to determine ",
            "the actual outcome before retrying; an error does not prove the window is still open."
        ))
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
            return Ok(tool_result(errors::before_dispatch("PERMISSION_DENIED")).into());
        };
        let id = uuid::Uuid::new_v4().to_string();
        let call = Call {
            source: None,
            name: request.name.to_string(),
            arguments: Value::Object(request.arguments.unwrap_or_default()),
        };
        let future = self.0.clone().invoke(principal, id.clone(), call);
        let result = tokio::select! { result=future=>result,_=context.ct.cancelled()=>{let mut s=self.0.state.lock().unwrap();Service::cancel_request(&mut s,&id);error("CANCELLED")} };
        Ok(tool_result(result).into())
    }
}
/// Keep binary image data in MCP image content, with the same metadata in both JSON views.
/// This is a transport projection: peer and WebMCP results retain their original payload.
fn tool_result(mut result: Value) -> CallToolResult {
    let failed = result["ok"] != true;
    let image = if failed {
        None
    } else {
        result
            .get_mut("data")
            .and_then(Value::as_object_mut)
            .and_then(|payload| {
                if payload.get("mimeType").and_then(Value::as_str) != Some("image/png")
                    || !payload.get("data").is_some_and(Value::is_string)
                {
                    return None;
                }
                let Some(Value::String(data)) = payload.remove("data") else {
                    unreachable!("the PNG payload was checked before removal");
                };
                Some(ContentBlock::image(data, "image/png"))
            })
    };
    let mut content = vec![ContentBlock::text(result.to_string())];
    content.extend(image);
    let mut output = if failed {
        CallToolResult::error(content)
    } else {
        CallToolResult::success(content)
    };
    output.structured_content = Some(result);
    output
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
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jmQAAAABJRU5ErkJggg==";

    fn wire_result(result: Value) -> Value {
        serde_json::to_value(tool_result(result)).unwrap()
    }

    fn assert_json_views(wire: &Value, expected: &Value) {
        assert_eq!(&wire["structuredContent"], expected);
        assert_eq!(wire["content"][0]["type"], "text");
        let text: Value =
            serde_json::from_str(wire["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(&text, expected);
    }

    #[test]
    fn screenshot_has_one_image_and_preserves_all_coordinate_metadata() {
        let internal = json!({"ok":true,"data":{
            "data":PNG,"mimeType":"image/png","sourceId":"monitor-left",
            "imageWidth":1,"imageHeight":1,
            "coordinateSpace":"desktopPhysicalPixels",
            "bounds":{"left":-1920,"top":100,"width":600,"height":400},
            "geometryRevision":"geometry-1",
            "imageToDesktop":{"scaleX":600,"scaleY":400,"offsetX":-1920,"offsetY":100},
            "futureMetadata":{"captureId":"capture-1"}
        }});
        let wire = wire_result(internal.clone());
        let mut metadata = internal.clone();
        metadata["data"].as_object_mut().unwrap().remove("data");
        assert_json_views(&wire, &metadata);
        assert_ne!(wire["isError"], true);
        assert_eq!(wire["content"].as_array().unwrap().len(), 2);
        assert_eq!(
            wire["content"][1],
            json!({
                "type":"image","data":PNG,"mimeType":"image/png"
            })
        );
        assert_eq!(wire.to_string().matches(PNG).count(), 1);
        assert_eq!(internal["data"]["data"], PNG);
    }

    #[test]
    fn ordinary_success_keeps_its_complete_structured_and_text_results() {
        let result = json!({"ok":true,"data":{
            "status":"completed","exitCode":0,
            "chunks":[{"stream":"stdout","data":"中文 output"}],
            "nextCursor":13
        }});
        let wire = wire_result(result.clone());
        assert_json_views(&wire, &result);
        assert_ne!(wire["isError"], true);
        assert_eq!(wire["content"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn failures_keep_recovery_details_and_never_promote_payloads_to_images() {
        let failure = json!({"ok":false,"error":{
            "code":"WINDOW_FOCUS_LOST","message":"The window lost focus",
            "retryable":false,"outcome":"unknown","nextAction":"observe"
        }});
        for result in [
            failure.clone(),
            json!({"ok":false,"error":failure["error"],
                "data":{"mimeType":"image/png","data":PNG}}),
        ] {
            let wire = wire_result(result.clone());
            assert_json_views(&wire, &result);
            assert_eq!(wire["isError"], true);
            assert_eq!(wire["content"].as_array().unwrap().len(), 1);
        }
    }

    #[test]
    fn incomplete_png_payloads_remain_json_without_data_loss() {
        for result in [
            json!({"ok":true}),
            json!({"ok":true,"data":null}),
            json!({"ok":true,"data":{"mimeType":"image/png","imageWidth":1}}),
            json!({"ok":true,"data":{"data":PNG}}),
            json!({"ok":true,"data":{"mimeType":null,"data":PNG}}),
            json!({"ok":true,"data":{"mimeType":"image/png","data":null}}),
            json!({"ok":true,"data":{"mimeType":"image/png","data":42}}),
        ] {
            let wire = wire_result(result.clone());
            assert_json_views(&wire, &result);
            assert_ne!(wire["isError"], true);
            assert_eq!(wire["content"].as_array().unwrap().len(), 1);
        }
    }

    #[test]
    fn other_mime_types_are_not_treated_as_png_screenshots() {
        for mime in ["image/jpeg", "image/webp", "text/plain"] {
            let result = json!({"ok":true,"data":{"mimeType":mime,"data":"original payload"}});
            let wire = wire_result(result.clone());
            assert_json_views(&wire, &result);
            assert_ne!(wire["isError"], true);
            assert_eq!(wire["content"].as_array().unwrap().len(), 1);
        }
    }

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
