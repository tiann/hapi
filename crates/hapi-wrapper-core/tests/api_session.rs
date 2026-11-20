use hapi_wrapper_core::{
    config::Config,
    rest::Rest,
    session::{
        bootstrap::{bootstrap, Options},
        client::{Cancellation, SessionClient, SessionEvent},
    },
};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdout, Command},
    sync::mpsc,
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
    async fn start(&self) -> (Arc<SessionClient>, mpsc::UnboundedReceiver<SessionEvent>) {
        SessionClient::start(&self.config,Rest::new(&self.config).await.unwrap(),&json!({"id":"s","metadata":{"host":"test","path":"/tmp"},"metadataVersion":1,"agentState":{},"agentStateVersion":1})).unwrap()
    }
}
async fn wait(
    events: &mut mpsc::UnboundedReceiver<SessionEvent>,
    predicate: impl Fn(&SessionEvent) -> bool,
) {
    timeout(LIMIT, async {
        while let Some(e) = events.recv().await {
            if predicate(&e) {
                return;
            }
        }
        panic!("client closed")
    })
    .await
    .unwrap();
}
fn message(id: &str, n: i64, from: &str) -> Value {
    json!({"id":id,"seq":n,"createdAt":n,"localId":id,"content":{"role":"user","content":{"type":"text","text":id},"meta":{"sentFrom":from}}})
}
#[tokio::test]
async fn create_and_reopen_through_webhook() {
    if std::env::var_os("HAPI_BOOTSTRAP_TEST_CHILD").is_none() {
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "create_and_reopen_through_webhook"])
            .env("HAPI_BOOTSTRAP_TEST_CHILD", "1")
            .env("HAPI_SESSION_ID", "parent")
            .env("HAPI_WRAPPER_CLI_VERSION", "test-version")
            .env("HAPI_WRAPPER_RUNTIME_PATH", "/runtime")
            .status()
            .await
            .unwrap();
        assert!(status.success());
        return;
    }
    let mut h = Hub::new().await;
    let id = uuid::Uuid::new_v4().to_string();
    let opts = Options {
        flavor: "claude".into(),
        reserved_id: Some(id.clone()),
        runner: true,
        overrides: hapi_wrapper_core::session::metadata::Overrides {
            fields: [("name".into(), Some("preserved".into()))].into(),
            ..Default::default()
        },
        ..Default::default()
    };
    h.command("contract", true.into()).await;
    let created = bootstrap(&h.config, &opts, true, true, |_| false)
        .await
        .unwrap();
    assert_eq!(created.session_summary_contract, Some(true));
    assert_eq!(std::env::var("HAPI_SESSION_ID").unwrap(), "parent");
    let child = Command::new("printenv")
        .arg("HAPI_SESSION_ID")
        .envs(&created.child_env)
        .output()
        .await
        .unwrap();
    assert_eq!(String::from_utf8(child.stdout).unwrap().trim(), id);
    assert!(created.client.flush(LIMIT).await);
    let state = h.command("snapshot", Value::Null).await;
    let req = state["requests"].as_array().unwrap();
    assert_eq!(
        req.iter()
            .map(|r| r["path"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["/cli/machines", "/cli/sessions", "/session-started"]
    );
    assert_eq!(req[1]["body"]["id"], id);
    assert_eq!(req[1]["body"]["adopt"], true);
    assert_eq!(
        req[2]["body"],
        json!({"sessionId":id,"metadata":created.metadata})
    );
    assert_eq!(created.metadata["wrapperRuntime"], "rust");
    assert!(created.metadata["hostStartMarker"].is_string());
    assert!(req[0]["body"]["metadata"].get("capabilities").is_none());
    created.client.close();
    let mut stale = created.metadata.clone();
    stale["capabilities"]["conversationHistory"] = json!({"rewindToMessage":true});
    stale["summary"] = json!({"text":"previous","updatedAt":1});
    stale["claudeRewind"] = json!({"targetLocalId":"t","truncateFromLocalId":"cut","keepBoundary":"k","droppedPrompts":["p"],"hubCutApplied":true});
    stale["externalRefs"] = json!([]);
    h.command("metadata", json!({"metadata":stale})).await;
    let mut opts = Options {
        existing_id: Some(id.clone()),
        runner: false,
        ..opts
    };
    opts.overrides.fields.insert("summary".into(), None);
    opts.overrides
        .capabilities
        .insert("conversationHistory".into(), None);
    h.command("contract", false.into()).await;
    let opened = bootstrap(&h.config, &opts, false, true, |_| true)
        .await
        .unwrap();
    let snapshot = h.command("snapshot", Value::Null).await;
    for metadata in [&opened.metadata, &snapshot["row"]["metadata"]] {
        assert!(metadata.get("summary").is_none());
        assert_eq!(metadata["capabilities"], json!({"terminal":true}));
        assert_eq!(
            metadata["claudeRewind"],
            json!({"targetLocalId":"t","truncateFromLocalId":"cut","keepBoundary":"k","droppedPrompts":["p"]})
        );
        assert_eq!(metadata["externalRefs"], json!([]));
    }
    assert!(opened.child_env.is_empty());
    assert_eq!(opened.session_summary_contract, Some(false));
    assert_eq!(opened.client.metadata.get().value["name"], "preserved");
    assert!(opened
        .client
        .metadata
        .get()
        .value
        .get("hostStartMarker")
        .is_none());
    opened.client.close();
    for (fields, flavor, expected) in [
        (
            json!({"lifecycleState":"archived","archivedBy":"hub"}),
            "claude",
            "is hub-archived",
        ),
        (
            json!({"codexRuntime":{"kind":"attached"}}),
            "codex",
            "require hapi attach",
        ),
        (
            json!({"codexArchivedFork":{}}),
            "codex",
            "pending archived fork",
        ),
    ] {
        h.command("metadata", json!({"metadata":{"path":"/","host":"x"}}))
            .await;
        let mut value = json!({"host":"test","path":"/"});
        value
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        h.command("metadata", json!({"metadata":value})).await;
        let opts = Options {
            existing_id: Some(id.clone()),
            flavor: flavor.into(),
            ..Default::default()
        };
        assert!(bootstrap(&h.config, &opts, false, true, |_| false)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains(expected));
    }
    h.command("metadata",json!({"metadata":{"host":"test","path":"/","codexRuntime":{"kind":"attached"},"conversationHistoryDiverged":true}})).await;
    let attached = Options {
        existing_id: Some(id.clone()),
        flavor: "codex".into(),
        overrides: hapi_wrapper_core::session::metadata::Overrides {
            fields: [("codexRuntime".into(), Some(json!({"kind":"attached"})))].into(),
            ..Default::default()
        },
        ..Default::default()
    };
    let err = bootstrap(&h.config, &attached, false, false, |_| false)
        .await
        .err()
        .unwrap();
    assert!(err.to_string().contains("Native history changed"));
    let mut fresh = Options {
        flavor: "claude".into(),
        reserved_id: Some("legacy-stamp".into()),
        ..Default::default()
    };
    let rest = Rest::new(&h.config).await.unwrap();
    h.command("contract", Value::Null).await;
    let prepared = hapi_wrapper_core::session::bootstrap::prepare(&rest, &h.config, &fresh)
        .await
        .unwrap();
    assert!(prepared.session_summary_contract.is_none());
    let state = h.command("snapshot", Value::Null).await;
    let body = &state["requests"].as_array().unwrap().last().unwrap()["body"];
    assert!(body.get("adopt").is_none());
    assert!(body.get("id").is_none());
    fresh.reserved_id = Some(id.clone());
    h.command("forceId", "unexpected".into()).await;
    let error = hapi_wrapper_core::session::bootstrap::prepare(&rest, &h.config, &fresh)
        .await
        .err()
        .unwrap();
    assert_eq!(
        error.to_string(),
        format!("Hub returned unexpected session id unexpected (reserved {id})")
    );
}
#[tokio::test]
async fn archive_from_success_mismatch_live_or_rest() {
    for source in ["archive-success", "archive-mismatch", "live", "rest"] {
        let mut h = Hub::new().await;
        let (client, mut events) = h.start().await;
        wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
        let meta =
            json!({"path":"/tmp","host":"test","lifecycleState":"archived","archivedBy":"hub"});
        match source {
            "live" => {
                h.command(
                    "update",
                    json!({"t":"update-session","metadata":{"version":2,"value":meta}}),
                )
                .await;
            }
            "rest" => {
                h.command("metadata", json!({"metadataVersion":2,"metadata":meta}))
                    .await;
                h.command("drop", Value::Null).await;
            }
            _ => {
                h.command("ackMode", source.into()).await;
                client.metadata.update(Clone::clone);
            }
        }
        wait(&mut events, |e| matches!(e, SessionEvent::HubArchived)).await;
        assert!(client.hub_archived());
        assert!(*client.archive_notifications().borrow());
        client.metadata.update(|_| panic!("archived CAS"));
        assert!(client.flush_metadata(LIMIT).await);
        client.close();
    }
}
#[tokio::test]
async fn reconnect_reconciles_backfills_replays_and_flushes() {
    let mut h = Hub::new().await;
    let (client, mut events) = h.start().await;
    client.keep_alive(true, Some("remote"), &json!({"effort":"high"}));
    let (tx, mut users) = mpsc::unbounded_channel();
    client.on_user_message(Arc::new(move |v, _| {
        tx.send(v).unwrap();
    }));
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    h.command(
        "update",
        json!({"t":"new-message","message":message("local",1,"cli")}),
    )
    .await;
    h.command(
        "update",
        json!({"t":"new-message","message":message("first",2,"web")}),
    )
    .await;
    assert_eq!(
        timeout(LIMIT, users.recv()).await.unwrap().unwrap()["content"]["text"],
        "first"
    );
    let mut rows: Vec<_> = (3..204)
        .map(|i| message(&i.to_string(), i, "cli"))
        .collect();
    rows.push(message("last", 204, "web"));
    h.command("rows", rows.into()).await;
    h.command("drop", Value::Null).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Disconnected)).await;
    client.session_end(Some("completed"));
    assert!(client.flush(LIMIT).await);
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    assert_eq!(users.try_recv().unwrap()["content"]["text"], "last");
    assert!(users.try_recv().is_err());
    let state = h.command("snapshot", Value::Null).await;
    let req = state["requests"].as_array().unwrap();
    assert_eq!(req[0]["path"], "/cli/sessions/s");
    assert_eq!(req[1]["query"], "?afterSeq=2&limit=200");
    assert_eq!(req[2]["query"], "?afterSeq=202&limit=200");
    let events = state["emitted"].as_array().unwrap();
    let alive = events
        .iter()
        .filter(|e| e["event"] == "session-alive")
        .collect::<Vec<_>>();
    assert_eq!(alive.len(), 1);
    for e in alive {
        assert_eq!(e["payload"]["thinking"], true);
        assert_eq!(e["payload"]["effort"], "high");
    }
    assert!(events.iter().any(|e| e["event"] == "session-end"));
    h.command("ping", false.into()).await;
    assert!(!client.flush(Duration::from_millis(40)).await);
    client.close();
    assert!(!client.flush(LIMIT).await);
}
#[tokio::test]
async fn disconnect_during_cas_and_invalid_rest() {
    let mut h = Hub::new().await;
    let (c, mut e) = h.start().await;
    wait(&mut e, |e| matches!(e, SessionEvent::Connected)).await;
    h.command("ackMode", "drop".into()).await;
    c.metadata.update(|v| {
        let mut v = v.clone();
        v["name"] = "updated".into();
        v
    });
    assert!(c.flush_metadata(LIMIT).await);
    assert_eq!(c.metadata.get().version, 2);
    h.command(
        "metadata",
        json!({"metadataVersion":1,"metadata":{"path":"/","host":"old"}}),
    )
    .await;
    assert!(c.refresh_metadata().await);
    assert_eq!(c.metadata.get().value["name"], "updated");
    h.command("malformed", true.into()).await;
    assert!(!c.refresh_metadata().await);
    h.child.kill().await.unwrap();
    wait(&mut e, |e| matches!(e, SessionEvent::Disconnected)).await;
    assert!(!c.flush(Duration::from_millis(30)).await);
    assert!(!c.refresh_metadata().await);
    c.close();
}
#[tokio::test]
async fn cancel_retry_and_wire_payloads() {
    let mut h = Hub::new().await;
    let (c, mut e) = h.start().await;
    wait(&mut e, |e| matches!(e, SessionEvent::Connected)).await;
    let row = message("row", 1, "web");
    h.command("update", json!({"t":"new-message","message":row}))
        .await;
    assert_eq!(
        h.command("ack", json!({"t":"cancel-queued-message","localId":"row"}))
            .await,
        json!({"removed":true,"inFlight":false,"indeterminate":false,"consumed":false})
    );
    for (result, expected) in [
        (
            Cancellation::Consumed,
            json!({"removed":false,"accepted":false,"consumed":true}),
        ),
        (
            Cancellation::InFlight,
            json!({"removed":false,"accepted":false}),
        ),
        (
            Cancellation::Indeterminate,
            json!({"removed":false,"accepted":true}),
        ),
    ] {
        c.on_cancel(Arc::new(move |_| Box::pin(async move { Ok(result) })));
        c.on_retry(Arc::new(|_| Box::pin(async { Ok(true) })));
        assert_eq!(
            h.command(
                "ack",
                json!({"t":"retry-queued-message","localId":"row","message":row})
            )
            .await,
            expected
        );
    }
    let (tx, mut users) = mpsc::unbounded_channel();
    c.on_user_message(Arc::new(move |_, id| {
        tx.send(id).unwrap();
    }));
    assert_eq!(users.try_recv().unwrap().as_deref(), Some("row"));
    assert!(users.try_recv().is_err());
    c.send_session_event(json!({"type":"ready"}), Some("inner"), Some("outer"));
    c.send_user_message("hello", &Value::Null, Some("local"));
    c.send_agent_message(json!({"test":true}), None);
    assert!(c.steer_state(&["local".into()], "dispatching").await);
    let state = h.command("snapshot", Value::Null).await;
    let events = state["emitted"].as_array().unwrap();
    let messages: Vec<_> = events
        .iter()
        .filter(|e| e["event"] == "message")
        .map(|e| &e["payload"])
        .collect();
    assert_eq!(messages[0]["localId"], "outer");
    assert_eq!(messages[0]["message"]["content"]["id"], "inner");
    assert_eq!(messages[1]["message"]["role"], "user");
    assert_eq!(messages[2]["message"]["content"]["type"], "codex");
    assert!(
        events
            .iter()
            .any(|e| e["event"] == "messages-consumed"
                && e["payload"]["localIds"] == json!(["local"]))
    );
    c.close();
}

#[tokio::test]
async fn rpc_registers_before_alive_and_replies_with_json_strings() {
    let mut h = Hub::new().await;
    let (c, mut events) = h.start().await;
    c.rpc.register("echo", |v| async move { Ok(Some(v)) });
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    c.rpc.register("switch", |_| async { Ok(None) });
    assert_eq!(
        h.command(
            "rpc",
            json!({"method":"s:echo","params":"{\"accepted\":true}"})
        )
        .await,
        json!("{\"accepted\":true}")
    );
    assert_eq!(
        h.command("rpc", json!({"method":"s:switch","params":"{}"}))
            .await,
        Value::Null
    );
    assert_eq!(
        h.command("rpc", json!({"method":"wrong:echo","params":"{}"}))
            .await,
        json!("{\"error\":\"Method not found\"}")
    );
    h.command("drop", Value::Null).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Disconnected)).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    assert!(c.flush(LIMIT).await);
    let snapshot = h.command("snapshot", Value::Null).await;
    let wire: Vec<_> = snapshot["emitted"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| match e["event"].as_str() {
            Some("rpc-register") => e["payload"]["method"].as_str(),
            Some("session-alive") => Some("alive"),
            _ => None,
        })
        .collect();
    assert_eq!(
        wire,
        ["s:echo", "alive", "s:switch", "s:echo", "s:switch", "alive"]
    );
    c.close();
}

#[tokio::test]
async fn final_flush_explicitly_reconnects_after_namespace_disconnect() {
    let mut hub = Hub::new().await;
    let (client, mut events) = hub.start().await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    hub.command("disconnect", Value::Null).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Disconnected)).await;
    client.session_end(Some("completed"));
    assert!(client.flush(LIMIT).await);
    let state = hub.command("snapshot", Value::Null).await;
    assert!(state["emitted"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["event"] == "session-end"));
    client.close();
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
async fn native_queued_cli_rows_require_concurrent_clients_and_local_id() {
    let mut hub = Hub::new().await;
    let (client, mut events) = hub.start().await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    let (tx, mut users) = mpsc::unbounded_channel();
    client.on_user_message(Arc::new(move |v, id| {
        tx.send((v, id)).unwrap();
    }));
    let mut row = message("first", 1, "cli");
    row["content"]["meta"]["isNativeQueuedMessage"] = true.into();
    hub.command("update", json!({"t":"new-message","message":row}))
        .await;
    hub.command("update",json!({"t":"update-session","metadata":{"version":2,"value":{"host":"test","path":"/","capabilities":{"concurrentClients":true}}}})).await;
    row["id"] = "second".into();
    row["localId"] = Value::Null;
    hub.command("update", json!({"t":"new-message","message":row}))
        .await;
    row["id"] = "third".into();
    row["localId"] = "deliver".into();
    hub.command("update", json!({"t":"new-message","message":row}))
        .await;
    assert_eq!(
        timeout(LIMIT, users.recv())
            .await
            .unwrap()
            .unwrap()
            .1
            .as_deref(),
        Some("deliver")
    );
    assert!(users.try_recv().is_err());
    client.close();
}

async fn advance_heartbeat() {
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(11)).await;
    tokio::task::yield_now().await;
    tokio::time::resume();
}

#[tokio::test]
async fn heartbeat_drops_offline_and_stays_stopped_after_end() {
    let mut hub = Hub::new().await;
    let (client, mut events) = hub.start().await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    advance_heartbeat().await;
    assert!(client.flush(LIMIT).await);
    let before = hub.command("snapshot", Value::Null).await;
    let count = |state: &Value| {
        state["emitted"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["event"] == "session-alive")
            .count()
    };
    assert_eq!(count(&before), 2);
    hub.command("disconnect", Value::Null).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Disconnected)).await;
    client.keep_alive(true, Some("remote"), &json!({"model":"offline"}));
    advance_heartbeat().await;
    assert!(client.flush(LIMIT).await);
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    client.session_end(Some("completed"));
    client.keep_alive(false, Some("remote"), &Value::Null);
    advance_heartbeat().await;
    assert!(client.flush(LIMIT).await);
    let after = hub.command("snapshot", Value::Null).await;
    assert_eq!(count(&after), 3);
    let emitted = after["emitted"].as_array().unwrap();
    let end = emitted
        .iter()
        .position(|e| e["event"] == "session-end")
        .unwrap();
    assert!(emitted[end..].iter().all(|e| e["event"] != "session-alive"));
    assert_eq!(
        emitted[..end]
            .iter()
            .rfind(|e| e["event"] == "session-alive")
            .unwrap()["payload"]["model"],
        "offline"
    );
    client.close();
}

#[tokio::test]
async fn archived_drop_stops_cas_and_reconnect() {
    let mut hub = Hub::new().await;
    let (client, mut events) = hub.start().await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    hub.command("ackMode", "hold".into()).await;
    client.agent_state.update(Clone::clone);
    timeout(LIMIT, async {
        loop {
            let state = hub.command("snapshot", Value::Null).await;
            if state["emitted"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["event"] == "update-state")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    hub.command("update",json!({"t":"update-session","metadata":{"version":2,"value":{"path":"/","host":"test","lifecycleState":"archived","archivedBy":"hub"}}})).await;
    wait(&mut events, |e| matches!(e, SessionEvent::HubArchived)).await;
    let before = hub.command("snapshot", Value::Null).await;
    advance_heartbeat().await;
    client.keep_alive(true, Some("remote"), &Value::Null);
    hub.command("drop", Value::Null).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Disconnected)).await;
    assert!(
        !timeout(Duration::from_millis(200), client.agent_state.drain())
            .await
            .unwrap()
    );
    assert!(
        !timeout(Duration::from_millis(200), client.metadata.drain())
            .await
            .unwrap()
    );
    assert!(!timeout(Duration::from_millis(200), client.flush(LIMIT))
        .await
        .unwrap());
    advance_heartbeat().await;
    let after = hub.command("snapshot", Value::Null).await;
    assert_eq!(after["connections"], before["connections"]);
    assert_eq!(after["emitted"], before["emitted"]);
    client.close();
}

#[tokio::test]
async fn stale_refresh_cannot_announce_connected() {
    let mut hub = Hub::new().await;
    let (client, mut events) = hub.start().await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    hub.command("holdRefresh", Value::Null).await;
    hub.command("drop", Value::Null).await;
    wait(&mut events, |e| matches!(e, SessionEvent::ConnectionStart)).await;
    timeout(LIMIT, async {
        while hub.command("snapshot", Value::Null).await["refreshPending"] != true {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    hub.command("disconnect", Value::Null).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Disconnected)).await;
    assert!(client.flush(LIMIT).await);
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    hub.command("releaseRefresh", Value::Null).await;
    assert!(timeout(Duration::from_millis(150), events.recv())
        .await
        .is_err());
    hub.command("malformed", "missing".into()).await;
    let before = client.metadata.get();
    assert!(!client.refresh_metadata().await);
    assert_eq!(client.metadata.get().version, before.version);
    assert_eq!(client.metadata.get().value, before.value);
    client.close();
}

#[tokio::test]
async fn failed_dial_is_a_connect_error() {
    let mut h = Hub::new().await;
    h.child.kill().await.unwrap();
    let (client, mut e) = h.start().await;
    for _ in 0..2 {
        assert!(matches!(
            timeout(LIMIT, e.recv()).await.unwrap(),
            Some(SessionEvent::ConnectError { fatal: false, .. })
        ));
    }
    client.close();
}

#[tokio::test]
async fn replay_completes_before_live_callback() {
    let mut h = Hub::new().await;
    let (c, mut events) = h.start().await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    for (n, id) in [(1, "first"), (2, "second")] {
        h.command(
            "update",
            json!({"t":"new-message","message":message(id,n,"web")}),
        )
        .await;
    }
    h.command("update", json!({"t":"barrier"})).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Message(_))).await;
    let (tx, mut seen) = mpsc::unbounded_channel();
    let (resume, blocked) = std::sync::mpsc::sync_channel(1);
    let blocked = std::sync::Mutex::new(blocked);
    let replay = c.clone();
    let task = tokio::task::spawn_blocking(move || {
        replay.on_user_message(Arc::new(move |_, id| {
            let id = id.unwrap();
            tx.send(id.clone()).unwrap();
            if id == "first" {
                blocked.lock().unwrap().recv_timeout(LIMIT).unwrap();
            }
        }))
    });
    assert_eq!(timeout(LIMIT, seen.recv()).await.unwrap().unwrap(), "first");
    h.command(
        "update",
        json!({"t":"new-message","message":message("third",3,"web")}),
    )
    .await;
    h.command("update", json!({"t":"barrier"})).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Message(_))).await;
    assert!(seen.try_recv().is_err());
    resume.send(()).unwrap();
    task.await.unwrap();
    assert_eq!(seen.try_recv().unwrap(), "second");
    assert_eq!(seen.try_recv().unwrap(), "third");
    c.close();
}

#[tokio::test]
async fn queue_errors_invalid_user_and_steer_summary_payloads() {
    let mut h = Hub::new().await;
    let (c, mut events) = h.start().await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    let row = message("id", 1, "web");
    c.on_cancel(Arc::new(|_| {
        Box::pin(async { Err(std::io::Error::other("cancel failed")) })
    }));
    for kind in ["retry-queued-message", "cancel-queued-message"] {
        let ack = h
            .command("ack", json!({"t":kind,"localId":"id","message":row}))
            .await;
        assert_eq!(
            ack,
            json!({"removed":false,"accepted":false,"indeterminate":true})
        );
    }
    c.on_cancel(Arc::new(|_| {
        Box::pin(async { Ok(Cancellation::Indeterminate) })
    }));
    c.on_retry(Arc::new(|_| Box::pin(async { Ok(false) })));
    assert_eq!(
        h.command(
            "ack",
            json!({"t":"retry-queued-message","localId":"id","message":row})
        )
        .await,
        json!({"removed":false,"accepted":false})
    );
    c.on_retry(Arc::new(|_| {
        Box::pin(async { Err(std::io::Error::other("retry failed")) })
    }));
    assert_eq!(
        h.command(
            "ack",
            json!({"t":"retry-queued-message","localId":"id","message":row})
        )
        .await,
        json!({"removed":false,"accepted":false,"indeterminate":true})
    );
    for (i, content) in [
        json!({"role":"agent"}),
        json!({"role":"user","content":{"type":"text","text":"hello"},"localKey":5}),
    ]
    .into_iter()
    .enumerate()
    {
        h.command(
            "update",
            json!({"t":"new-message","message":{"seq":i+1,"content":content}}),
        )
        .await;
        wait(
            &mut events,
            |e| matches!(e,SessionEvent::Message(v) if *v==content),
        )
        .await;
    }
    c.send_claude_session_message(&json!({"type":"summary","summary":"skip"}));
    c.send_claude_session_message(&json!({"type":"summary","summary":"save","leafUuid":"leaf"}));
    c.send_agent_message(json!({"x":42}), Some("agent-id"));
    c.steer_indeterminate(&["row".into()]);
    h.command("steerReply", false.into()).await;
    assert!(!c.steer_state(&["row".into()], "queued").await);
    assert!(!c.steer_state(&[], "queued").await);
    assert!(c.flush(LIMIT).await);
    let state = h.command("snapshot", Value::Null).await;
    let emitted = state["emitted"].as_array().unwrap();
    assert_eq!(state["row"]["metadataVersion"], 2);
    assert_eq!(state["row"]["metadata"]["summary"]["text"], "save");
    assert!(state["row"]["metadata"]["summary"]["updatedAt"].is_u64());
    assert!(emitted.iter().any(|e| e["event"] == "message"
        && e["payload"]["localId"] == "agent-id"
        && e["payload"]["message"]["content"] == json!({"type":"codex","data":{"x":42}})));
    assert!(emitted
        .iter()
        .any(|e| e["event"] == "messages-consumed"
            && e["payload"]["localIds"] == json!(["agent-id"])));
    assert!(emitted
        .iter()
        .any(|e| e["event"] == "messages-indeterminate"
            && e["payload"]["localIds"] == json!(["row"])));
    c.close();
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
async fn replacement_backfill_resumes_pages_while_live_messages_advance() {
    for abort in [false, true] {
        let mut hub = Hub::new().await;
        let (client, mut events) = hub.start().await;
        wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
        let (tx, mut users) = mpsc::unbounded_channel();
        client.on_user_message(Arc::new(move |_, id| {
            tx.send(id.unwrap()).unwrap();
        }));
        hub.command(
            "update",
            json!({"t":"new-message","message":message("1",1,"web")}),
        )
        .await;
        assert_eq!(timeout(LIMIT, users.recv()).await.unwrap().unwrap(), "1");
        let rows: Vec<_> = (2..=440)
            .map(|seq| message(&seq.to_string(), seq, "web"))
            .collect();
        hub.command("rows", json!(rows)).await;
        hub.command("holdRefresh", Value::Null).await;
        hub.command(if abort { "holdPage" } else { "failPage" }, 201.into())
            .await;
        hub.command("drop", Value::Null).await;
        wait(&mut events, |e| matches!(e, SessionEvent::ConnectionStart)).await;
        timeout(LIMIT, async {
            while hub.command("snapshot", Value::Null).await["refreshPending"] != true {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        hub.command(
            "update",
            json!({"t":"new-message","message":message("440",440,"web")}),
        )
        .await;
        assert_eq!(timeout(LIMIT, users.recv()).await.unwrap().unwrap(), "440");
        hub.command("releaseRefresh", Value::Null).await;
        if abort {
            timeout(LIMIT, async {
                while hub.command("snapshot", Value::Null).await["pagePending"] != true {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        } else {
            wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
        }
        if abort {
            hub.command("drop", Value::Null).await;
            wait(&mut events, |e| matches!(e, SessionEvent::Disconnected)).await;
            wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
            hub.command("releasePage", Value::Null).await;
            for seq in 2..440 {
                assert_eq!(users.try_recv().unwrap(), seq.to_string());
            }
        } else {
            for seq in 2..440 {
                assert_eq!(
                    timeout(LIMIT, users.recv()).await.unwrap().unwrap(),
                    seq.to_string()
                );
            }
        }
        assert!(users.try_recv().is_err());
        let state = hub.command("snapshot", Value::Null).await;
        assert_eq!(state["connections"], if abort { 3 } else { 2 });
        let queries: Vec<_> = state["requests"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["path"] == "/cli/sessions/s/messages")
            .map(|r| r["query"].as_str().unwrap())
            .collect();
        assert_eq!(
            queries,
            [
                "?afterSeq=1&limit=200",
                "?afterSeq=201&limit=200",
                "?afterSeq=201&limit=200",
                "?afterSeq=401&limit=200"
            ]
        );
        client.close();
    }
}

#[tokio::test]
async fn close_during_callback_discards_pending_delivery_and_late_registration() {
    let mut hub = Hub::new().await;
    let (client, mut events) = hub.start().await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    for seq in 1..=2 {
        hub.command(
            "update",
            json!({"t":"new-message","message":message(&seq.to_string(),seq,"web")}),
        )
        .await;
    }
    hub.command("update", json!({"t":"barrier"})).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Message(_))).await;
    let (entered, mut seen) = mpsc::unbounded_channel();
    let (resume, blocked) = std::sync::mpsc::sync_channel(1);
    let blocked = std::sync::Mutex::new(blocked);
    let replay = client.clone();
    let task = tokio::task::spawn_blocking(move || {
        replay.on_user_message(Arc::new(move |_, id| {
            entered.send(id.unwrap()).unwrap();
            blocked.lock().unwrap().recv_timeout(LIMIT).unwrap();
        }))
    });
    assert_eq!(timeout(LIMIT, seen.recv()).await.unwrap().unwrap(), "1");
    hub.command(
        "update",
        json!({"t":"new-message","message":message("3",3,"web")}),
    )
    .await;
    hub.command("update", json!({"t":"barrier"})).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Message(_))).await;
    client.close();
    let callback: hapi_wrapper_core::session::client::UserHandler =
        Arc::new(|_, _| panic!("delivery after close"));
    client.on_user_message(callback.clone());
    assert_eq!(Arc::strong_count(&callback), 1);
    resume.send(()).unwrap();
    task.await.unwrap();
    assert!(seen.try_recv().is_err());
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

fn rewound_rows() -> Value {
    let mut rows: Vec<_> = (1..=40)
        .map(|n| {
            let mut row = message(&format!("old{n}"), n, "web");
            row["invokedAt"] = n.into();
            row
        })
        .collect();
    rows.push(message("queued", 41, "web"));
    rows.into()
}
fn opencode_rewind(operation: &str, phase: &str) -> Value {
    json!({"operationId":operation,"nativeSessionId":"native","workerId":"worker","requestedLocalId":"cut","nativeMessageId":"m","cutoffSeq":41,"sourceEpoch":0,"sourceMaxSeq":100,"reservationVersion":1,"sourceTranscriptHash":"0".repeat(64),"phase":phase})
}
fn claude_intent() -> Value {
    json!({"targetLocalId":"t","truncateFromLocalId":"cut","keepBoundary":"k","droppedPrompts":["dropped"],"hubCutApplied":true})
}
fn message_queries(state: &Value) -> Vec<String> {
    state["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["path"] == "/cli/sessions/s/messages")
        .map(|r| r["query"].as_str().unwrap().to_owned())
        .collect()
}
async fn rewind_fixture() -> (
    Hub,
    Arc<SessionClient>,
    mpsc::UnboundedReceiver<SessionEvent>,
    mpsc::UnboundedReceiver<String>,
) {
    let mut h = Hub::new().await;
    let (client, mut events) = h.start().await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    let (tx, users) = mpsc::unbounded_channel();
    client.on_user_message(Arc::new(move |_, id| {
        tx.send(id.unwrap()).unwrap();
    }));
    let mut users = users;
    h.command(
        "update",
        json!({"t":"new-message","message":message("before",100,"web")}),
    )
    .await;
    assert_eq!(
        timeout(LIMIT, users.recv()).await.unwrap().unwrap(),
        "before"
    );
    (h, client, events, users)
}
#[tokio::test]
async fn reconnect_after_hub_rewind_rescans_reused_sequences() {
    for variant in ["opencode", "claude"] {
        let (mut h, client, mut events, mut users) = rewind_fixture().await;
        let mut metadata = json!({"host":"test","path":"/tmp"});
        if variant == "claude" {
            metadata["claudeRewind"] = claude_intent();
            h.command("metadata", json!({"metadataVersion":2,"metadata":metadata}))
                .await;
            h.command(
                "update",
                json!({"t":"update-session","metadata":{"version":2,"value":metadata}}),
            )
            .await;
            h.command(
                "ack",
                json!({"t":"cancel-queued-message","localId":"barrier"}),
            )
            .await;
        }
        h.command("drop", Value::Null).await;
        wait(&mut events, |e| matches!(e, SessionEvent::Disconnected)).await;
        if variant == "opencode" {
            metadata["opencodeRewind"] = opencode_rewind("op", "committed");
            h.command("metadata", json!({"metadataVersion":2,"metadata":metadata}))
                .await;
        }
        h.command("rows", rewound_rows()).await;
        wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
        assert_eq!(users.try_recv().unwrap(), "queued", "{variant}");
        assert!(users.try_recv().is_err(), "{variant}");
        let state = h.command("snapshot", Value::Null).await;
        assert_eq!(
            message_queries(&state),
            ["?afterSeq=0&limit=200"],
            "{variant}"
        );
        for (id, seq) in [("queued", 41), ("before", 100), ("after", 42)] {
            h.command(
                "update",
                json!({"t":"new-message","message":message(id,seq,"web")}),
            )
            .await;
        }
        assert_eq!(
            timeout(LIMIT, users.recv()).await.unwrap().unwrap(),
            "after"
        );
        client.close();
    }
}
#[tokio::test]
async fn live_rewind_backfills_after_intent_clears_and_waits_for_prepared_phase() {
    let (mut h, client, mut events, mut users) = rewind_fixture().await;
    h.command("rows", rewound_rows()).await;
    let mut metadata = json!({"host":"test","path":"/tmp","claudeRewind":claude_intent()});
    h.command(
        "update",
        json!({"t":"update-session","metadata":{"version":2,"value":metadata}}),
    )
    .await;
    h.command(
        "ack",
        json!({"t":"cancel-queued-message","localId":"barrier"}),
    )
    .await;
    assert!(message_queries(&h.command("snapshot", Value::Null).await).is_empty());
    metadata
        .as_object_mut()
        .unwrap()
        .shift_remove("claudeRewind");
    h.command(
        "update",
        json!({"t":"update-session","metadata":{"version":3,"value":metadata}}),
    )
    .await;
    assert_eq!(
        timeout(LIMIT, users.recv()).await.unwrap().unwrap(),
        "queued"
    );
    let state = h.command("snapshot", Value::Null).await;
    assert_eq!(message_queries(&state), ["?afterSeq=0&limit=200"]);

    let mut rows = rewound_rows();
    rows.as_array_mut().unwrap()[40] = message("queued2", 41, "web");
    h.command("rows", rows).await;
    metadata["opencodeRewind"] = opencode_rewind("op", "prepared");
    h.command("metadata", json!({"metadataVersion":4,"metadata":metadata}))
        .await;
    h.command("drop", Value::Null).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    metadata["opencodeRewind"]["phase"] = "committed".into();
    h.command(
        "update",
        json!({"t":"update-session","metadata":{"version":5,"value":metadata}}),
    )
    .await;
    assert_eq!(
        timeout(LIMIT, users.recv()).await.unwrap().unwrap(),
        "queued2"
    );
    assert!(users.try_recv().is_err());
    let state = h.command("snapshot", Value::Null).await;
    assert_eq!(
        message_queries(&state),
        [
            "?afterSeq=0&limit=200",
            "?afterSeq=41&limit=200",
            "?afterSeq=0&limit=200"
        ]
    );
    client.close();
}
#[tokio::test]
async fn incomplete_opencode_rewind_is_ignored_like_typescript() {
    let (mut h, client, mut events, mut users) = rewind_fixture().await;
    h.command("drop", Value::Null).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Disconnected)).await;
    let metadata = json!({"host":"test","path":"/tmp","opencodeRewind":{"operationId":"op","phase":"committed"}});
    h.command("metadata", json!({"metadataVersion":2,"metadata":metadata}))
        .await;
    h.command("rows", rewound_rows()).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    assert!(users.try_recv().is_err());
    let state = h.command("snapshot", Value::Null).await;
    assert_eq!(message_queries(&state), ["?afterSeq=100&limit=200"]);
    assert!(client.metadata.get().value.get("opencodeRewind").is_none());
    client.close();
}
#[tokio::test]
async fn interrupted_rewind_resumes_after_its_last_completed_page() {
    let (mut h, client, mut events, mut users) = rewind_fixture().await;
    h.command("drop", Value::Null).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Disconnected)).await;
    let metadata =
        json!({"host":"test","path":"/tmp","opencodeRewind":opencode_rewind("op","committed")});
    h.command("metadata", json!({"metadataVersion":2,"metadata":metadata}))
        .await;
    let rows: Vec<_> = (1..=450)
        .map(|n| message(&format!("r{n}"), n, "web"))
        .collect();
    h.command("rows", json!(rows)).await;
    h.command("holdPage", 400.into()).await;
    for n in 1..=400 {
        assert_eq!(
            timeout(LIMIT, users.recv()).await.unwrap().unwrap(),
            format!("r{n}")
        );
    }
    timeout(LIMIT, async {
        while h.command("snapshot", Value::Null).await["pagePending"] != true {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    h.command("drop", Value::Null).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Disconnected)).await;
    wait(&mut events, |e| matches!(e, SessionEvent::Connected)).await;
    h.command("releasePage", Value::Null).await;
    h.command(
        "update",
        json!({"t":"new-message","message":message("barrier",451,"web")}),
    )
    .await;
    for n in 401..=450 {
        assert_eq!(
            timeout(LIMIT, users.recv()).await.unwrap().unwrap(),
            format!("r{n}")
        );
    }
    assert_eq!(
        timeout(LIMIT, users.recv()).await.unwrap().unwrap(),
        "barrier"
    );
    let state = h.command("snapshot", Value::Null).await;
    assert_eq!(
        message_queries(&state),
        [
            "?afterSeq=0&limit=200",
            "?afterSeq=200&limit=200",
            "?afterSeq=400&limit=200",
            "?afterSeq=400&limit=200"
        ]
    );
    client.close();
}
