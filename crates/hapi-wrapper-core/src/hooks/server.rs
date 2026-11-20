use crate::loopback::{reply, Listener, Reply};
use futures_util::{future::BoxFuture, FutureExt};
use http_body_util::{BodyExt, Limited};
use hyper::{body::Incoming, Method, Request};
use serde_json::{json, Value};
use std::{io, panic::AssertUnwindSafe, sync::Arc, time::Duration};
use tokio::sync::watch;
pub type DecisionHandler =
    Arc<dyn Fn(Value) -> BoxFuture<'static, io::Result<Value>> + Send + Sync>;
pub type SessionHook = Arc<dyn Fn(&str, Value) + Send + Sync>;
#[derive(Clone)]
pub struct Options {
    pub on_session_hook: SessionHook,
    pub on_permission_request: Option<DecisionHandler>,
    pub on_pre_tool_use: Option<DecisionHandler>,
    pub token: Option<String>,
}
pub struct HookServer {
    pub port: u16,
    pub token: String,
    listener: Listener,
}
impl HookServer {
    pub async fn start(options: Options) -> io::Result<Self> {
        let token = options
            .token
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let secret = token.clone();
        let listener =
            Listener::bind(move |req, _, stop| handle(req, options.clone(), secret.clone(), stop))
                .await?;
        Ok(Self {
            port: listener.port,
            token,
            listener,
        })
    }
    pub async fn stop(self) {
        self.listener.shutdown().await;
    }
}
const PERMISSION_FIELDS: &[&str] = &[
    "hook_event_name",
    "session_id",
    "prompt_id",
    "agent_id",
    "tool_name",
    "tool_input",
];
fn no_decision() -> Reply {
    reply(200, "application/json", "{}")
}
async fn handle(
    req: Request<Incoming>,
    options: Options,
    token: String,
    mut stop: watch::Receiver<bool>,
) -> Reply {
    let route = req.uri().path().to_owned();
    if *req.method() != Method::POST {
        return reply(404, "text/plain", "not found");
    }
    match route.as_str() {
        "/hook/agy-pre-invocation" => return no_decision(),
        "/hook/permission-request" | "/hook/pre-tool-use" | "/hook/session-start" => {}
        _ => return reply(404, "text/plain", "not found"),
    }
    if req
        .headers()
        .get("x-hapi-hook-token")
        .and_then(|h| h.to_str().ok())
        != Some(&token)
    {
        return reply(401, "text/plain", "unauthorized");
    }
    let permission = route == "/hook/permission-request";
    let pre = route == "/hook/pre-tool-use";
    tokio::select! {
        biased;
        _ = stop.wait_for(|v| *v) => {
            if pre { deny() } else if permission { no_decision() } else { reply(503, "text/plain", "server shutting down") }
        }
        response = dispatch(req, options, permission, pre) => response,
    }
}

fn deny() -> Reply {
    reply(
        200,
        "application/json",
        r#"{"permissionDecision":"deny","reason":"Permission bridge error."}"#,
    )
}

async fn dispatch(req: Request<Incoming>, options: Options, permission: bool, pre: bool) -> Reply {
    let read = Limited::new(
        req.into_body(),
        if permission { 2 << 20 } else { usize::MAX },
    )
    .collect();
    let body = if pre {
        read.await
    } else {
        match tokio::time::timeout(Duration::from_secs(5), read).await {
            Ok(r) => r,
            Err(_) => return reply(408, "text/plain", "timeout"),
        }
    };
    let body = match body {
        Ok(body) => body.to_bytes(),
        Err(e) if e.is::<http_body_util::LengthLimitError>() => {
            return reply(413, "text/plain", "hook payload too large")
        }
        Err(_) if permission => return no_decision(),
        Err(_) if pre => return deny(),
        Err(_) => return reply(500, "text/plain", "error"),
    };
    let parsed = crate::jsjson::decode::<Value>(&body);
    let v = match parsed {
        Ok(v) if v.is_object() || v.is_array() => v,
        Err(_) if permission => return no_decision(),
        _ => {
            return reply(
                400,
                "text/plain",
                if permission {
                    "invalid permission request"
                } else {
                    "invalid json"
                },
            )
        }
    };
    if permission {
        let mut v = v;
        if v["hook_event_name"] != "PermissionRequest"
            || ["session_id", "tool_name"]
                .iter()
                .any(|k| v[k].as_str().is_none_or(str::is_empty))
            || !v["tool_input"].is_object()
            || ["prompt_id", "agent_id"]
                .iter()
                .any(|k| v.get(k).is_some_and(|v| !v.is_string()))
        {
            return reply(400, "text/plain", "invalid permission request");
        }
        if let Some(fields) = v.as_object_mut() {
            fields.retain(|k, _| PERMISSION_FIELDS.contains(&k.as_str()));
        }
        let Some(handle) = options.on_permission_request else {
            return no_decision();
        };
        let answer = tokio::select! {result=AssertUnwindSafe(async{handle(v).await}).catch_unwind()=>result.ok().and_then(Result::ok),_=tokio::time::sleep(Duration::from_secs(3600))=>None};
        return reply(
            200,
            "application/json",
            answer
                .filter(|v| !v.is_null())
                .unwrap_or(json!({}))
                .to_string(),
        );
    }
    if pre {
        let Some(handle) = options.on_pre_tool_use else {
            return no_decision();
        };
        let answer = AssertUnwindSafe(async { handle(v).await })
            .catch_unwind()
            .await
            .ok()
            .and_then(Result::ok);
        return answer.map_or_else(deny, |v| reply(200, "application/json", v.to_string()));
    }
    let Some(id) = ["session_id", "sessionId"]
        .iter()
        .find_map(|k| v[k].as_str().filter(|s| !s.is_empty()))
        .map(str::to_owned)
    else {
        return reply(422, "text/plain", "missing session_id");
    };
    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| (options.on_session_hook)(&id, v)));
    reply(200, "text/plain", "ok")
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::Full;
    use hyper_util::{client::legacy::Client, rt::TokioExecutor};
    fn options() -> Options {
        Options {
            on_session_hook: Arc::new(|_, _| {}),
            on_permission_request: None,
            on_pre_tool_use: None,
            token: None,
        }
    }
    async fn send(port: u16, route: &str, token: &str, data: impl Into<Bytes>) -> (u16, String) {
        let client = Client::builder(TokioExecutor::new()).build_http();
        let req = Request::post(format!("http://127.0.0.1:{port}/hook/{route}"))
            .header("x-hapi-hook-token", token)
            .body(Full::new(data.into()))
            .unwrap();
        let response = client.request(req).await.unwrap();
        (
            response.status().as_u16(),
            String::from_utf8(response.collect().await.unwrap().to_bytes().to_vec()).unwrap(),
        )
    }
    fn permission() -> Value {
        json!({"hook_event_name":"PermissionRequest","session_id":"s","tool_name":"Ask","tool_input":{"questions":[1]}})
    }
    #[tokio::test]
    async fn authentication_validation_and_observation() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let server = HookServer::start(Options {
            on_session_hook: Arc::new(move |id, v| tx.send((id.to_owned(), v)).unwrap()),
            ..options()
        })
        .await
        .unwrap();
        let token = &server.token;
        for route in ["session-start", "permission-request", "pre-tool-use"] {
            assert_eq!(send(server.port, route, "", "bad").await.0, 401);
            assert_eq!(send(server.port, route, "wrong", "{}").await.0, 401);
        }
        for (route, body, status, answer) in [
            ("session-start", "bad", 400, "invalid json"),
            ("session-start", "{}", 422, "missing session_id"),
            ("session-start", r#"{"sessionId":"s","extra":1}"#, 200, "ok"),
            ("pre-tool-use", "[]", 200, "{}"),
            ("pre-tool-use", "bad", 400, "invalid json"),
            (
                "permission-request",
                "{}",
                400,
                "invalid permission request",
            ),
            ("permission-request", "bad", 200, "{}"),
            ("unknown", "", 404, "not found"),
        ] {
            assert_eq!(
                send(server.port, route, token, body).await,
                (status, answer.into())
            );
        }
        assert_eq!(
            rx.recv().await.unwrap(),
            ("s".into(), json!({"sessionId":"s","extra":1}))
        );
        assert_eq!(
            send(
                server.port,
                "permission-request",
                token,
                permission().to_string()
            )
            .await
            .1,
            "{}"
        );
        assert_eq!(
            send(
                server.port,
                "permission-request",
                token,
                vec![0; 2 * 1024 * 1024 + 1]
            )
            .await
            .0,
            413
        );
        assert_eq!(
            send(server.port, "agy-pre-invocation", "", "").await,
            (200, "{}".into())
        );
    }
    #[tokio::test]
    async fn decisions_and_bridge_errors() {
        for fail in [false, true] {
            let handler: DecisionHandler = Arc::new(move |data| {
                Box::pin(async move {
                    if fail {
                        return Err(io::Error::other("unavailable"));
                    }
                    Ok(if data["hook_event_name"] == "PermissionRequest" {
                        json!({"behavior":"allow","updatedInput":data["tool_input"]})
                    } else {
                        json!({"permissionDecision":"deny","reason":data["tool_name"]})
                    })
                })
            });
            let server = HookServer::start(Options {
                on_pre_tool_use: Some(handler.clone()),
                on_permission_request: Some(handler),
                ..options()
            })
            .await
            .unwrap();
            let p = send(
                server.port,
                "permission-request",
                &server.token,
                permission().to_string(),
            )
            .await;
            assert_eq!(
                serde_json::from_str::<Value>(&p.1).unwrap(),
                if fail {
                    json!({})
                } else {
                    json!({"behavior":"allow","updatedInput":{"questions":[1]}})
                }
            );
            let p = send(
                server.port,
                "pre-tool-use",
                &server.token,
                r#"{"tool_name":"tool"}"#,
            )
            .await;
            assert_eq!(
                serde_json::from_str::<Value>(&p.1).unwrap(),
                json!({"permissionDecision":"deny","reason":if fail{"Permission bridge error."}else{"tool"}})
            );
        }
    }
    #[tokio::test]
    async fn permission_payload_keeps_schema_fields_only() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let server = HookServer::start(Options {
            on_permission_request: Some(Arc::new(move |v| {
                tx.send(v).unwrap();
                Box::pin(async { Ok(Value::Null) })
            })),
            ..options()
        })
        .await
        .unwrap();
        let mut body = permission();
        body["prompt_id"] = "p".into();
        body["cwd"] = "/tmp".into();
        body["permission_suggestions"] = json!([{"type":"setMode"}]);
        let answer = send(
            server.port,
            "permission-request",
            &server.token,
            body.to_string(),
        )
        .await;
        assert_eq!(answer, (200, "{}".into()));
        let mut expected = permission();
        expected["prompt_id"] = "p".into();
        assert_eq!(rx.recv().await.unwrap(), expected);
    }
    #[tokio::test]
    async fn truncated_pre_tool_use_body_is_denied() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let server = HookServer::start(Options {
            on_pre_tool_use: Some(Arc::new(|_| Box::pin(async { Ok(json!({})) }))),
            ..options()
        })
        .await
        .unwrap();
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", server.port))
            .await
            .unwrap();
        let head = format!(
            "POST /hook/pre-tool-use HTTP/1.1\r\nhost: x\r\nx-hapi-hook-token: {}\r\ntransfer-encoding: chunked\r\n\r\n2\r\n{{}}\r\nzz\r\n",
            server.token
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert!(out.contains(r#""permissionDecision":"deny""#), "{out}");
    }
    #[tokio::test]
    async fn pending_decision_cancelled_on_disconnect_or_shutdown() {
        for disconnect in [false, true] {
            let (tx, mut events) = tokio::sync::mpsc::unbounded_channel();
            struct Pending(tokio::sync::mpsc::UnboundedSender<bool>);
            impl Drop for Pending {
                fn drop(&mut self) {
                    self.0.send(false).unwrap();
                }
            }
            let server = HookServer::start(Options {
                on_permission_request: Some(Arc::new(move |_| {
                    let tx = tx.clone();
                    Box::pin(async move {
                        let _guard = Pending(tx.clone());
                        tx.send(true).unwrap();
                        std::future::pending().await
                    })
                })),
                ..options()
            })
            .await
            .unwrap();
            let port = server.port;
            let token = server.token.clone();
            let req = tokio::spawn(async move {
                send(port, "permission-request", &token, permission().to_string()).await
            });
            assert_eq!(events.recv().await, Some(true));
            assert!(!req.is_finished());
            if disconnect {
                req.abort();
            } else {
                server.stop().await;
                assert_eq!(req.await.unwrap(), (200, "{}".into()))
            }
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), events.recv())
                    .await
                    .unwrap(),
                Some(false)
            );
        }
    }

    #[tokio::test]
    async fn stop_denies_pending_pre_tool_use() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let server = HookServer::start(Options {
            on_pre_tool_use: Some(Arc::new(move |_| {
                tx.send(()).unwrap();
                Box::pin(std::future::pending())
            })),
            ..options()
        })
        .await
        .unwrap();
        let port = server.port;
        let token = server.token.clone();
        let req = tokio::spawn(async move { send(port, "pre-tool-use", &token, "{}").await });
        rx.recv().await.unwrap();
        tokio::time::timeout(Duration::from_millis(500), server.stop())
            .await
            .unwrap();
        let (status, body) = req.await.unwrap();
        assert_eq!(status, 200);
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["permissionDecision"],
            "deny"
        );
    }
}
