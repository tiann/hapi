use super::metadata::hub_archived;
use crate::sio::client::{Client, UpdateListener};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use uuid::Uuid;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Metadata,
    AgentState,
}
impl Kind {
    fn event(self) -> &'static str {
        match self {
            Self::Metadata => "update-metadata",
            Self::AgentState => "update-state",
        }
    }
    fn key(self) -> &'static str {
        match self {
            Self::Metadata => "metadata",
            Self::AgentState => "agentState",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Metadata => "Metadata",
            Self::AgentState => "Agent state",
        }
    }
    pub fn valid(self, v: &Value) -> bool {
        self.parse(v).is_some()
    }
    fn parse(self, v: &Value) -> Option<Value> {
        match self {
            Self::Metadata => {
                if !crate::schemas::metadata(v) {
                    return None;
                }
                let mut metadata = v.clone();
                if let Some(summary) = metadata.get_mut("summary") {
                    let summary = summary.as_object_mut()?;
                    summary.get("text")?.as_str()?;
                    summary.get("updatedAt")?.as_f64()?;
                    summary.retain(|key, _| key == "text" || key == "updatedAt");
                }
                Some(metadata)
            }
            Self::AgentState => parse_agent_state(v),
        }
    }
}

fn string_array(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
}

fn parse_requests(v: &Value, completed: bool) -> Option<Value> {
    let mut requests = v.as_object()?.clone();
    for request in requests.values_mut() {
        let fields = request.as_object_mut()?;
        fields.get("tool")?.as_str()?;
        fields.get("arguments")?;
        if completed
            && !matches!(
                fields.get("status")?.as_str()?,
                "canceled" | "denied" | "approved" | "resolved"
            )
        {
            return None;
        }
        for (key, value) in fields.iter_mut() {
            let valid = match key.as_str() {
                "toolCallId" => value.is_string(),
                "createdAt" => value.is_null() || value.is_number(),
                "completedAt" if completed => value.is_null() || value.is_number(),
                "reason" | "mode" if completed => value.is_string(),
                "decision" if completed => matches!(
                    value.as_str(),
                    Some("approved" | "approved_for_session" | "denied" | "abort")
                ),
                "allowTools" if completed => string_array(value),
                "answers" if completed => {
                    let answers = value.as_object_mut()?;
                    if !answers.values().all(string_array) {
                        for answer in answers.values_mut() {
                            let nested = answer.as_object_mut()?;
                            if !string_array(nested.get("answers")?) {
                                return None;
                            }
                            nested.retain(|key, _| key == "answers");
                        }
                    }
                    true
                }
                _ => true,
            };
            if !valid {
                return None;
            }
        }
        fields.retain(|key, _| {
            matches!(
                key.as_str(),
                "tool" | "toolCallId" | "arguments" | "createdAt"
            ) || completed
                && matches!(
                    key.as_str(),
                    "completedAt"
                        | "status"
                        | "reason"
                        | "mode"
                        | "decision"
                        | "allowTools"
                        | "answers"
                )
        });
    }
    Some(Value::Object(requests))
}

fn parse_agent_state(v: &Value) -> Option<Value> {
    let mut parsed = serde_json::Map::new();
    for (key, value) in v.as_object()? {
        let valid = match key.as_str() {
            "controlledByUser" | "steeringActive" => value.is_boolean(),
            "codexPlanProposalId" => value.is_string(),
            "codexCompactionPendingMessageIds" => string_array(value),
            "startingMode" => matches!(value.as_str(), Some("local" | "remote" | "pty")),
            "requests" | "completedRequests" if !value.is_null() => {
                parsed.insert(
                    key.clone(),
                    parse_requests(value, key == "completedRequests")?,
                );
                continue;
            }
            "requests" | "completedRequests" => true,
            _ => continue,
        };
        if !valid && !value.is_null() {
            return None;
        }
        parsed.insert(key.clone(), value.clone());
    }
    Some(Value::Object(parsed))
}
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub value: Value,
    pub version: u64,
}

pub fn apply_ack(kind: Kind, current: &mut Snapshot, ack: &Value) -> io::Result<()> {
    adopt_ack(kind, current, ack)?;
    if ack["result"] == "version-mismatch" {
        return Err(io::Error::other(format!(
            "{} version mismatch",
            kind.label()
        )));
    }
    Ok(())
}

fn adopt_ack(kind: Kind, current: &mut Snapshot, ack: &Value) -> io::Result<bool> {
    let result = ack["result"].as_str();
    if result == Some("error") {
        return Err(io::Error::other(format!(
            "{} update failed ({})",
            kind.label(),
            ack["reason"].as_str().unwrap_or("unknown")
        )));
    }
    let invalid = || io::Error::other(format!("Invalid {} response", kind.event()));
    if !matches!(result, Some("success" | "version-mismatch")) {
        return Err(invalid());
    }
    let version = ack["version"].as_u64().ok_or_else(invalid)?;
    if version >= current.version {
        current.version = version;
        let value = &ack[kind.key()];
        if let Some(parsed) = if value.is_null() {
            Some(Value::Null)
        } else {
            kind.parse(value)
        } {
            current.value = parsed;
            return Ok(true);
        }
    }
    Ok(false)
}

fn retry_delay(failures: u32, rand: f64) -> Duration {
    Duration::from_millis((rand * f64::from(250 + 15 * failures.min(50))).round() as u64)
}

type Handler = Box<dyn Fn(&Value) -> Value + Send + Sync>;
type ApplyReply = Box<dyn FnOnce(Vec<Value>) -> bool + Send>;
type Observer = Box<dyn Fn(&Value) + Send + Sync>;

struct State {
    snapshot: Snapshot,
    pending: VecDeque<Value>,
    delivering: bool,
}
struct ObservedDocument {
    state: Mutex<State>,
    observer: OnceLock<Observer>,
}
impl ObservedDocument {
    fn remote(&self, kind: Kind, version: u64, value: &Value) -> bool {
        let mut archived = false;
        self.change(|current| {
            if version <= current.version {
                return false;
            }
            current.version = version;
            let parsed = if kind == Kind::AgentState && value.is_null() {
                Some(Value::Null)
            } else {
                kind.parse(value)
            };
            let Some(parsed) = parsed else {
                return false;
            };
            current.value = parsed;
            archived = kind == Kind::Metadata && hub_archived(value);
            true
        });
        archived
    }

    fn get(&self) -> Snapshot {
        self.state.lock().unwrap().snapshot.clone()
    }
    fn change(&self, apply: impl FnOnce(&mut Snapshot) -> bool) {
        let mut state = self.state.lock().unwrap();
        if !apply(&mut state.snapshot) {
            return;
        }
        let Some(observer) = self.observer.get() else {
            return;
        };
        let value = state.snapshot.value.clone();
        state.pending.push_back(value);
        if state.delivering {
            return;
        }
        state.delivering = true;
        while let Some(value) = state.pending.pop_front() {
            drop(state);
            observer(&value);
            state = self.state.lock().unwrap();
        }
        state.delivering = false;
    }
}

pub struct UpdateHandle(watch::Sender<bool>);
impl UpdateHandle {
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }
}

enum Work {
    Update(Handler, watch::Receiver<bool>),
    Drain(oneshot::Sender<()>),
}

pub struct Document {
    kind: Kind,
    snapshot: Arc<ObservedDocument>,
    queue: mpsc::UnboundedSender<Work>,
    worker: JoinHandle<()>,
    listener: Mutex<Option<Arc<UpdateListener>>>,
    archive: Arc<dyn Fn() + Send + Sync>,
}
impl Document {
    pub fn new(
        kind: Kind,
        snapshot: Snapshot,
        sid: String,
        socket: Client,
        archive: Arc<dyn Fn() + Send + Sync>,
        archived: watch::Receiver<bool>,
    ) -> Self {
        let mut link = socket.connection();
        let stopped = async move {
            let _ = link
                .wait_for(|v| v == crate::sio::client::Connection::Stopped)
                .await;
        };
        let transport = socket.clone();
        let session_id = sid.clone();
        let doc = Self::with_dispatch(
            kind,
            snapshot,
            sid,
            archive,
            archived,
            stopped,
            move |body, apply| {
                let socket = transport.clone();
                async move {
                    let timeout = if kind == Kind::Metadata {
                        if !socket.is_connected() {
                            return Err(io::Error::other("Socket not connected"));
                        }
                        Some(Duration::from_secs(5))
                    } else {
                        None
                    };
                    socket
                        .emit_with_ack_map(kind.event(), vec![body], timeout, apply)
                        .await
                }
            },
        );
        let state = doc.snapshot.clone();
        let archive = doc.archive.clone();
        let listener: Arc<UpdateListener> = Arc::new(move |body| {
            if body["t"] != "update-session" || body["sid"] != session_id {
                return;
            }
            let patch = &body[kind.key()];
            if let Some(version) = patch["version"].as_u64() {
                if state.remote(kind, version, &patch["value"]) {
                    archive();
                }
            }
        });
        socket.listen_updates(&listener);
        *doc.listener.lock().unwrap() = Some(listener);
        doc
    }
    #[cfg(test)]
    fn with_sender<F: std::future::Future<Output = io::Result<Vec<Value>>> + Send + 'static>(
        kind: Kind,
        snapshot: Snapshot,
        sid: String,
        archive: Arc<dyn Fn() + Send + Sync>,
        archived: watch::Receiver<bool>,
        stopped: impl std::future::Future<Output = ()> + Send + 'static,
        send: impl Fn(Value) -> F + Send + Sync + 'static,
    ) -> Self {
        Self::with_dispatch(
            kind,
            snapshot,
            sid,
            archive,
            archived,
            stopped,
            move |body, apply| {
                let reply = send(body);
                async move { reply.await.map(apply) }
            },
        )
    }
    fn with_dispatch<F: std::future::Future<Output = io::Result<bool>> + Send + 'static>(
        kind: Kind,
        snapshot: Snapshot,
        sid: String,
        archive: Arc<dyn Fn() + Send + Sync>,
        archived: watch::Receiver<bool>,
        stopped: impl std::future::Future<Output = ()> + Send + 'static,
        send: impl Fn(Value, ApplyReply) -> F + Send + Sync + 'static,
    ) -> Self {
        let (queue, mut requests) = mpsc::unbounded_channel();
        let snapshot = Arc::new(ObservedDocument {
            state: Mutex::new(State {
                snapshot,
                pending: VecDeque::new(),
                delivering: false,
            }),
            observer: OnceLock::new(),
        });
        let state = snapshot.clone();
        let on_archive = archive.clone();
        let process = async move {
            while let Some(work) = requests.recv().await {
                let (handler, mut cancelled) = match work {
                    Work::Drain(done) => {
                        let _ = done.send(());
                        continue;
                    }
                    Work::Update(h, cancelled) => (h, cancelled),
                };
                let mut failures = 0;
                loop {
                    if *cancelled.borrow() {
                        break;
                    }
                    let current = state.get();
                    if kind == Kind::Metadata
                        && (*archived.borrow() || hub_archived(&current.value))
                    {
                        on_archive();
                        break;
                    }
                    let input = if current.value.is_null() {
                        json!({})
                    } else {
                        current.value
                    };
                    let body = json!({"sid":sid,"expectedVersion":current.version,(kind.key()):handler(&input)});
                    let cancel_check = cancelled.clone();
                    let attempt = async {
                        if *cancel_check.borrow() {
                            return true;
                        }
                        let state = state.clone();
                        let on_archive = on_archive.clone();
                        let apply: ApplyReply = Box::new(move |args| {
                            let ack = args.first().unwrap_or(&Value::Null);
                            let mut finished = false;
                            let mut archived_now = false;
                            state.change(|snapshot| {
                                let cancelled = cancel_check.borrow();
                                if *cancelled {
                                    finished = true;
                                    return false;
                                }
                                let applied = adopt_ack(kind, snapshot, ack);
                                finished = applied.is_ok() && ack["result"] == "success";
                                archived_now =
                                    kind == Kind::Metadata && hub_archived(&snapshot.value);
                                applied.unwrap_or(false)
                            });
                            if archived_now {
                                on_archive();
                                return true;
                            }
                            finished
                        });
                        if send(body, apply).await.unwrap_or(false) {
                            return true;
                        }
                        failures = (failures + 1).min(50);
                        let rand = (Uuid::new_v4().as_u128() >> 96) as f64 / (u32::MAX as f64 + 1.);
                        tokio::time::sleep(retry_delay(failures, rand)).await;
                        false
                    };
                    let mut latch = archived.clone();
                    let finished = tokio::select! {
                        biased;
                        Ok(_) = cancelled.wait_for(|v| *v) => true,
                        Ok(_) = latch.wait_for(|v| *v), if kind == Kind::Metadata => true,
                        done = attempt => done,
                    };
                    if finished {
                        break;
                    }
                }
            }
        };
        let worker = tokio::spawn(async move {
            tokio::select! {biased; _=stopped=>{},_=process=>{}}
        });
        Self {
            kind,
            snapshot,
            queue,
            worker,
            listener: Mutex::default(),
            archive,
        }
    }
    pub fn observe(&self, f: impl Fn(&Value) + Send + Sync + 'static) {
        let _ = self.snapshot.observer.set(Box::new(f));
    }
    pub fn get(&self) -> Snapshot {
        self.snapshot.get()
    }
    /// Retries reapply the updater to the latest snapshot. Use an idempotent updater
    /// when a lost acknowledgement must not repeat a logical change.
    pub fn update(&self, f: impl Fn(&Value) -> Value + Send + Sync + 'static) {
        self.update_cancellable(f);
    }
    /// Retries like `update`. Cancellation stops local retries and ACK adoption;
    /// a write already sent to the hub may still commit.
    pub fn update_cancellable(
        &self,
        f: impl Fn(&Value) -> Value + Send + Sync + 'static,
    ) -> UpdateHandle {
        let (cancel, cancelled) = watch::channel(false);
        let _ = self.queue.send(Work::Update(Box::new(f), cancelled));
        UpdateHandle(cancel)
    }
    pub fn remote(&self, version: u64, value: &Value) {
        if self.snapshot.remote(self.kind, version, value) {
            (self.archive)();
        }
    }
    pub async fn drain(&self) -> bool {
        let (tx, rx) = oneshot::channel();
        self.queue.send(Work::Drain(tx)).is_ok() && rx.await.is_ok()
    }
    pub fn close(&self) {
        self.listener.lock().unwrap().take();
        self.worker.abort();
    }
}
impl Drop for Document {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use proptest::test_runner::RngSeed;
    use std::{collections::VecDeque, sync::Mutex};

    type Attempt = (Value, oneshot::Sender<io::Result<Vec<Value>>>);

    fn controlled(
        kind: Kind,
    ) -> (
        Document,
        mpsc::UnboundedReceiver<Attempt>,
        watch::Sender<bool>,
    ) {
        let (requests, attempts) = mpsc::unbounded_channel();
        let (archive, latch) = watch::channel(false);
        let snapshot = match kind {
            Kind::Metadata => initial(),
            Kind::AgentState => Snapshot {
                value: json!({"steeringActive":true}),
                version: 1,
            },
        };
        let doc = Document::with_sender(
            kind,
            snapshot,
            "s".into(),
            Arc::new(|| {}),
            latch,
            std::future::pending(),
            move |body| {
                let (reply, ack) = oneshot::channel();
                requests.send((body, reply)).unwrap();
                async move { ack.await.unwrap() }
            },
        );
        (doc, attempts, archive)
    }

    #[tokio::test(start_paused = true)]
    async fn lost_ack_replays_updater_on_committed_value_like_typescript() {
        let (doc, mut attempts, _archive) = controlled(Kind::Metadata);
        doc.update(|value| {
            let mut m = value.clone();
            m["name"] = format!("{}!", m["name"].as_str().unwrap()).into();
            m
        });
        let (first, reply) = attempts.recv().await.unwrap();
        let committed = &first["metadata"];
        assert_eq!(committed["name"], "old!");
        reply
            .send(Err(io::Error::other("ack lost after commit")))
            .unwrap();
        let (retry, reply) = attempts.recv().await.unwrap();
        assert_eq!(retry, first);
        reply
            .send(Ok(vec![
                json!({"result":"version-mismatch","version":2,"metadata":committed}),
            ]))
            .unwrap();
        let (rebased, reply) = attempts.recv().await.unwrap();
        assert_eq!(rebased["expectedVersion"], 2);
        assert_eq!(rebased["metadata"]["name"], "old!!");
        reply
            .send(Ok(vec![
                json!({"result":"success","version":3,"metadata":rebased["metadata"]}),
            ]))
            .unwrap();
        assert!(doc.drain().await);
    }

    #[tokio::test(start_paused = true)]
    async fn cancelling_rewind_ignores_late_ack_and_preserves_other_writes() {
        let (doc, mut attempts, _archive) = controlled(Kind::Metadata);
        let pending = doc.update_cancellable(|m| {
            let mut m = m.clone();
            m["claudeRewind"] = json!({"targetLocalId":"t","truncateFromLocalId":"x","keepBoundary":"b","droppedPrompts":[]});
            m
        });
        let (rewind, late) = attempts.recv().await.unwrap();
        let queued = doc.update_cancellable(|_| panic!("cancelled updater ran"));
        queued.cancel();
        doc.update(Clone::clone);
        assert!(tokio::time::timeout(Duration::from_secs(1), doc.drain())
            .await
            .is_err());
        pending.cancel();
        let _ = late.send(Ok(vec![
            json!({"result":"success","version":2,"metadata":rewind["metadata"]}),
        ]));
        let (next, reply) = attempts.recv().await.unwrap();
        assert_eq!(next["metadata"], initial().value);
        assert_eq!(next["expectedVersion"], 1);
        reply
            .send(Ok(vec![
                json!({"result":"success","version":3,"metadata":next["metadata"]}),
            ]))
            .unwrap();
        assert!(doc.drain().await);
        assert_eq!(doc.get().version, 3);
    }

    #[tokio::test(start_paused = true)]
    async fn rewind_ack_and_interleaved_remote_clear_are_observed_in_order() {
        let (doc, mut attempts, _archive) = controlled(Kind::Metadata);
        let doc = Arc::new(doc);
        let weak = Arc::downgrade(&doc);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let observations = seen.clone();
        doc.observe(move |value| {
            let has_intent = value.get("claudeRewind").is_some();
            if has_intent {
                weak.upgrade().unwrap().remote(3, &initial().value);
            }
            observations.lock().unwrap().push(has_intent);
        });
        doc.update(Clone::clone);
        let (body, reply) = attempts.recv().await.unwrap();
        let mut intent = body["metadata"].clone();
        intent["claudeRewind"] = json!({"targetLocalId":"t","truncateFromLocalId":"x","keepBoundary":"b","droppedPrompts":[]});
        reply
            .send(Ok(vec![
                json!({"result":"success","version":2,"metadata":intent}),
            ]))
            .unwrap();
        assert!(doc.drain().await);
        assert_eq!(*seen.lock().unwrap(), [true, false]);
        assert_eq!(doc.get().version, 3);
    }

    #[tokio::test(start_paused = true)]
    async fn closing_false_archive_channel_still_waits_for_ack() {
        let (doc, mut attempts, archive) = controlled(Kind::Metadata);
        doc.update(Clone::clone);
        let (body, reply) = attempts.recv().await.unwrap();
        drop(archive);
        assert!(tokio::time::timeout(Duration::from_secs(1), doc.drain())
            .await
            .is_err());
        reply
            .send(Ok(vec![
                json!({"result":"success","version":2,"metadata":body["metadata"]}),
            ]))
            .unwrap();
        assert!(doc.drain().await);
        assert_eq!(doc.get().version, 2);
    }

    #[tokio::test(start_paused = true)]
    async fn malformed_agent_state_only_advances_the_version() {
        let (doc, mut attempts, _archive) = controlled(Kind::AgentState);
        let previous = doc.get().value;
        doc.remote(2, &json!({"requests":[]}));
        assert_eq!((doc.get().version, doc.get().value), (2, previous.clone()));
        doc.update(Clone::clone);
        let (_, reply) = attempts.recv().await.unwrap();
        reply
            .send(Ok(vec![
                json!({"result":"version-mismatch","version":3,"agentState":{"requests":[]}}),
            ]))
            .unwrap();
        let (retry, reply) = attempts.recv().await.unwrap();
        assert_eq!(retry["expectedVersion"], 3);
        assert_eq!(retry["agentState"], previous);
        reply
            .send(Ok(vec![
                json!({"result":"success","version":4,"agentState":{"completedRequests":{"x":{}}}}),
            ]))
            .unwrap();
        assert!(doc.drain().await);
        assert_eq!((doc.get().version, doc.get().value), (4, previous));
    }

    #[tokio::test]
    async fn metadata_summary_adoption_matches_typescript() {
        let cases = json!([
            {"host":"test","path":"/","summary":null},
            {"host":"test","path":"/","summary":{"text":"title"}},
            {"host":"test","path":"/","summary":{"text":"title","updatedAt":"bad"}},
            {"host":"test","path":"/","summary":{"text":"title","updatedAt":42,"extra":1}}
        ]);
        let script = format!("import {{MetadataSchema as S}} from '@hapi/protocol/schemas'; console.log(JSON.stringify({cases}.map(v=>{{const r=S.safeParse(v);return r.success?r.data:null}})))");
        let output = std::process::Command::new("bun")
            .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../cli"))
            .args(["-e", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let parsed: Vec<Option<Value>> = serde_json::from_slice(&output.stdout).unwrap();
        let (doc, _, _archive) = controlled(Kind::Metadata);
        let mut acked = initial();
        for (i, (value, parsed)) in cases.as_array().unwrap().iter().zip(parsed).enumerate() {
            let version = i as u64 + 2;
            let expected = parsed.unwrap_or_else(|| acked.value.clone());
            apply_ack(
                Kind::Metadata,
                &mut acked,
                &json!({"result":"success","version":version,"metadata":value}),
            )
            .unwrap();
            doc.remote(version, value);
            assert_eq!((&acked.value, acked.version), (&expected, version));
            assert_eq!((doc.get().value, doc.get().version), (expected, version));
        }
    }

    #[test]
    fn agent_state_adoption_matches_shared_schema() {
        let cases = json!([
            {}, {"extra":1,"startingMode":"pty","controlledByUser":null,"steeringActive":true,"codexPlanProposalId":"id","codexCompactionPendingMessageIds":["a"]},
            {"startingMode":"other"}, {"controlledByUser":0}, {"steeringActive":"true"}, {"codexPlanProposalId":true}, {"codexCompactionPendingMessageIds":[1]},
            {"requests":null,"completedRequests":null}, {"requests":[]}, {"requests":{"x":{"tool":"call"}}},
            {"requests":{"x":{"tool":"call","arguments":null,"createdAt":null,"extra":1}}},
            {"completedRequests":{"x":{"tool":"t","arguments":{},"status":"approved","toolCallId":"id","decision":"abort","reason":"r","mode":"m","completedAt":1,"allowTools":["t"],"answers":{"a":{"answers":["b"],"extra":1}}}}},
            {"completedRequests":{"x":{"tool":"t","arguments":0,"status":"resolved","answers":{"a":["b"]}}}},
            {"completedRequests":{"x":{"tool":"t","arguments":0,"status":"resolved","answers":{"a":["b"],"c":{"answers":["d"]}}}}},
            {"completedRequests":{"x":{"tool":"t","arguments":0,"status":"bad"}}}
        ]);
        let script = format!("import {{AgentStateSchema as S}} from '@hapi/protocol/schemas'; console.log(JSON.stringify({cases}.map(v=>{{const r=S.safeParse(v);return r.success?r.data:null}})))");
        let output = std::process::Command::new("bun")
            .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../cli"))
            .args(["-e", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let expected: Vec<Option<Value>> = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            cases
                .as_array()
                .unwrap()
                .iter()
                .map(parse_agent_state)
                .collect::<Vec<_>>(),
            expected
        );
    }

    #[test]
    fn jitter_matches_typescript() {
        let output=std::process::Command::new("bun").current_dir(concat!(env!("CARGO_MANIFEST_DIR"),"/../../cli")).args(["-e",
            "import {exponentialBackoffDelay} from './src/utils/time.ts'; const out=[]; for(const n of [1,50,51]) for(const r of [0,0.5,0.999999]) {Math.random=()=>r;out.push(exponentialBackoffDelay(n,250,1000,50))} console.log(JSON.stringify(out))"
        ]).output().unwrap();
        assert!(output.status.success());
        let expected: Vec<u64> = serde_json::from_slice(&output.stdout).unwrap();
        let actual: Vec<_> = [1, 50, 51]
            .into_iter()
            .flat_map(|n| [0., 0.5, 0.999999].map(|r| retry_delay(n, r).as_millis() as u64))
            .collect();
        assert_eq!(actual, expected);
    }

    #[tokio::test(start_paused = true)]
    async fn each_worker_retry_stays_within_one_second() {
        let times = Arc::new(Mutex::new(Vec::new()));
        let attempts = times.clone();
        let (_tx, latch) = watch::channel(false);
        let doc = Document::with_sender(
            Kind::AgentState,
            initial(),
            "s".into(),
            Arc::new(|| {}),
            latch,
            std::future::pending(),
            move |_| {
                let mut times = attempts.lock().unwrap();
                times.push(tokio::time::Instant::now());
                std::future::ready(Ok(vec![if times.len() > 51 {
                    json!({"result":"success","version":2,"agentState":{}})
                } else {
                    json!({"result":"error"})
                }]))
            },
        );
        doc.update(Clone::clone);
        assert!(doc.drain().await);
        let times = times.lock().unwrap();
        assert_eq!(times.len(), 52);
        assert!(times
            .windows(2)
            .all(|pair| pair[1] - pair[0] <= Duration::from_millis(1000)));
    }
    fn initial() -> Snapshot {
        Snapshot {
            value: json!({"path":"/","host":"test","name":"old"}),
            version: 1,
        }
    }
    #[test]
    fn success() {
        let mut s = initial();
        apply_ack(
            Kind::Metadata,
            &mut s,
            &json!({"result":"success","version":2,"metadata":null}),
        )
        .unwrap();
        assert_eq!((s.value, s.version), (Value::Null, 2));
    }
    #[test]
    fn mismatch_applies_server_document() {
        let mut s = initial();
        let doc = json!({"path":"/","host":"test","extension":42});
        let e = apply_ack(
            Kind::Metadata,
            &mut s,
            &json!({"result":"version-mismatch","version":5,"metadata":doc}),
        )
        .unwrap_err();
        assert_eq!(e.to_string(), "Metadata version mismatch");
        assert_eq!((s.value, s.version), (doc, 5));
    }
    #[test]
    fn stale_ack_keeps_newer_snapshot() {
        let newer = Snapshot {
            value: json!({"path":"/","host":"test","name":"newer"}),
            version: 12,
        };
        let mut s = newer.clone();
        apply_ack(
            Kind::Metadata,
            &mut s,
            &json!({"result":"success","version":11,"metadata":{"path":"/","host":"test","name":"older"}}),
        )
        .unwrap();
        assert_eq!((&s.value, s.version), (&newer.value, 12));
        assert!(apply_ack(
            Kind::Metadata,
            &mut s,
            &json!({"result":"version-mismatch","version":11,"metadata":null}),
        )
        .is_err());
        assert_eq!((&s.value, s.version), (&newer.value, 12));
    }
    #[tokio::test(start_paused = true)]
    async fn delayed_ack_does_not_roll_back_remote_update() {
        let (_tx, latch) = watch::channel(false);
        let (release, gate) = watch::channel(false);
        let doc = Arc::new(Document::with_sender(
            Kind::AgentState,
            Snapshot {
                value: json!({"codexPlanProposalId":"10"}),
                version: 10,
            },
            "s".into(),
            Arc::new(|| {}),
            latch,
            std::future::pending(),
            move |_| {
                let mut gate = gate.clone();
                async move {
                    let _ = gate.wait_for(|v| *v).await;
                    Ok(vec![
                        json!({"result":"success","version":11,"agentState":{"codexPlanProposalId":"11"}}),
                    ])
                }
            },
        ));
        doc.update(Clone::clone);
        tokio::task::yield_now().await;
        doc.remote(12, &json!({"codexPlanProposalId":"12"}));
        release.send_replace(true);
        assert!(doc.drain().await);
        let snap = doc.get();
        assert_eq!(
            (snap.value, snap.version),
            (json!({"codexPlanProposalId":"12"}), 12)
        );
    }
    #[test]
    fn error_preserves_snapshot() {
        let mut s = initial();
        assert_eq!(
            apply_ack(
                Kind::Metadata,
                &mut s,
                &json!({"result":"error","reason":"access-denied"})
            )
            .unwrap_err()
            .to_string(),
            "Metadata update failed (access-denied)"
        );
        assert_eq!(s.value, initial().value);
        assert_eq!(s.version, 1);
    }
    #[test]
    fn malformed_preserves_snapshot() {
        for ack in [
            Value::Null,
            json!([]),
            json!({"result":"success","version":"nope"}),
            json!({"result":"what"}),
        ] {
            let mut s = initial();
            assert_eq!(
                apply_ack(Kind::Metadata, &mut s, &ack)
                    .unwrap_err()
                    .to_string(),
                "Invalid update-metadata response"
            );
            assert_eq!(s.version, 1);
            assert_eq!(s.value, initial().value);
        }
    }
    #[test]
    fn invalid_value_advances_version() {
        let mut s = initial();
        apply_ack(
            Kind::Metadata,
            &mut s,
            &json!({"result":"success","version":4,"metadata":123}),
        )
        .unwrap();
        assert_eq!(s.version, 4);
        assert_eq!(s.value, initial().value);
    }
    proptest! {
        #![proptest_config(ProptestConfig{rng_seed:RngSeed::Fixed(0x1911),cases:96,..Default::default()})]
        #[test]
        fn cas_retries_in_order(plan in prop::collection::vec((prop::collection::vec(0u8..4,0..6),1i32..20),1..10)){
            tokio::runtime::Builder::new_current_thread().enable_time().start_paused(true).build().unwrap().block_on(async{
                let mut expected=Vec::new();let mut outcomes=VecDeque::new();
                for (failures,delta) in &plan{
                    for failure in failures{outcomes.push_back(Some(*failure));if *failure==0{expected.push("remote".to_owned());}}
                    outcomes.push_back(None);expected.push(delta.to_string());
                }
                let hub=Arc::new(Mutex::new((0u64,Vec::<String>::new(),outcomes)));
                let responder=hub.clone();
                let (_tx,latch)=watch::channel(false);
                let doc=Document::with_sender(Kind::AgentState,Snapshot{value:json!({"codexCompactionPendingMessageIds":[]}),version:0},"sid".into(),Arc::new(||{}),latch,std::future::pending(),move|body|{
                    let mut h=responder.lock().unwrap();assert_eq!(body["expectedVersion"],h.0);
                    let answer=match h.2.pop_front().expect("extra transmission"){
                        Some(0)=>{h.0+=1;h.1.push("remote".to_owned());Ok(vec![json!({"result":"version-mismatch","version":h.0,"agentState":{"codexCompactionPendingMessageIds":h.1}})])}
                        Some(1)=>Ok(vec![json!({"result":"error"})]),Some(2)=>Ok(vec![Value::Null]),
                        Some(_)=>Err(io::Error::other("disconnect")),
                        None=>{h.0+=1;h.1=serde_json::from_value(body["agentState"]["codexCompactionPendingMessageIds"].clone()).unwrap();
                            Ok(vec![json!({"result":"success","version":h.0,"agentState":{"codexCompactionPendingMessageIds":h.1}})])}
                    };
                    std::future::ready(answer)
                });
                for (_,delta) in plan{doc.update(move|v|{let mut v=v.clone();v["codexCompactionPendingMessageIds"].as_array_mut().unwrap().push(delta.to_string().into());v});}
                assert!(doc.drain().await);let h=hub.lock().unwrap();assert!(h.2.is_empty());assert_eq!(h.1,expected);
                assert_eq!(doc.get().version,h.0);assert_eq!(doc.get().value["codexCompactionPendingMessageIds"],json!(h.1));
            });
        }
    }
}

#[cfg(test)]
mod differential {
    use super::super::incoming_filter::IncomingFilter;
    use super::*;
    use proptest::{
        prelude::*,
        strategy::ValueTree,
        test_runner::{RngSeed, TestRunner},
    };
    use std::{collections::VecDeque, path::Path, sync::Mutex};

    #[tokio::test(start_paused = true)]
    async fn matches_typescript_session_on_seeded_vectors() {
        let mut runner = TestRunner::new(ProptestConfig {
            rng_seed: RngSeed::Fixed(1911),
            ..Default::default()
        });
        let input = (
            1usize..9,
            prop::collection::vec(
                (
                    prop::option::of(0u8..12),
                    prop::option::of(-1i64..20),
                    prop::option::weighted(0.15, -1i64..20),
                ),
                16..80,
            ),
            prop::collection::vec((prop::collection::vec(0u8..3, 0..4), 0..10), 1..6),
        );
        let mut cases = Vec::new();
        let mut expected = Vec::new();
        for _ in 0..24 {
            let (capacity, stream, plan) = input.new_tree(&mut runner).unwrap().current();
            cases.push(json!({"capacity":capacity,"stream":stream,"plan":plan}));
            let mut filter = IncomingFilter::new(capacity);
            let decisions: Vec<_> = stream
                .iter()
                .map(|(id, seq, rewind)| {
                    if let Some(last) = rewind {
                        filter.rewind_cursor(*last);
                    }
                    let accepted = filter.accept(id.map(|n| n.to_string()).as_deref(), *seq);
                    json!([accepted, filter.cursor()])
                })
                .collect();
            let outcomes: VecDeque<_> = plan
                .iter()
                .flat_map(|(failures, _)| failures.iter().copied().map(Some).chain([None]))
                .collect();
            let hub = Mutex::new((outcomes, 0u64, String::new()));
            let (_tx, latch) = watch::channel(false);
            let doc = Document::with_sender(
                Kind::Metadata,
                Snapshot {
                    value: json!({"host":"fixture","path":"/tmp","name":""}),
                    version: 0,
                },
                "s".into(),
                Arc::new(|| {}),
                latch,
                std::future::pending(),
                move |payload| {
                    let mut hub = hub.lock().unwrap();
                    assert_eq!(payload["expectedVersion"], hub.1);
                    let result = match hub.0.pop_front().unwrap() {
                        Some(1) => json!({"result":"error"}),
                        Some(2) => json!({"result":"success","version":"invalid"}),
                        result => {
                            let mismatch = result == Some(0);
                            if mismatch {
                                hub.2.push('r');
                            } else {
                                hub.2 = payload["metadata"]["name"].as_str().unwrap().into();
                            }
                            hub.1 += 1;
                            json!({"result":if mismatch{"version-mismatch"}else{"success"},"version":hub.1,"metadata":{"host":"fixture","path":"/tmp","name":hub.2}})
                        }
                    };
                    std::future::ready(Ok(vec![result]))
                },
            );
            for (_, delta) in plan {
                doc.update(move |m| {
                    let mut m = m.clone();
                    m["name"] = format!("{}{delta}", m["name"].as_str().unwrap()).into();
                    m
                });
            }
            assert!(doc.drain().await);
            let snap = doc.get();
            expected.push(
                json!({"decisions":decisions,"version":snap.version,"name":snap.value["name"]}),
            );
        }
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("vectors.json");
        let output = dir.path().join("results.json");
        std::fs::write(&input, serde_json::to_vec(&cases).unwrap()).unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let result = std::process::Command::new("node")
            .current_dir(root.join("../../cli"))
            .args(["node_modules/vitest/vitest.mjs", "run", "--config"])
            .arg(root.join("tests/session.vitest.config.mjs"))
            .env("HAPI_VECTOR_INPUT", input)
            .env("HAPI_VECTOR_OUTPUT", &output)
            .env("HAPI_HOME", dir.path())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        let actual: Vec<Value> = serde_json::from_slice(&std::fs::read(output).unwrap()).unwrap();
        assert_eq!(actual, expected);
    }
}
