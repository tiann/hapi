use crate::config::Config;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{
    header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE},
    Method, Request,
};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::{
    client::legacy::{connect::HttpConnector, Client},
    rt::TokioExecutor,
};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde_json::{json, Value};
use std::{io, time::Duration};

pub struct SessionResponse {
    pub session: Value,
    pub session_summary_contract: Option<bool>,
    pub auto_bridge_transient_model_errors: Option<bool>,
}
impl SessionResponse {
    fn parse(body: Value) -> io::Result<Self> {
        Ok(Self {
            session_summary_contract: body["sessionSummaryContract"].as_bool(),
            auto_bridge_transient_model_errors: body["autoBridgeTransientModelErrors"].as_bool(),
            session: resource(body, "session")?,
        })
    }
}

type PlainClient = Client<HttpConnector, Full<Bytes>>;
type SecureClient = Client<HttpsConnector<HttpConnector>, Full<Bytes>>;

#[derive(Clone)]
enum Transport {
    Http(PlainClient),
    Https {
        hub: SecureClient,
        webhook: PlainClient,
    },
}

#[derive(Clone)]
pub struct Rest {
    client: Transport,
    base: String,
    headers: HeaderMap,
}

impl Rest {
    pub async fn new(config: &Config) -> io::Result<Self> {
        let uri: hyper::Uri = config.api_url.parse().map_err(io::Error::other)?;
        let builder = Client::builder(TokioExecutor::new());
        let plain = builder.build_http();
        let client = match uri.scheme_str() {
            Some("http") => Transport::Http(plain),
            Some("https") => {
                let connector = HttpsConnectorBuilder::new()
                    .with_tls_config((*crate::sio::eio::tls_config().await?).clone())
                    .https_only()
                    .enable_http1()
                    .build();
                Transport::Https {
                    hub: builder.build(connector),
                    webhook: plain,
                }
            }
            _ => return Err(io::Error::other("Expected HTTP or HTTPS hub URL")),
        };
        let mut headers = HeaderMap::new();
        for (name, value) in &config.extra_headers {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).map_err(io::Error::other)?,
                HeaderValue::from_str(value).map_err(io::Error::other)?,
            );
        }
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", config.cli_api_token))
                .map_err(io::Error::other)?,
        );
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        Ok(Self {
            client,
            base: config.api_url.trim_end_matches('/').into(),
            headers,
        })
    }

    async fn request(
        &self,
        url: String,
        headers: HeaderMap,
        body: Option<Value>,
        timeout: Duration,
    ) -> io::Result<Value> {
        let method = if body.is_some() {
            Method::POST
        } else {
            Method::GET
        };
        let (status, bytes) = self.send(method, url, headers, body, timeout).await?;
        if !status.is_success() {
            return Err(io::Error::other(format!("HTTP {status}")));
        }
        let text = std::str::from_utf8(&bytes).map_err(io::Error::other)?;
        Ok(crate::sio::packet::decode_json(text)?)
    }

    async fn send(
        &self,
        method: Method,
        url: String,
        headers: HeaderMap,
        body: Option<Value>,
        timeout: Duration,
    ) -> io::Result<(hyper::StatusCode, Bytes)> {
        let data = body
            .map(|v| serde_json::to_vec(&v))
            .transpose()?
            .unwrap_or_default();
        let mut req = Request::builder()
            .method(method)
            .uri(url)
            .body(Full::new(Bytes::from(data)))
            .map_err(io::Error::other)?;
        *req.headers_mut() = headers;
        tokio::time::timeout(timeout, async {
            let res = match &self.client {
                Transport::Http(http) => http.request(req),
                Transport::Https { hub, webhook } => {
                    if req.uri().scheme_str() == Some("http") {
                        webhook.request(req)
                    } else {
                        hub.request(req)
                    }
                }
            }
            .await
            .map_err(io::Error::other)?;
            let status = res.status();
            let bytes = res
                .into_body()
                .collect()
                .await
                .map_err(io::Error::other)?
                .to_bytes();
            Ok((status, bytes))
        })
        .await?
    }

    async fn hub(&self, path: &str, body: Option<Value>, seconds: u64) -> io::Result<Value> {
        self.request(
            format!("{}{path}", self.base),
            self.headers.clone(),
            body,
            Duration::from_secs(seconds),
        )
        .await
    }

    pub async fn machine(&self, id: &str, metadata: Value) -> io::Result<Value> {
        let v = self
            .hub(
                "/cli/machines",
                Some(json!({"id":id,"metadata":metadata,"runnerState":null})),
                60,
            )
            .await?;
        resource(v, "machine")
    }

    pub async fn create(&self, body: Value) -> io::Result<SessionResponse> {
        SessionResponse::parse(self.hub("/cli/sessions", Some(body), 60).await?)
    }
    pub async fn session(&self, id: &str) -> io::Result<SessionResponse> {
        SessionResponse::parse(self.hub(&session_path(id), None, 60).await?)
    }
    pub async fn refresh(&self, id: &str) -> io::Result<Value> {
        self.hub(&session_path(id), None, 15)
            .await?
            .get("session")
            .cloned()
            .ok_or_else(|| io::Error::other("Invalid session response"))
    }

    pub async fn messages(&self, id: &str, after: i64) -> io::Result<Vec<Value>> {
        let path = format!("{}/messages?afterSeq={after}&limit=200", session_path(id));
        let v = self.hub(&path, None, 15).await?;
        v["messages"]
            .as_array()
            .filter(|rows| {
                rows.iter().all(|r| {
                    r["id"].is_string()
                        && r["seq"].is_i64()
                        && r["createdAt"].is_number()
                        && (r["localId"].is_null() || r["localId"].is_string())
                        && (r["invokedAt"].is_null() || r["invokedAt"].is_number())
                })
            })
            .cloned()
            .ok_or_else(|| io::Error::other("Invalid /cli/sessions/:id/messages response"))
    }
}
fn resource(mut v: Value, key: &str) -> io::Result<Value> {
    let row = &v[key];
    let common = row["id"].is_string()
        && row["namespace"].is_string()
        && row["active"].is_boolean()
        && ["seq", "createdAt", "updatedAt", "metadataVersion"]
            .iter()
            .all(|k| row[k].is_u64())
        && row
            .get("metadata")
            .is_some_and(|m| m.is_object() || m.is_null());
    let valid = if key == "session" {
        row["thinking"].is_boolean()
            && row["thinkingAt"].is_number()
            && row["agentStateVersion"].is_u64()
            && (row["activeAt"].is_null() || row["activeAt"].is_number())
            && row
                .get("agentState")
                .is_some_and(|v| v.is_null() || v.is_object())
            && (row["metadata"].is_null() || crate::schemas::metadata(&row["metadata"]))
    } else {
        row["activeAt"].is_number()
            && row["runnerStateVersion"].is_u64()
            && row
                .get("runnerState")
                .is_some_and(|s| s.is_object() || s.is_null())
    };
    if !common || !valid {
        return Err(io::Error::other(format!("Invalid {key} response")));
    }
    let mut row = v[key].take();
    if key == "session" && row["activeAt"].is_null() {
        row["activeAt"] = 0.into();
    }
    Ok(row)
}
fn encode_component(value: &str) -> String {
    const COMPONENT: &percent_encoding::AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    utf8_percent_encode(value, COMPONENT).to_string()
}
fn session_path(id: &str) -> String {
    format!("/cli/sessions/{}", encode_component(id))
}

impl Rest {
    pub async fn report_started(
        &self,
        home: &std::path::Path,
        id: &str,
        metadata: &Value,
    ) -> io::Result<Value> {
        let state: Value =
            serde_json::from_slice(&tokio::fs::read(home.join("runner.state.json")).await?)?;
        let port = state["httpPort"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .filter(|p| *p > 0)
            .ok_or_else(|| io::Error::other("No runner running, no state file found"))?;
        let pid = state["pid"]
            .as_u64()
            .and_then(|p| u32::try_from(p).ok())
            .unwrap_or_default();
        if !crate::lifecycle::start_marker::alive(pid) {
            return Err(io::Error::other("Runner is not running, file is stale"));
        }
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let timeout = std::env::var("HAPI_RUNNER_HTTP_TIMEOUT")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|s| {
                s.trim_start()
                    .trim_start_matches('+')
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse::<u64>()
            })
            .transpose()
            .map_err(io::Error::other)?
            .unwrap_or(10000);
        self.request(
            format!("http://127.0.0.1:{port}/session-started"),
            headers,
            Some(json!({"sessionId":id,"metadata":metadata})),
            Duration::from_millis(timeout),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
    };

    #[test]
    fn session_response_parity() {
        let row = json!({"id":"s","namespace":"default","seq":0,"createdAt":1,"updatedAt":1,"active":false,"metadataVersion":1,"agentStateVersion":1,"agentState":null,"thinking":false,"thinkingAt":0,"metadata":null});
        for (active_at, expected) in [(None, 0), (Some(Value::Null), 0), (Some(json!(7)), 7)] {
            for bridge in [Some(true), Some(false), None] {
                let mut session = row.clone();
                if let Some(v) = &active_at {
                    session["activeAt"] = v.clone();
                }
                let mut body = json!({"session":session});
                if let Some(b) = bridge {
                    body["autoBridgeTransientModelErrors"] = b.into();
                }
                let parsed = SessionResponse::parse(body).unwrap();
                assert_eq!(parsed.session["activeAt"], expected);
                assert_eq!(parsed.auto_bridge_transient_model_errors, bridge);
            }
        }
    }

    #[tokio::test]
    async fn session_title_truncated_through_a_surrogate_pair_decodes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Config {
            home: Default::default(),
            api_url: format!("http://{}", listener.local_addr().unwrap()),
            cli_api_token: "token".into(),
            extra_headers: vec![],
            machine_id: None,
        };
        let rest = Rest::new(&config).await.unwrap();
        let body = r#"{"session":{"id":"s","namespace":"default","seq":0,"createdAt":1,"updatedAt":1,"active":false,"activeAt":null,"metadataVersion":1,"agentStateVersion":1,"agentState":null,"thinking":false,"thinkingAt":0,"metadata":{"host":"h","path":"/","name":"fix \ud83d","summary":{"text":"😀 ok \ude00","updatedAt":1}}}}"#;
        let serve = async {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(&mut stream).lines();
            while !reader.next_line().await.unwrap().unwrap().is_empty() {}
            let head = format!(
                "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            stream.write_all(head.as_bytes()).await.unwrap();
            stream.write_all(body.as_bytes()).await.unwrap();
        };
        let (response, ()) = tokio::join!(rest.session("s"), serve);
        let metadata = &response.unwrap().session["metadata"];
        assert_eq!(metadata["name"], "fix \u{fffd}");
        assert_eq!(metadata["summary"]["text"], "\u{1f600} ok \u{fffd}");
    }
}
