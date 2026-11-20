use super::{
    metadata::{now, spread},
    versioned_ack::{Document, Kind, Snapshot},
};
use crate::{
    config::Config,
    rest::Rest,
    sio::client::{Client as Socket, Connection, Event, ServerAck},
};
use futures_util::{future::BoxFuture, FutureExt};
use serde_json::{json, Value};
use std::{
    io,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

#[derive(PartialEq, Eq)]
pub(super) enum Delivery {
    Live,
    Retry,
    Backfill,
}

pub enum SessionEvent {
    ConnectionStart,
    Connected,
    Disconnected,
    ConnectError { message: String, fatal: bool },
    HubArchived,
    Message(Value),
    Socket(String, Vec<Value>, Option<ServerAck>),
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Cancellation {
    Missing,
    Removed,
    InFlight,
    Indeterminate,
    Consumed,
}
pub type CancelHandler =
    Arc<dyn Fn(String) -> BoxFuture<'static, io::Result<Cancellation>> + Send + Sync>;
pub type RetryHandler = Arc<dyn Fn(String) -> BoxFuture<'static, io::Result<bool>> + Send + Sync>;
pub type UserHandler = Arc<dyn Fn(Value, Option<String>) + Send + Sync>;
pub trait SessionExtension: Send + Sync + 'static {
    fn register(&self, _session_id: &str, _rpc: &crate::rpc::manager::RpcHandlerManager) {}
    fn connected(&self, _socket: &Socket, _generation: u64) {}
    fn disconnected(&self) {}
    fn socket_event(&self, _name: &str, _args: &[Value], _metadata: &Value) -> bool {
        false
    }
    fn shutdown(&self) -> BoxFuture<'static, ()> {
        futures_util::future::ready(()).boxed()
    }
}
#[derive(Default)]
pub struct StartOptions {
    pub empty_history: bool,
    pub extensions: Vec<Arc<dyn SessionExtension>>,
}
#[derive(Default)]
struct Incoming {
    delivering: bool,
    pending: std::collections::VecDeque<(Value, Option<String>)>,
    user: Option<UserHandler>,
    cancel: Option<CancelHandler>,
    retry: Option<RetryHandler>,
}
pub struct SessionClient {
    pub id: String,
    pub rpc: crate::rpc::manager::RpcHandlerManager,
    pub metadata: Document,
    pub agent_state: Document,
    pub(crate) socket: Socket,
    pub(crate) rest: Rest,
    events: mpsc::UnboundedSender<SessionEvent>,
    archive: watch::Sender<bool>,
    heartbeat_enabled: watch::Sender<bool>,
    closed: watch::Sender<bool>,
    pub(super) filter: Mutex<super::incoming_filter::IncomingFilter>,
    pub(super) backfill_lock: Arc<tokio::sync::Mutex<()>>,
    pub echoes: Mutex<super::echo::Echoes>,
    pub(super) latest: Mutex<Value>,
    incoming: Mutex<Incoming>,
    extensions: Vec<Arc<dyn SessionExtension>>,
    extensions_closed: Mutex<bool>,
}
impl SessionClient {
    pub fn start(
        config: &Config,
        rest: Rest,
        session: &Value,
    ) -> io::Result<(Arc<Self>, mpsc::UnboundedReceiver<SessionEvent>)> {
        Self::start_with(config, rest, session, false)
    }
    pub(super) fn start_with(
        config: &Config,
        rest: Rest,
        session: &Value,
        empty_history: bool,
    ) -> io::Result<(Arc<Self>, mpsc::UnboundedReceiver<SessionEvent>)> {
        Self::start_with_options(
            config,
            rest,
            session,
            StartOptions {
                empty_history,
                ..Default::default()
            },
        )
    }
    pub(super) fn start_with_options(
        config: &Config,
        rest: Rest,
        session: &Value,
        options: StartOptions,
    ) -> io::Result<(Arc<Self>, mpsc::UnboundedReceiver<SessionEvent>)> {
        let StartOptions {
            empty_history,
            extensions,
        } = options;
        let id = session["id"]
            .as_str()
            .ok_or_else(|| io::Error::other("Missing session id"))?
            .to_string();
        for (kind, key, version) in [
            (Kind::Metadata, "metadata", "metadataVersion"),
            (Kind::AgentState, "agentState", "agentStateVersion"),
        ] {
            if !session[version].is_u64() || (!session[key].is_null() && !kind.valid(&session[key]))
            {
                return Err(io::Error::other(format!("Invalid session {key}")));
            }
        }
        let rpc = crate::rpc::manager::RpcHandlerManager::new(&id);
        for extension in &extensions {
            extension.register(&id, &rpc);
        }
        let initially_archived = super::metadata::hub_archived(&session["metadata"]);
        let (socket, mut rx) = Socket::start_session(
            config.api_url.clone(),
            config.extra_headers.clone(),
            config.cli_api_token.clone(),
            id.clone(),
            initially_archived,
        );
        let (events, output) = mpsc::unbounded_channel();
        let (archive, archived) = watch::channel(false);
        let (heartbeat_enabled, mut heartbeat_control) = watch::channel(true);
        let (closed, mut closing) = watch::channel(false);
        let latch = {
            let heartbeat_enabled = heartbeat_enabled.clone();
            let archive = archive.clone();
            let socket = socket.clone();
            let events = events.clone();
            Arc::new(move || {
                heartbeat_enabled.send_replace(false);
                if !archive.send_replace(true) {
                    socket.disable_reconnect();
                    let _ = events.send(SessionEvent::HubArchived);
                }
            })
        };
        let doc = |kind, key: &str, version: &str| {
            Document::new(
                kind,
                Snapshot {
                    value: session[key].clone(),
                    version: session[version].as_u64().unwrap_or(0),
                },
                id.clone(),
                socket.clone(),
                latch.clone(),
                archived.clone(),
            )
        };
        let this = Arc::new(Self {
            rpc,
            metadata: doc(Kind::Metadata, "metadata", "metadataVersion"),
            agent_state: doc(Kind::AgentState, "agentState", "agentStateVersion"),
            id,
            rest,
            socket,
            events,
            archive,
            heartbeat_enabled,
            closed,
            filter: Mutex::default(),
            backfill_lock: Arc::default(),
            echoes: Mutex::default(),
            latest: Mutex::new(json!({"thinking":false})),
            incoming: Mutex::default(),
            extensions,
            extensions_closed: Mutex::new(false),
        });
        if initially_archived {
            latch();
        }
        if empty_history {
            this.filter.lock().unwrap().accept(None, Some(0));
        }
        this.filter
            .lock()
            .unwrap()
            .reconcile_rewind(&session["metadata"]);
        let observer = Arc::downgrade(&this);
        this.metadata.observe(move |value| {
            if let Some(client) = observer.upgrade() {
                client.reconcile_rewind(value);
            }
        });
        let weak = Arc::downgrade(&this);
        tokio::spawn(async move {
            let mut connections = 0;
            let period = Duration::from_secs(10);
            let mut heartbeat =
                tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut heartbeat = Some(heartbeat);
            loop {
                let event = tokio::select! {
                    biased;
                    _=closing.changed()=>break,
                    _=heartbeat_control.changed(),if heartbeat.is_some()=>{heartbeat=None;continue},
                    e=rx.recv()=>match e{Some(e)=>e,None=>break},
                    _=async{if let Some(timer)=&mut heartbeat{timer.tick().await;}},if heartbeat.is_some()=>{if let Some(c)=weak.upgrade(){c.alive(true);}else{break} continue}
                };
                let Some(client) = weak.upgrade() else { break };
                if client.is_closed() {
                    break;
                }
                match event {
                    Event::Connected => {
                        let generation = connections;
                        let current = Connection::Online(generation);
                        connections += 1;
                        let link = client.socket.connection();
                        if link.get() != current {
                            continue;
                        }
                        let _ = client.events.send(SessionEvent::ConnectionStart);
                        client.dispatch(|e| {
                            e.connected(&client.socket, generation);
                            false
                        });
                        client.rpc.on_connect(&client.socket);
                        client.alive(false);
                        if connections > 1 {
                            let start_cursor = {
                                let mut filter = client.filter.lock().unwrap();
                                filter.set_rewind_syncing(true);
                                filter.start_backfill()
                            };
                            tokio::spawn(Self::recover(
                                Arc::downgrade(&client),
                                current,
                                start_cursor,
                            ));
                        } else {
                            if link.get() == current
                                && !client.hub_archived()
                                && !client.is_closed()
                            {
                                let _ = client.events.send(SessionEvent::Connected);
                            }
                        }
                    }
                    Event::ConnectError { message, fatal } => {
                        client.rpc.on_disconnect();
                        let _ = client
                            .events
                            .send(SessionEvent::ConnectError { message, fatal });
                    }
                    Event::Disconnected(_) => {
                        client.filter.lock().unwrap().start_backfill();
                        client.rpc.on_disconnect();
                        client.dispatch(|e| {
                            e.disconnected();
                            false
                        });
                        let _ = client.events.send(SessionEvent::Disconnected);
                    }
                    Event::Message { name, args, ack } if name == "rpc-request" => {
                        tokio::spawn(async move {
                            let result = client
                                .rpc
                                .handle_request(args.first().unwrap_or(&Value::Null))
                                .await;
                            if let Some(ack) = ack {
                                ack.send(vec![json!(result)]);
                            }
                        });
                    }
                    Event::Message { name, args, ack } if name == "update" => {
                        if let Some(body) = args.first().and_then(|v| v.get("body")) {
                            client.update(body, ack);
                        }
                    }
                    Event::Message { name, args, ack } => {
                        if !client.extensions.is_empty() {
                            let metadata = client.metadata.get().value;
                            if client.dispatch(|e| e.socket_event(&name, &args, &metadata)) {
                                continue;
                            }
                        }
                        let _ = client.events.send(SessionEvent::Socket(name, args, ack));
                    }
                }
            }
        });
        Ok((this, output))
    }
    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }
    pub fn hub_archived(&self) -> bool {
        *self.archive.borrow()
    }
    pub fn closed_notifications(&self) -> watch::Receiver<bool> {
        self.closed.subscribe()
    }
    pub fn archive_notifications(&self) -> watch::Receiver<bool> {
        self.archive.subscribe()
    }
    pub async fn refresh_metadata(&self) -> bool {
        self.try_refresh_metadata().await.unwrap_or(false)
    }
    async fn try_refresh_metadata(&self) -> io::Result<bool> {
        let row = self.rest.refresh(&self.id).await?;
        let Some(version) = row["metadataVersion"].as_u64() else {
            return Ok(false);
        };
        let Some(meta) = row.get("metadata") else {
            return Ok(false);
        };
        if !meta.is_null() && !Kind::Metadata.valid(meta) {
            return Ok(false);
        }
        self.metadata.remote(version, meta);
        Ok(true)
    }
    fn reconcile_rewind(self: &Arc<Self>, metadata: &Value) {
        self.filter.lock().unwrap().reconcile_rewind(metadata);
        self.schedule_rewind_backfill();
    }
    pub(super) fn rewind_paused(&self) -> bool {
        !self.socket.is_connected()
            || matches!(
                self.metadata.get().value["opencodeRewind"]["phase"].as_str(),
                Some("reserved" | "prepared" | "unknown")
            )
    }
    pub(super) fn schedule_rewind_backfill(self: &Arc<Self>) {
        let current = self.socket.connection().get();
        if !matches!(current, Connection::Online(_)) || self.is_closed() || self.rewind_paused() {
            return;
        }
        if !self.filter.lock().unwrap().claim_rewind_schedule() {
            return;
        }
        let client = self.clone();
        tokio::spawn(async move {
            client.filter.lock().unwrap().release_rewind_schedule();
            if !client.filter.lock().unwrap().rewind_pending() || client.rewind_paused() {
                return;
            }
            let weak = Arc::downgrade(&client);
            drop(client);
            Self::backfill_with_retry(weak, current, None, |_| {}).await;
        });
    }
    async fn recover(weak: Weak<Self>, current: Connection, start_cursor: Option<i64>) {
        let refreshed = Self::refresh_with_retry(&weak, current).await;
        let Some(client) = weak.upgrade() else {
            return;
        };
        {
            let mut filter = client.filter.lock().unwrap();
            filter.set_rewind_syncing(false);
            if !refreshed {
                return;
            }
            filter.arm_claude_rewind_on_reconnect();
        }
        if client.hub_archived() || client.is_closed() {
            return;
        }
        drop(client);
        Self::backfill_with_retry(weak, current, start_cursor, move |client: &Self| {
            if client.socket.connection().get() == current
                && !client.hub_archived()
                && !client.is_closed()
            {
                let _ = client.events.send(SessionEvent::Connected);
            }
        })
        .await;
    }
    async fn refresh_with_retry(weak: &Weak<Self>, current: Connection) -> bool {
        let Some(client) = weak.upgrade() else {
            return false;
        };
        let mut link = client.socket.connection();
        let mut closed = client.closed.subscribe();
        let mut archived = client.archive.subscribe();
        drop(client);
        let mut delay = Duration::from_millis(500);
        loop {
            let Some(client) = weak.upgrade() else {
                return false;
            };
            let refreshed = tokio::select! {biased; _=link.wait_for(|v|v!=current)=>return false,_=closed.wait_for(|v|*v)=>return false,r=client.try_refresh_metadata()=>r};
            if refreshed.is_ok() || client.hub_archived() {
                return true;
            }
            drop(client);
            tokio::select! {biased; _=link.wait_for(|v|v!=current)=>return false,_=closed.wait_for(|v|*v)=>return false,_=archived.wait_for(|v|*v)=>return true,_=tokio::time::sleep(delay)=>{}};
            delay = (delay * 2).min(Duration::from_secs(30));
        }
    }
    async fn backfill_with_retry(
        weak: Weak<Self>,
        current: Connection,
        start_cursor: Option<i64>,
        attempted: impl FnOnce(&Self),
    ) {
        let Some(client) = weak.upgrade() else {
            return;
        };
        let mut link = client.socket.connection();
        let mut closed = client.closed.subscribe();
        let mut archived = client.archive.subscribe();
        drop(client);
        let mut attempted = Some(attempted);
        let mut delay = Duration::from_millis(500);
        loop {
            let result = tokio::select! {biased; _=link.wait_for(|v|v!=current)=>return,_=closed.wait_for(|v|*v)=>return,_=archived.wait_for(|v|*v)=>return,result=Self::backfill(&weak, start_cursor)=>result};
            let Some(client) = weak.upgrade() else {
                return;
            };
            if result.is_ok() && link.get() == current {
                client.filter.lock().unwrap().finish_backfill();
            }
            if let Some(attempted) = attempted.take() {
                attempted(&client);
            }
            if result.is_ok() {
                return;
            }
            drop(client);
            tokio::select! {biased; _=link.wait_for(|v|v!=current)=>return,_=closed.wait_for(|v|*v)=>return,_=archived.wait_for(|v|*v)=>return,_=tokio::time::sleep(delay)=>{}};
            delay = (delay * 2).min(Duration::from_secs(30));
        }
    }
    pub fn stop_keep_alive(&self) {
        self.heartbeat_enabled.send_replace(false);
    }
    pub(super) fn alive(&self, volatile: bool) {
        let enabled = self.heartbeat_enabled.borrow();
        if !*enabled {
            return;
        }
        let mut body = json!({"sid":self.id,"time":now()});
        spread(&mut body, &self.latest.lock().unwrap());
        if volatile {
            self.socket.volatile_emit("session-alive", vec![body]);
        } else {
            self.socket.emit("session-alive", vec![body]);
        }
    }
    pub async fn flush_metadata(&self, timeout: Duration) -> bool {
        !self.is_closed()
            && !timeout.is_zero()
            && tokio::time::timeout(timeout, self.metadata.drain())
                .await
                .unwrap_or(false)
    }
    pub async fn flush(&self, timeout: Duration) -> bool {
        if self.is_closed() || timeout.is_zero() {
            return false;
        }
        let deadline = tokio::time::Instant::now() + timeout;
        let mut closing = self.closed.subscribe();
        let run = async {
            let mut link = self.socket.connection();
            if link.get() == Connection::Offline {
                self.socket.request_connect();
            }
            if !link
                .wait_for(|s| s != Connection::Offline)
                .await
                .is_some_and(|s| matches!(s, Connection::Online(_)))
            {
                return false;
            }
            if !self.metadata.drain().await || !self.agent_state.drain().await {
                return false;
            }
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            !left.is_zero()
                && self
                    .socket
                    .emit_with_ack("ping", vec![], Some(left))
                    .await
                    .is_ok()
        };
        tokio::select! {
            _=closing.wait_for(|v|*v)=>false,
            done=tokio::time::timeout_at(deadline,run)=>done.unwrap_or(false),
        }
    }
    pub fn close(&self) {
        if self.closed.send_replace(true) {
            return;
        }
        self.rpc.on_disconnect();
        {
            let mut closed = self.extensions_closed.lock().unwrap();
            *closed = true;
            for extension in &self.extensions {
                extension.disconnected();
            }
        }
        self.metadata.close();
        self.agent_state.close();
        *self.incoming.lock().unwrap() = Incoming::default();
        *self.echoes.lock().unwrap() = Default::default();
        *self.latest.lock().unwrap() = Value::Null;
        self.stop_keep_alive();
        self.socket.stop(Duration::from_millis(500));
    }
    fn dispatch(&self, f: impl FnMut(&Arc<dyn SessionExtension>) -> bool) -> bool {
        if self.extensions.is_empty() {
            return false;
        }
        let closed = self.extensions_closed.lock().unwrap();
        !*closed && self.extensions.iter().any(f)
    }
    pub fn shutdown_extensions(&self) -> BoxFuture<'static, ()> {
        let all: Vec<_> = self.extensions.iter().map(|e| e.shutdown()).collect();
        futures_util::future::join_all(all).map(|_| ()).boxed()
    }
    pub fn on_user_message(&self, f: UserHandler) {
        let mut incoming = self.incoming.lock().unwrap();
        if self.is_closed() {
            return;
        }
        incoming.user = Some(f);
        self.deliver(incoming);
    }
    fn deliver<'a>(&'a self, mut state: std::sync::MutexGuard<'a, Incoming>) {
        if state.delivering || state.user.is_none() {
            return;
        }
        state.delivering = true;
        while !self.is_closed() {
            let Some(callback) = state.user.clone() else {
                break;
            };
            let Some((value, id)) = state.pending.pop_front() else {
                break;
            };
            drop(state);
            callback(value, id);
            state = self.incoming.lock().unwrap();
        }
        state.delivering = false;
    }
    pub fn on_cancel(&self, f: CancelHandler) {
        self.incoming.lock().unwrap().cancel = Some(f);
    }
    pub fn on_retry(&self, f: RetryHandler) {
        self.incoming.lock().unwrap().retry = Some(f);
    }
    async fn cancel(&self, id: &str) -> io::Result<Cancellation> {
        let callback = {
            let mut state = self.incoming.lock().unwrap();
            let count = state.pending.len();
            state
                .pending
                .retain(|(_, local)| local.as_deref() != Some(id));
            if state.pending.len() != count {
                return Ok(Cancellation::Removed);
            }
            state.cancel.clone()
        };
        match callback {
            Some(f) => f(id.into()).await,
            None => Ok(Cancellation::Missing),
        }
    }
    pub(super) fn incoming_message(&self, row: &Value, source: Delivery) {
        if self.is_closed() {
            return;
        }
        if !self.filter.lock().unwrap().accept_delivery(
            row["id"].as_str(),
            row["seq"].as_i64(),
            source == Delivery::Backfill,
        ) && source != Delivery::Retry
        {
            return;
        }
        let Some(content) = super::incoming_filter::user_message(&row["content"]) else {
            let _ = self
                .events
                .send(SessionEvent::Message(row["content"].clone()));
            return;
        };
        let id = row["localId"].as_str().map(str::to_owned);
        if content["meta"]["sentFrom"] == "cli"
            && !(content["meta"]["isNativeQueuedMessage"] == true
                && self.metadata.get().value["capabilities"]["concurrentClients"] == true
                && id.as_ref().is_some_and(|s| !s.is_empty()))
        {
            return;
        }
        let mut state = self.incoming.lock().unwrap();
        if self.is_closed() {
            return;
        }
        state.pending.push_back((content, id));
        self.deliver(state);
    }
    async fn queue_update(&self, body: &Value, retry: bool) -> io::Result<Value> {
        let id = body["localId"].as_str().filter(|s| !s.is_empty());
        let result = match id {
            Some(id) => self.cancel(id).await?,
            None => Cancellation::Missing,
        };
        if !retry {
            return Ok(
                json!({"removed":result==Cancellation::Removed,"inFlight":result==Cancellation::InFlight,"indeterminate":result==Cancellation::Indeterminate,"consumed":result==Cancellation::Consumed}),
            );
        }
        if result == Cancellation::Consumed {
            return Ok(json!({"removed":false,"accepted":false,"consumed":true}));
        }
        let accepted = match result {
            Cancellation::Indeterminate => {
                let callback = self.incoming.lock().unwrap().retry.clone();
                match (callback, id) {
                    (Some(f), Some(id)) => f(id.into()).await?,
                    _ => false,
                }
            }
            Cancellation::InFlight => false,
            _ => true,
        };
        if accepted {
            self.incoming_message(&body["message"], Delivery::Retry);
        }
        Ok(json!({"removed":false,"accepted":accepted}))
    }
    fn update(self: &Arc<Self>, body: &Value, ack: Option<ServerAck>) {
        match body["t"].as_str() {
            Some("new-message") => self.incoming_message(&body["message"], Delivery::Live),
            Some("update-session") => {
                for (key, doc) in [
                    ("metadata", &self.metadata),
                    ("agentState", &self.agent_state),
                ] {
                    if let Some(v) = body[key]["version"].as_u64() {
                        doc.remote(v, &body[key]["value"]);
                    }
                }
            }
            Some(kind @ ("cancel-queued-message" | "retry-queued-message")) => {
                let retry = kind == "retry-queued-message";
                let client = self.clone();
                let body = body.clone();
                let mut response = Box::pin(async move {
                    let result = client.queue_update(&body, retry).await.unwrap_or_else(
                        |_| json!({"removed":false,"accepted":false,"indeterminate":true}),
                    );
                    if let Some(ack) = ack {
                        ack.send(vec![result]);
                    }
                });
                if response.as_mut().now_or_never().is_none() {
                    tokio::spawn(response);
                }
            }
            _ => {
                let _ = self.events.send(SessionEvent::Message(body.clone()));
            }
        }
    }
}
impl Drop for SessionClient {
    fn drop(&mut self) {
        self.socket.stop(Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn initial_hub_archived_row_never_connects() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Config {
            api_url: format!("http://{}", listener.local_addr().unwrap()),
            cli_api_token: "token".into(),
            home: Default::default(),
            extra_headers: vec![],
            machine_id: None,
        };
        let rest = Rest::new(&config).await.unwrap();
        let (client, mut events) = SessionClient::start(
            &config,
            rest,
            &json!({"id":"s","metadataVersion":3,"agentStateVersion":0,"metadata":{"host":"h","path":"/","lifecycleState":"archived","archivedBy":"hub"}}),
        )
        .unwrap();
        assert!(client.hub_archived());
        assert_eq!(client.socket.connection().get(), Connection::Stopped);
        assert!(matches!(events.try_recv(), Ok(SessionEvent::HubArchived)));
        assert!(
            tokio::time::timeout(Duration::from_millis(500), listener.accept())
                .await
                .is_err()
        );
        assert!(events.try_recv().is_err());
        client.close();
    }
    #[tokio::test]
    async fn consumed_socket_event_is_not_forwarded() {
        struct Consume(&'static str, Mutex<Vec<String>>);
        impl SessionExtension for Consume {
            fn socket_event(&self, name: &str, args: &[Value], metadata: &Value) -> bool {
                self.1
                    .lock()
                    .unwrap()
                    .push(format!("{name}:{}:{}", args[0]["n"], metadata["path"]));
                name == self.0
            }
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Config {
            api_url: format!("http://{}", listener.local_addr().unwrap()),
            cli_api_token: "token".into(),
            home: Default::default(),
            extra_headers: vec![],
            machine_id: None,
        };
        let rest = Rest::new(&config).await.unwrap();
        let first = Arc::new(Consume("terminal:open", Mutex::default()));
        let second = Arc::new(Consume("terminal:write", Mutex::default()));
        let third = Arc::new(Consume("never", Mutex::default()));
        let (client, mut events) = SessionClient::start_with_options(
            &config,
            rest,
            &json!({"id":"s","metadataVersion":1,"agentStateVersion":0,"metadata":{"host":"h","path":"/work"}}),
            StartOptions {
                extensions: vec![first.clone(), second.clone(), third.clone()],
                ..Default::default()
            },
        )
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut ws = accept_async(listener.accept().await.unwrap().0).await.unwrap();
            ws.send(Message::text(r#"0{"sid":"e","pingInterval":60000,"pingTimeout":30000}"#)).await.unwrap();
            assert!(ws.next().await.unwrap().unwrap().into_text().unwrap().starts_with("40/cli,"));
            ws.send(Message::text(r#"40/cli,{"sid":"s"}"#)).await.unwrap();
            for frame in [
                r#"42/cli,["terminal:open",{"n":1}]"#,
                r#"42/cli,["terminal:write",{"n":2}]"#,
                r#"42/cli,["other",{"n":3}]"#,
                r#"42/cli,["update",{"body":{"t":"barrier"}}]"#,
            ] {
                ws.send(Message::text(frame)).await.unwrap();
            }
            assert!(matches!(events.recv().await,Some(SessionEvent::ConnectionStart)));
            assert!(matches!(events.recv().await,Some(SessionEvent::Connected)));
            assert!(matches!(events.recv().await,Some(SessionEvent::Socket(name,args,None)) if name=="other"&&args[0]["n"]==3));
            assert!(matches!(events.recv().await,Some(SessionEvent::Message(body)) if body["t"]=="barrier"));
        }).await.unwrap();
        assert_eq!(
            *first.1.lock().unwrap(),
            [
                "terminal:open:1:\"/work\"",
                "terminal:write:2:\"/work\"",
                "other:3:\"/work\""
            ]
        );
        assert_eq!(
            *second.1.lock().unwrap(),
            ["terminal:write:2:\"/work\"", "other:3:\"/work\""]
        );
        assert_eq!(*third.1.lock().unwrap(), ["other:3:\"/work\""]);
        client.close();
    }
    #[tokio::test]
    async fn first_connection_respects_latched_archive() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = Config {
            api_url: format!("http://{}", listener.local_addr().unwrap()),
            cli_api_token: "token".into(),
            home: Default::default(),
            extra_headers: vec![],
            machine_id: None,
        };
        let rest = Rest::new(&config).await.unwrap();
        let (client, mut events) = SessionClient::start(
            &config,
            rest,
            &json!({"id":"s","metadataVersion":0,"agentStateVersion":0}),
        )
        .unwrap();
        client.archive.send_replace(true);

        tokio::time::timeout(Duration::from_secs(5), async {
            let mut ws = accept_async(listener.accept().await.unwrap().0).await.unwrap();
            ws.send(Message::text(r#"0{"sid":"e","pingInterval":60000,"pingTimeout":30000}"#)).await.unwrap();
            assert!(ws.next().await.unwrap().unwrap().into_text().unwrap().starts_with("40/cli,"));
            ws.send(Message::text(r#"40/cli,{"sid":"s"}"#)).await.unwrap();
            ws.send(Message::text(r#"42/cli,["update",{"body":{"t":"barrier"}}]"#)).await.unwrap();
            assert!(matches!(events.recv().await,Some(SessionEvent::ConnectionStart)));
            assert!(matches!(events.recv().await,Some(SessionEvent::Message(body)) if body["t"]=="barrier"));
        }).await.unwrap();
        client.close();
    }
}
