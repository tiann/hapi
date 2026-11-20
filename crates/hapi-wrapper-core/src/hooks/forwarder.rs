use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper_util::{client::legacy::Client, rt::TokioExecutor};
use serde_json::{json, Value};
use std::{io, time::Duration};

struct Args {
    port: u16,
    token: String,
    flavor: String,
    event: String,
}
fn parse(args: &[String]) -> io::Result<Args> {
    let mut iter = args.iter().map(String::as_str);
    let mut port = None;
    let mut token = String::new();
    let mut flavor = "claude".to_string();
    let mut event = "pre-tool-use".to_string();
    let mut from_env = false;
    while let Some(arg) = iter.next() {
        let (key, inline) = arg
            .split_once('=')
            .filter(|(k, _)| matches!(*k, "--port" | "--token" | "--flavor" | "--event"))
            .map_or((arg, None), |(k, v)| (k, Some(v)));
        let mut value = || inline.or_else(|| iter.next()).unwrap_or("");
        match key {
            "--from-env" => from_env = true,
            "--port" | "-p" => port = value().parse::<u16>().ok().filter(|p| *p > 0),
            "--token" | "-t" => token = value().into(),
            "--flavor" => {
                let v = value();
                if matches!(v, "codex" | "agy") {
                    flavor = v.into()
                }
            }
            "--event" => event = value().into(),
            _ if port.is_none() => port = arg.parse().ok().filter(|p| *p > 0),
            _ if token.is_empty() => token = arg.into(),
            _ => {}
        }
    }
    if from_env {
        port = std::env::var("HAPI_AGY_HOOK_PORT")
            .ok()
            .and_then(|s| s.parse().ok());
        token = std::env::var("HAPI_AGY_HOOK_TOKEN")
            .unwrap_or_default()
            .trim()
            .into()
    }
    let port = port
        .filter(|p| *p > 0)
        .ok_or_else(|| io::Error::other("Invalid or missing port argument"))?;
    if token.is_empty() {
        return Err(io::Error::other("Missing hook token"));
    }
    if !matches!(event.as_str(), "pre-tool-use" | "pre-invocation") {
        return Err(io::Error::other(format!("Unknown --event value: {event}")));
    }
    Ok(Args {
        port,
        token,
        flavor,
        event,
    })
}
fn decision(mut v: Value) -> Option<Value> {
    if !matches!(v["behavior"].as_str(), Some("allow" | "deny"))
        || v.get("message").is_some_and(|v| !v.is_string())
        || v.get("updatedInput").is_some_and(|v| !v.is_object())
    {
        return None;
    }
    if let Some(perms) = v.get_mut("updatedPermissions") {
        for p in perms.as_array_mut()? {
            if p["destination"] != "session" {
                return None;
            }
            match p["type"].as_str()? {
                "setMode"
                    if matches!(
                        p["mode"].as_str(),
                        Some("default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan")
                    ) =>
                {
                    p.as_object_mut()?
                        .retain(|k, _| matches!(k.as_str(), "type" | "mode" | "destination"))
                }
                "addRules" if p["behavior"] == "allow" => {
                    for rule in p["rules"].as_array_mut()? {
                        if !rule["toolName"].is_string()
                            || rule.get("ruleContent").is_some_and(|v| !v.is_string())
                        {
                            return None;
                        }
                        rule.as_object_mut()?
                            .retain(|k, _| matches!(k.as_str(), "toolName" | "ruleContent"))
                    }
                    p.as_object_mut()?.retain(|k, _| {
                        matches!(k.as_str(), "type" | "rules" | "behavior" | "destination")
                    })
                }
                _ => return None,
            }
        }
    }
    v.as_object_mut()?.retain(|k, _| {
        matches!(
            k.as_str(),
            "behavior" | "message" | "updatedInput" | "updatedPermissions"
        )
    });
    Some(json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":v}}))
}
async fn post(args: &Args, path: &str, body: Vec<u8>) -> io::Result<(u16, Bytes)> {
    let client = Client::builder(TokioExecutor::new()).build_http();
    let req = Request::post(format!("http://127.0.0.1:{}/hook/{path}", args.port))
        .header("x-hapi-hook-token", &args.token)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body)))
        .map_err(io::Error::other)?;
    let res = client.request(req).await.map_err(io::Error::other)?;
    let status = res.status().as_u16();
    Ok((
        status,
        res.collect().await.map_err(io::Error::other)?.to_bytes(),
    ))
}
async fn forward(args: Args, body: Vec<u8>) -> io::Result<Option<Value>> {
    let route = match args.flavor.as_str() {
        "agy" if args.event == "pre-invocation" => "agy-pre-invocation",
        "agy" => "pre-tool-use",
        "claude"
            if serde_json::from_slice::<Value>(&body)
                .ok()
                .is_some_and(|v| v["hook_event_name"] == "PermissionRequest") =>
        {
            "permission-request"
        }
        _ => "session-start",
    };
    let req = post(&args, route, body);
    if matches!(route, "session-start" | "agy-pre-invocation") {
        let answer = tokio::time::timeout(Duration::from_secs(1), req).await;
        if route == "agy-pre-invocation" {
            return Ok(Some(json!({})));
        }
        let (status, _) = answer??;
        if status >= 400 {
            return Err(io::Error::other(format!(
                "Hook server responded with status {status}"
            )));
        }
        return Ok(None);
    }
    let v = req
        .await
        .ok()
        .filter(|(s, _)| *s == 200)
        .and_then(|(_, b)| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or_default();
    if route == "permission-request" {
        return Ok(decision(v));
    }
    let mut agy = json!({"decision":"deny","reason":"Permission bridge unavailable."});
    if matches!(v["permissionDecision"].as_str(), Some("allow" | "deny")) {
        agy = json!({"decision":v["permissionDecision"]});
        for k in ["reason", "permissionOverrides"] {
            if let Some(field) = v.get(k) {
                agy[k] = field.clone()
            }
        }
    }
    Ok(Some(agy))
}
pub async fn run(args: &[String]) -> io::Result<()> {
    let args = parse(args)?;
    let body = tokio::task::spawn_blocking(|| {
        use io::Read;
        let mut v = vec![];
        io::stdin().read_to_end(&mut v)?;
        io::Result::Ok(v)
    })
    .await??;
    if let Some(v) = forward(args, body).await? {
        serde_json::to_writer(io::stdout().lock(), &v)?
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loopback::{reply, Listener};
    fn args(port: u16, flavor: &str, event: &str) -> Args {
        Args {
            port,
            flavor: flavor.into(),
            event: event.into(),
            token: "token".into(),
        }
    }
    #[test]
    fn argument_and_decision_validation() {
        for raw in ["--event=bad", "--event	bad", "--event"] {
            let a = format!("-p	123	-t	key	{raw}")
                .split('\t')
                .map(str::to_owned)
                .collect::<Vec<_>>();
            assert!(parse(&a).is_err());
        }
        assert!(parse(&["123".into(), "key".into()]).is_ok());
        let argv = |s: &str| s.split(' ').map(str::to_owned).collect::<Vec<_>>();
        for raw in ["0 123 key", "--port 0 123 key", "--port=0 123 key"] {
            let a = parse(&argv(raw)).unwrap();
            assert_eq!((a.port, a.token.as_str()), (123, "key"), "{raw}");
        }
        for raw in ["-p=123 key", "-t=key 123", "--from-env=1 123 key"] {
            let a = parse(&argv(raw));
            assert!(a.as_ref().map_or(true, |a| !a.token.contains('=')), "{raw}");
        }
        assert!(parse(&argv("-p=123 key")).is_err());
        let a = parse(&argv("123 -t=key")).unwrap();
        assert_eq!(a.token, "-t=key");
        for v in [
            json!({}),
            Value::Null,
            json!({"behavior":"ask"}),
            json!({"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"bad","destination":"session"}]}),
        ] {
            assert!(decision(v).is_none())
        }
        let v = json!({"behavior":"allow","updatedInput":{"answers":{"Color?":"Blue"}},"updatedPermissions":[{"type":"setMode","mode":"plan","destination":"session"}]});
        assert_eq!(
            decision(v.clone()).unwrap()["hookSpecificOutput"]["decision"],
            v
        );
    }
    #[tokio::test]
    async fn routes_and_stdout() {
        for (flavor, event, body, path, answer, status, expected) in [
            (
                "claude",
                "",
                "SessionStart",
                "session-start",
                "{}",
                200,
                None,
            ),
            (
                "claude",
                "",
                "PreToolUse",
                "session-start",
                r#"{"permissionDecision":"allow"}"#,
                200,
                None,
            ),
            (
                "codex",
                "",
                "PermissionRequest",
                "session-start",
                r#"{"behavior":"allow"}"#,
                200,
                None,
            ),
            (
                "claude",
                "",
                "PermissionRequest",
                "permission-request",
                r#"{"behavior":"allow","updatedInput":{"a":[1]}}"#,
                200,
                Some(
                    json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"a":[1]}}}}),
                ),
            ),
            (
                "claude",
                "",
                "PermissionRequest",
                "permission-request",
                "{}",
                500,
                None,
            ),
            (
                "agy",
                "pre-tool-use",
                "",
                "pre-tool-use",
                r#"{"permissionDecision":"allow","reason":"ok","permissionOverrides":["cmd"]}"#,
                200,
                Some(json!({"decision":"allow","reason":"ok","permissionOverrides":["cmd"]})),
            ),
            (
                "agy",
                "",
                "",
                "pre-tool-use",
                "bad",
                500,
                Some(json!({"decision":"deny","reason":"Permission bridge unavailable."})),
            ),
            (
                "agy",
                "pre-invocation",
                "",
                "agy-pre-invocation",
                "bad",
                500,
                Some(json!({})),
            ),
            (
                "agy",
                "pre-invocation",
                "",
                "agy-pre-invocation",
                "{}",
                200,
                Some(json!({})),
            ),
        ] {
            let server = Listener::bind(move |r, _, _| async move {
                assert_eq!(r.uri().path(), format!("/hook/{path}"));
                assert_eq!(r.headers()["x-hapi-hook-token"], "token");
                assert_eq!(
                    serde_json::from_slice::<Value>(&r.collect().await.unwrap().to_bytes())
                        .unwrap()["hook_event_name"],
                    body
                );
                reply(status, "application/json", answer)
            })
            .await
            .unwrap();
            assert_eq!(
                forward(
                    args(server.port, flavor, event),
                    json!({"hook_event_name":body}).to_string().into_bytes()
                )
                .await
                .unwrap(),
                expected
            );
        }
    }
    #[tokio::test]
    async fn delayed_permission_and_unreachable_bridge() {
        let server = Listener::bind(|_, _, _| async {
            tokio::time::sleep(Duration::from_millis(1100)).await;
            reply(200, "application/json", r#"{"behavior":"deny"}"#)
        })
        .await
        .unwrap();
        let port = server.port;
        assert!(forward(
            args(port, "claude", ""),
            br#"{"hook_event_name":"PermissionRequest"}"#.to_vec()
        )
        .await
        .unwrap()
        .is_some());
        server.shutdown().await;
        assert_eq!(
            forward(args(port, "agy", "pre-invocation"), vec![])
                .await
                .unwrap(),
            Some(json!({}))
        );
        assert!(forward(args(port, "claude", ""), vec![]).await.is_err());
    }
}
