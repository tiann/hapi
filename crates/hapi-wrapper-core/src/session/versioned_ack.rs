use super::metadata::hub_archived;
use crate::sio::client::Client;
use serde_json::{json, Value};
use std::{io, sync::Arc, time::Duration};
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
        match self {
            Self::Metadata => crate::schemas::metadata(v),
            Self::AgentState => v.is_object(),
        }
    }
}
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub value: Value,
    pub version: u64,
}

pub fn apply_ack(kind: Kind, current: &mut Snapshot, ack: &Value) -> io::Result<()> {
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
        if value.is_null() || kind.valid(value) {
            current.value = value.clone();
        }
    }
    if result == Some("version-mismatch") {
        return Err(io::Error::other(format!(
            "{} version mismatch",
            kind.label()
        )));
    }
    Ok(())
}

fn retry_delay(failures: u32, rand: f64) -> Duration {
    Duration::from_millis((rand * f64::from(250 + 15 * failures.min(50))).round() as u64)
}

type Handler = Box<dyn Fn(&Value) -> Value + Send + Sync>;
type Observer = Arc<std::sync::OnceLock<Box<dyn Fn(&Value) + Send + Sync>>>;
enum Work {
    Update(Handler),
    Drain(oneshot::Sender<()>),
}

pub struct Document {
    kind: Kind,
    snapshot: watch::Sender<Snapshot>,
    queue: mpsc::UnboundedSender<Work>,
    worker: JoinHandle<()>,
    archive: Arc<dyn Fn() + Send + Sync>,
    observer: Observer,
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
        Self::with_sender(
            kind,
            snapshot,
            sid,
            archive,
            archived,
            stopped,
            move |body| {
                let socket = socket.clone();
                async move {
                    if kind == Kind::AgentState {
                        return socket.emit_with_ack(kind.event(), vec![body], None).await;
                    }
                    if !socket.is_connected() {
                        return Err(io::Error::other("Socket not connected"));
                    }
                    socket
                        .emit_with_ack(kind.event(), vec![body], Some(Duration::from_secs(5)))
                        .await
                }
            },
        )
    }
    fn with_sender<F: std::future::Future<Output = io::Result<Vec<Value>>> + Send + 'static>(
        kind: Kind,
        snapshot: Snapshot,
        sid: String,
        archive: Arc<dyn Fn() + Send + Sync>,
        archived: watch::Receiver<bool>,
        stopped: impl std::future::Future<Output = ()> + Send + 'static,
        send: impl Fn(Value) -> F + Send + Sync + 'static,
    ) -> Self {
        let (queue, mut requests) = mpsc::unbounded_channel();
        let (snapshot, _) = watch::channel(snapshot);
        let state = snapshot.clone();
        let on_archive = archive.clone();
        let observer: Observer = Arc::default();
        let observe = observer.clone();
        let process = async move {
            while let Some(work) = requests.recv().await {
                let handler = match work {
                    Work::Drain(done) => {
                        let _ = done.send(());
                        continue;
                    }
                    Work::Update(h) => h,
                };
                let mut failures = 0;
                loop {
                    let current = state.borrow().clone();
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
                    let attempt = async {
                        if let Ok(args) = send(body).await {
                            let mut applied = false;
                            state.send_modify(|s| {
                                applied =
                                    apply_ack(kind, s, args.first().unwrap_or(&Value::Null)).is_ok()
                            });
                            if let Some(f) = observe.get() {
                                let value = state.borrow().value.clone();
                                f(&value);
                            }
                            if kind == Kind::Metadata && hub_archived(&state.borrow().value) {
                                on_archive();
                                return true;
                            }
                            if applied {
                                return true;
                            }
                        }
                        failures = (failures + 1).min(50);
                        let rand = (Uuid::new_v4().as_u128() >> 96) as f64 / (u32::MAX as f64 + 1.);
                        tokio::time::sleep(retry_delay(failures, rand)).await;
                        false
                    };
                    let mut latch = archived.clone();
                    let finished = tokio::select! {
                        done=attempt=>done,
                        _=latch.wait_for(|v|*v),if kind==Kind::Metadata=>true,
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
            archive,
            observer,
        }
    }
    pub fn observe(&self, f: impl Fn(&Value) + Send + Sync + 'static) {
        let _ = self.observer.set(Box::new(f));
    }
    pub fn get(&self) -> Snapshot {
        self.snapshot.borrow().clone()
    }
    pub fn update(&self, f: impl Fn(&Value) -> Value + Send + Sync + 'static) {
        let _ = self.queue.send(Work::Update(Box::new(f)));
    }
    pub fn remote(&self, version: u64, value: &Value) {
        let mut archived = false;
        let mut applied = false;
        self.snapshot.send_if_modified(|current| {
            if version <= current.version {
                return false;
            }
            current.version = version;
            if self.kind.valid(value) || (self.kind == Kind::AgentState && value.is_null()) {
                current.value = value.clone();
                applied = true;
                archived = self.kind == Kind::Metadata && hub_archived(value);
            }
            true
        });
        if let Some(f) = self.observer.get().filter(|_| applied) {
            f(value);
        }
        if archived {
            (self.archive)();
        }
    }
    pub async fn drain(&self) -> bool {
        let (tx, rx) = oneshot::channel();
        self.queue.send(Work::Drain(tx)).is_ok() && rx.await.is_ok()
    }
    pub fn close(&self) {
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
                value: json!({"n":10}),
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
                        json!({"result":"success","version":11,"agentState":{"n":11}}),
                    ])
                }
            },
        ));
        doc.update(Clone::clone);
        tokio::task::yield_now().await;
        doc.remote(12, &json!({"n":12}));
        release.send_replace(true);
        assert!(doc.drain().await);
        let snap = doc.get();
        assert_eq!((snap.value, snap.version), (json!({"n":12}), 12));
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
                    for failure in failures{outcomes.push_back(Some(*failure));if *failure==0{expected.push(-1);}}
                    outcomes.push_back(None);expected.push(*delta);
                }
                let hub=Arc::new(Mutex::new((0u64,Vec::<i32>::new(),outcomes)));
                let responder=hub.clone();
                let (_tx,latch)=watch::channel(false);
                let doc=Document::with_sender(Kind::AgentState,Snapshot{value:json!({"items":[]}),version:0},"sid".into(),Arc::new(||{}),latch,std::future::pending(),move|body|{
                    let mut h=responder.lock().unwrap();assert_eq!(body["expectedVersion"],h.0);
                    let answer=match h.2.pop_front().expect("extra transmission"){
                        Some(0)=>{h.0+=1;h.1.push(-1);Ok(vec![json!({"result":"version-mismatch","version":h.0,"agentState":{"items":h.1}})])}
                        Some(1)=>Ok(vec![json!({"result":"error"})]),Some(2)=>Ok(vec![Value::Null]),
                        Some(_)=>Err(io::Error::other("disconnect")),
                        None=>{h.0+=1;h.1=serde_json::from_value(body["agentState"]["items"].clone()).unwrap();
                            Ok(vec![json!({"result":"success","version":h.0,"agentState":{"items":h.1}})])}
                    };
                    std::future::ready(answer)
                });
                for (_,delta) in plan{doc.update(move|v|{let mut v=v.clone();v["items"].as_array_mut().unwrap().push(delta.into());v});}
                assert!(doc.drain().await);let h=hub.lock().unwrap();assert!(h.2.is_empty());assert_eq!(h.1,expected);
                assert_eq!(doc.get().version,h.0);assert_eq!(doc.get().value["items"],json!(h.1));
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
