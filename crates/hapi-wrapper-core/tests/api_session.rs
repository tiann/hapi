use hapi_wrapper_core::{config::Config, rest::Rest};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdout, Command},
    time::timeout,
};

const LIMIT: Duration = Duration::from_secs(5);
struct Hub {
    child: Child,
    lines: Lines<BufReader<ChildStdout>>,
    config: Config,
    _dir: tempfile::TempDir,
}
impl Hub {
    async fn new() -> Self {
        let mut child = Command::new("bun")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/session_hub.cjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let port = timeout(LIMIT, lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("runner.state.json"),
            json!({"pid":child.id(),"httpPort":port}).to_string(),
        )
        .unwrap();
        let config = Config {
            home: dir.path().into(),
            api_url: format!("http://127.0.0.1:{port}"),
            cli_api_token: "token".into(),
            extra_headers: vec![
                ("x-fixture".into(), "extra".into()),
                ("authorization".into(), "conflict".into()),
            ],
            machine_id: Some("m".into()),
        };
        Self {
            child,
            lines,
            config,
            _dir: dir,
        }
    }
    async fn command(&mut self, op: &str, value: Value) -> Value {
        let line = format!("{}\n", json!({"op":op,"value":value}));
        self.child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(line.as_bytes())
            .await
            .unwrap();
        let answer = timeout(LIMIT, self.lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::from_str(&answer).unwrap()
    }
}
#[tokio::test]
async fn webhook_is_best_effort_and_does_not_send_to_a_stale_port() {
    let mut hub = Hub::new().await;
    let state = hub.config.home.join("runner.state.json");
    let rest = Rest::new(&hub.config).await.unwrap();
    for invalid in [None, Some("not json"), Some(r#"{"pid":0,"httpPort":1}"#)] {
        if let Some(data) = invalid {
            std::fs::write(&state, data).unwrap();
        } else {
            std::fs::remove_file(&state).unwrap();
        }
        assert!(rest
            .report_started(&hub.config.home, "s", &json!({}))
            .await
            .is_err());
    }
    assert!(hub.command("snapshot", Value::Null).await["requests"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[tokio::test]
async fn plain_rest_and_webhook_work_without_tls_roots() {
    if std::env::var_os("HAPI_TEST_EMPTY_ROOTS").is_none() {
        let empty = tempfile::tempdir().unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "plain_rest_and_webhook_work_without_tls_roots"])
            .env("HAPI_TEST_EMPTY_ROOTS", "1")
            .env("SSL_CERT_DIR", empty.path())
            .env("SSL_CERT_FILE", empty.path().join("missing.pem"))
            .env_remove("NODE_EXTRA_CA_CERTS")
            .status()
            .await
            .unwrap();
        assert!(status.success());
        return;
    }
    let mut hub = Hub::new().await;
    let rest = Rest::new(&hub.config).await.unwrap();
    assert_eq!(rest.session("s").await.unwrap().session["id"], "s");
    let started = rest.report_started(&hub.config.home, "s", &json!({})).await;
    if cfg!(unix) {
        started.unwrap();
    } else {
        assert_eq!(
            started.unwrap_err().to_string(),
            "Runner is not running, file is stale"
        );
    }
    hub.config.api_url = "https://localhost".into();
    assert!(Rest::new(&hub.config).await.is_err());
}
#[tokio::test]
async fn https_hub_and_plain_runner_webhook_share_rest_client() {
    if std::env::var_os("HAPI_TEST_HTTPS_HUB").is_none() {
        let ca = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/test-ca.pem");
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "https_hub_and_plain_runner_webhook_share_rest_client",
            ])
            .env("HAPI_TEST_HTTPS_HUB", "1")
            .env("NODE_EXTRA_CA_CERTS", ca)
            .status()
            .await
            .unwrap();
        assert!(status.success());
        return;
    }

    let mut hub = Hub::new().await;
    let port = hub.command("startTls", Value::Null).await.as_u64().unwrap();
    hub.config.api_url = format!("https://localhost:{port}");
    let rest = Rest::new(&hub.config).await.unwrap();
    let session = rest.session("s").await.unwrap().session;
    assert_eq!(session["id"], "s");
    let started = rest
        .report_started(&hub.config.home, "s", &session["metadata"])
        .await;
    let snapshot = hub.command("snapshot", Value::Null).await;
    let requests = snapshot["requests"].as_array().unwrap();
    assert_eq!(requests[0]["path"], "/cli/sessions/s");
    if !cfg!(unix) {
        assert_eq!(
            started.unwrap_err().to_string(),
            "Runner is not running, file is stale"
        );
        assert_eq!(requests.len(), 1);
        return;
    }
    started.unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["path"], "/session-started");
    assert_eq!(
        requests[1]["body"],
        json!({"sessionId":"s","metadata":session["metadata"]})
    );
}
