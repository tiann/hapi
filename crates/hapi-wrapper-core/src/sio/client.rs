use super::{
    eio::Transport,
    packet::{invalid, reserved, Packet, Payload},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch, Notify};

use tokio::time::Instant;

type Reply = oneshot::Sender<Vec<Value>>;

pub enum Event {
    Connected,
    Disconnected(String),
    ConnectError {
        message: String,
        fatal: bool,
    },
    Message {
        name: String,
        args: Vec<Value>,
        ack: Option<ServerAck>,
    },
}

struct Outgoing {
    payload: Payload,
    volatile: bool,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub enum Connection {
    #[default]
    Offline,
    Online(u64),
    Stopped,
}

#[derive(Default)]
struct State {
    link: watch::Sender<Connection>,
    connected: bool,
    writable: bool,
    stopped: bool,
    reconnect_disabled: bool,
    waiting: bool,
    generation: u64,
    next_id: u64,
    queue: VecDeque<Outgoing>,
    pending: HashMap<u64, Reply>,
}
impl State {
    fn enqueue(&mut self, payload: Payload, volatile: bool) -> bool {
        if self.stopped || volatile && !(self.connected && self.writable) {
            return false;
        }
        self.writable = false;
        self.queue.push_back(Outgoing { payload, volatile });
        true
    }
    fn disconnect(&mut self) {
        self.link
            .send_replace(if self.stopped || self.reconnect_disabled {
                Connection::Stopped
            } else {
                Connection::Offline
            });
        self.generation += 1;
        self.connected = false;
        self.writable = false;
        self.queue
            .retain(|p| !p.volatile && matches!(p.payload, Payload::Event { .. }));
        let mut buffered = HashMap::new();
        for item in &self.queue {
            if let Payload::Event { id: Some(id), .. } = item.payload {
                if let Some(reply) = self.pending.remove(&id) {
                    buffered.insert(id, reply);
                }
            }
        }
        self.pending = buffered;
    }
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    ready: Notify,
    stopping: Notify,
    connect_request: Notify,
}
impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("socket state poisoned")
    }
}

pub struct ServerAck {
    shared: Arc<Shared>,
    generation: u64,
    id: u64,
}
impl ServerAck {
    pub fn send(self, args: Vec<Value>) -> bool {
        let mut s = self.shared.lock();
        if s.stopped || s.generation != self.generation {
            return false;
        }
        s.enqueue(Payload::Ack { id: self.id, args }, false);
        self.shared.ready.notify_one();
        true
    }
}

struct AckWait {
    shared: Arc<Shared>,
    id: u64,
}
impl Drop for AckWait {
    fn drop(&mut self) {
        let mut state = self.shared.lock();
        if state.pending.remove(&self.id).is_some() {
            state
                .queue
                .retain(|p| !matches!(p.payload,Payload::Event{id:Some(id),..} if id==self.id));
        }
    }
}

#[derive(Clone)]
pub struct Client {
    shared: Arc<Shared>,
    stop: watch::Sender<Option<(Instant, Duration)>>,
}
impl Client {
    pub fn start(
        url: String,
        headers: Vec<(String, String)>,
        token: String,
        session_id: String,
    ) -> (Self, mpsc::UnboundedReceiver<Event>) {
        Self::start_worker(url, headers, token, session_id, false)
    }
    pub fn start_session(
        url: String,
        headers: Vec<(String, String)>,
        token: String,
        session_id: String,
        archived: bool,
    ) -> (Self, mpsc::UnboundedReceiver<Event>) {
        if archived {
            let shared = Arc::new(Shared::default());
            {
                let mut state = shared.lock();
                state.stopped = true;
                state.reconnect_disabled = true;
                state.link.send_replace(Connection::Stopped);
            }
            let (_, rx) = mpsc::unbounded_channel();
            let (stop, _) = watch::channel(None);
            return (Self { shared, stop }, rx);
        }
        Self::start_worker(url, headers, token, session_id, true)
    }
    fn start_worker(
        url: String,
        headers: Vec<(String, String)>,
        token: String,
        session_id: String,
        manual_connect: bool,
    ) -> (Self, mpsc::UnboundedReceiver<Event>) {
        let shared = Arc::new(Shared::default());
        let (stop, mut stopping) = watch::channel(None::<(Instant, Duration)>);
        let (events, rx) = mpsc::unbounded_channel();
        let worker = shared.clone();
        tokio::spawn(async move {
            let auth = json!({"token":token,"clientType":"session-scoped","sessionId":session_id});
            let running = async {
                loop {
                    let terminal = run(
                        &url,
                        &headers,
                        &auth,
                        &worker,
                        &events,
                        Duration::from_secs(20),
                    )
                    .await;
                    let disabled = {
                        let state = worker.lock();
                        state.stopped || state.reconnect_disabled
                    };
                    if !manual_connect || disabled {
                        break terminal;
                    }
                    if let Some(event) = terminal {
                        let _ = events.send(event);
                    }
                    worker.connect_request.notified().await;
                }
            };
            tokio::pin!(running);
            let terminal_event = tokio::select! {
                biased;
                _ = stopping.changed() => {
                    let namespace_open = {
                        let mut state = worker.lock();
                        state.stopped = true;
                        state.connected
                    };
                    if namespace_open {
                        worker.stopping.notify_one();
                        let remaining = stopping.borrow().map_or(Duration::from_millis(500), |(started, budget)| budget.saturating_sub(started.elapsed()));
                        tokio::time::timeout(remaining, running).await.unwrap_or_else(|_|
                            Some(Event::Disconnected("io client disconnect: drain timeout".into())))
                    } else {
                        None
                    }
                }
                event = &mut running => event,
            };
            {
                let mut state = worker.lock();
                state.connected = false;
                state.writable = false;
                state.stopped = true;
                state.link.send_replace(Connection::Stopped);
                state.queue.clear();
                state.pending.clear();
            }
            if let Some(event) = terminal_event {
                let _ = events.send(event);
            }
        });
        (Self { shared, stop }, rx)
    }
    pub fn stop(&self, timeout: Duration) {
        let mut state = self.shared.lock();
        if state.stopped {
            return;
        }
        state.stopped = true;
        state.link.send_replace(Connection::Stopped);
        if !state.connected {
            state.queue.clear();
        }
        state.pending.clear();
        self.stop.send_replace(Some((Instant::now(), timeout)));
        self.shared.stopping.notify_one();
    }
    pub fn request_connect(&self) {
        let state = self.shared.lock();
        if state.waiting && !state.reconnect_disabled && !state.stopped {
            self.shared.connect_request.notify_one();
        }
    }
    pub fn disable_reconnect(&self) {
        let mut state = self.shared.lock();
        state.reconnect_disabled = true;
        if !state.connected {
            drop(state);
            self.stop(Duration::ZERO);
        }
    }
    pub fn connection(&self) -> watch::Receiver<Connection> {
        self.shared.lock().link.subscribe()
    }
    pub fn is_connected(&self) -> bool {
        self.shared.lock().connected
    }
    fn enqueue(&self, payload: Payload, volatile: bool) -> bool {
        if matches!(&payload, Payload::Event { name, .. } if name.as_str().is_some_and(reserved)) {
            return false;
        }
        let queued = self.shared.lock().enqueue(payload, volatile);
        if queued {
            self.shared.ready.notify_one();
        }
        queued
    }
    pub fn emit(&self, name: &str, args: Vec<Value>) -> bool {
        self.enqueue(
            Payload::Event {
                id: None,
                name: name.into(),
                args,
            },
            false,
        )
    }
    pub fn volatile_emit(&self, name: &str, args: Vec<Value>) -> bool {
        self.enqueue(
            Payload::Event {
                id: None,
                name: name.into(),
                args,
            },
            true,
        )
    }
    pub async fn emit_with_ack(
        &self,
        name: &str,
        args: Vec<Value>,
        timeout: Option<Duration>,
    ) -> io::Result<Vec<Value>> {
        if reserved(name) {
            return Err(invalid("reserved event name"));
        }
        let (tx, rx) = oneshot::channel();
        let id = {
            let mut state = self.shared.lock();
            if state.stopped {
                return Err(io::Error::other("socket stopped"));
            }
            let id = state.next_id;
            state.next_id = id
                .checked_add(1)
                .ok_or_else(|| io::Error::other("ack ids exhausted"))?;
            state.pending.insert(id, tx);
            state.enqueue(
                Payload::Event {
                    id: Some(id),
                    name: name.into(),
                    args,
                },
                false,
            );
            id
        };
        let _wait = AckWait {
            shared: self.shared.clone(),
            id,
        };
        self.shared.ready.notify_one();
        let reply = match timeout {
            Some(t) => tokio::time::timeout(t, rx)
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "ack timeout"))?,
            None => rx.await,
        };
        reply.map_err(|_| {
            io::Error::new(
                io::ErrorKind::NotConnected,
                "socket disconnected before ack",
            )
        })
    }
}

fn cli(payload: Payload) -> Packet {
    Packet {
        namespace: "/cli".into(),
        payload,
    }
}

async fn run(
    url: &str,
    headers: &[(String, String)],
    auth: &Value,
    shared: &Arc<Shared>,
    events: &mpsc::UnboundedSender<Event>,
    connect_timeout: Duration,
) -> Option<Event> {
    let mut backoff = super::backoff::Backoff::default();
    loop {
        {
            let mut state = shared.lock();
            state.waiting = false;
            let _ = futures_util::FutureExt::now_or_never(shared.connect_request.notified());
        }
        let result = handshake(url, headers, auth, &mut backoff, connect_timeout).await;
        match result {
            Ok(Ok(mut transport)) => {
                {
                    let mut state = shared.lock();
                    if state.stopped {
                        return None;
                    }
                    state.connected = true;
                    state
                        .link
                        .send_replace(Connection::Online(state.generation));
                    state.writable = state.queue.is_empty();
                    let _ = events.send(Event::Connected);
                }
                let result = serve(&mut transport, shared, events).await;
                let mut state = shared.lock();
                let local = state.stopped;
                state.waiting = true;
                state.disconnect();
                let retry = !local && !state.reconnect_disabled && result.is_err();
                let event = match (local, result) {
                    (true, Err(error)) => Some(Event::Disconnected(format!(
                        "io client disconnect: drain failed: {error}"
                    ))),
                    (true, Ok(())) => Some(Event::Disconnected("io client disconnect".into())),
                    (false, Ok(())) => Some(Event::Disconnected("io server disconnect".into())),
                    (false, Err(error)) => Some(Event::Disconnected(error.to_string())),
                };
                if !retry {
                    return event;
                }
                if let Some(event) = event {
                    let _ = events.send(event);
                }
            }
            Ok(Err(message)) => {
                shared.lock().waiting = true;
                return Some(Event::ConnectError {
                    message,
                    fatal: true,
                });
            }
            Err(error) => {
                shared.lock().waiting = true;
                let _ = events.send(Event::ConnectError {
                    message: error.to_string(),
                    fatal: false,
                });
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff.next()) => {}
            _ = shared.connect_request.notified() => {}
        }
    }
}

async fn handshake(
    url: &str,
    headers: &[(String, String)],
    auth: &Value,
    backoff: &mut super::backoff::Backoff,
    connect_timeout: Duration,
) -> io::Result<Result<Transport, String>> {
    let mut transport = tokio::time::timeout(connect_timeout, Transport::connect(url, headers))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "connection timeout"))??;
    backoff.reset();
    transport
        .write_packet(&cli(Payload::Connect(Some(auth.clone()))))
        .await?;
    loop {
        let packet = transport.next_packet().await?;
        if packet.namespace != "/cli" {
            continue;
        }
        match packet.payload {
            Payload::Connect(Some(v)) if v["sid"].as_str().is_some_and(|s| !s.is_empty()) => break,
            Payload::ConnectError(v) => {
                let message = v
                    .as_str()
                    .or_else(|| v["message"].as_str())
                    .unwrap_or("connection rejected");
                return Ok(Err(message.to_owned()));
            }
            _ => return Err(invalid("expected namespace CONNECT")),
        }
    }
    Ok(Ok(transport))
}

async fn serve(
    transport: &mut Transport,
    shared: &Arc<Shared>,
    events: &mpsc::UnboundedSender<Event>,
) -> io::Result<()> {
    tokio::select! {
        biased;
        _ = shared.stopping.notified() => {}
        result = exchange(transport, shared, events) => {
            let failed = result.as_ref().is_err_and(|e| e.kind() != io::ErrorKind::TimedOut);
            if failed || !shared.lock().stopped {
                return result;
            }
        }
    }
    let queue = std::mem::take(&mut shared.lock().queue);
    let packets = queue
        .into_iter()
        .map(|item| cli(item.payload))
        .chain(std::iter::once(cli(Payload::Disconnect)));
    transport.drain(packets).await
}

async fn exchange(
    transport: &mut Transport,
    shared: &Arc<Shared>,
    events: &mpsc::UnboundedSender<Event>,
) -> io::Result<()> {
    loop {
        let queue_empty = {
            let mut state = shared.lock();
            if state.stopped {
                return Ok(());
            }
            state.writable = state.queue.is_empty();
            state.writable
        };
        let frame = tokio::select! {
            _ = async { if queue_empty { shared.ready.notified().await; } } => {
                transport.check_heartbeat()?;
                let next = shared.lock().queue.pop_front();
                if let Some(item) = next {
                    if !transport.write_receiving(cli(item.payload), |p| receive(p, shared, events)).await? {
                        return Ok(());
                    }
                }
                continue;
            }
            result = transport.read_engine() => result,
        };
        if shared.lock().stopped {
            return Ok(());
        }
        let Some(packet) = transport.handle_engine(frame?).await? else {
            continue;
        };
        if !receive(packet, shared, events)? {
            return Ok(());
        }
    }
}

fn receive(
    packet: Packet,
    shared: &Arc<Shared>,
    events: &mpsc::UnboundedSender<Event>,
) -> io::Result<bool> {
    if packet.namespace != "/cli" {
        return Ok(true);
    }
    let mut state = shared.lock();
    if state.stopped {
        return Ok(false);
    }
    match packet.payload {
        Payload::Event { id, name, args } => {
            let ack = id.map(|id| ServerAck {
                shared: shared.clone(),
                generation: state.generation,
                id,
            });
            let name = name
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| crate::jsjson::stringify(&name));
            let _ = events.send(Event::Message { name, args, ack });
        }
        Payload::Ack { id, args } => {
            if let Some(reply) = state.pending.remove(&id) {
                let _ = reply.send(args);
            }
        }
        Payload::Disconnect => return Ok(false),
        _ => return Err(invalid("unexpected namespace packet")),
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use proptest::prelude::*;
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};

    async fn open(listener: &TcpListener) -> WebSocketStream<TcpStream> {
        let mut ws = accept_async(listener.accept().await.unwrap().0)
            .await
            .unwrap();
        ws.send(Message::text(
            r#"0{"sid":"engine","pingInterval":60000,"pingTimeout":30000}"#,
        ))
        .await
        .unwrap();
        assert!(ws
            .next()
            .await
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap()
            .starts_with("40/cli,"));
        ws
    }

    #[tokio::test(start_paused = true)]
    async fn namespace_deadline_is_retryable() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (client, mut events) = Client::start(url, vec![], "token".into(), "s".into());
        let _socket = open(&listener).await;
        tokio::time::advance(Duration::from_secs(89)).await;
        tokio::task::yield_now().await;
        assert!(matches!(
            events.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        tokio::time::advance(Duration::from_secs(1)).await;
        let error = tokio::time::timeout(Duration::from_millis(5), events.recv())
            .await
            .unwrap();
        assert!(
            matches!(error,Some(Event::ConnectError {message,fatal:false}) if message=="ping timeout")
        );
        client.stop(Duration::from_secs(1));
        assert!(events.recv().await.is_none());
    }

    #[tokio::test]
    async fn namespace_reply_can_arrive_after_dial_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (client, mut events) = Client::start(url, vec![], "token".into(), "s".into());
        let mut ws = accept_async(listener.accept().await.unwrap().0)
            .await
            .unwrap();
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(19)).await;
        tokio::time::resume();
        ws.send(Message::text(
            r#"0{"sid":"engine","pingInterval":60000,"pingTimeout":30000}"#,
        ))
        .await
        .unwrap();
        assert!(ws
            .next()
            .await
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap()
            .starts_with("40/cli,"));
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::time::resume();
        accept_namespace(&mut ws).await;
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        client.stop(Duration::ZERO);
    }

    #[tokio::test]
    async fn engine_open_resets_backoff_before_namespace_reply() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let mut backoff = super::super::backoff::Backoff::default();
        for _ in 0..5 {
            backoff.next();
        }
        let reject = async {
            let mut ws = open(&listener).await;
            ws.send(Message::text(r#"44/cli,{"message":"denied"}"#))
                .await
                .unwrap();
        };
        let auth = json!({"token":"rejected"});
        let (_, result) = tokio::join!(
            reject,
            handshake(&url, &[], &auth, &mut backoff, Duration::from_secs(20))
        );
        assert!(matches!(result,Ok(Err(message)) if message=="denied"));
        assert!(backoff.next() <= Duration::from_millis(1500));
    }

    #[tokio::test]
    async fn stop_sends_namespace_then_websocket_close() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (client, mut events) = Client::start(url, vec![], "token".into(), "s".into());
        let mut ws = open(&listener).await;
        ws.send(Message::text(r#"40/cli,{"sid":"session"}"#))
            .await
            .unwrap();
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        client.stop(Duration::from_secs(1));
        assert_eq!(ws.next().await.unwrap().unwrap(), Message::text("41/cli,"));
        assert!(matches!(ws.next().await, Some(Ok(Message::Close(_)))));
    }

    async fn slow_peer() -> (
        Client,
        mpsc::UnboundedReceiver<Event>,
        WebSocketStream<TcpStream>,
    ) {
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.set_recv_buffer_size(4096).unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let listener = socket.listen(1).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (client, events) = Client::start(url, vec![], "token".into(), "s".into());
        (client, events, open(&listener).await)
    }

    fn queue_backlog(client: &Client) {
        assert!(client.emit("first", vec![]));
        let block = Value::String("x".repeat(128 * 1024));
        for _ in 0..128 {
            assert!(client.emit("block", vec![block.clone()]));
        }
    }

    async fn accept_namespace(ws: &mut WebSocketStream<TcpStream>) {
        ws.send(Message::text(r#"40/cli,{"sid":"session"}"#))
            .await
            .unwrap();
    }

    async fn read_first(ws: &mut WebSocketStream<TcpStream>) {
        assert_eq!(
            ws.next().await.unwrap().unwrap(),
            Message::text(r#"42/cli,["first"]"#)
        );
    }

    #[tokio::test]
    async fn replay_services_acks_and_pings_before_the_backlog_finishes() {
        let (client, mut events, mut ws) = slow_peer().await;
        let ack = client.emit_with_ack("probe", vec![], None);
        tokio::pin!(ack);
        assert!(futures_util::FutureExt::now_or_never(ack.as_mut()).is_none());
        queue_backlog(&client);
        accept_namespace(&mut ws).await;
        assert_eq!(
            ws.next().await.unwrap().unwrap(),
            Message::text(r#"42/cli,0["probe"]"#)
        );
        read_first(&mut ws).await;

        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(50)).await;
        tokio::time::resume();
        ws.send(Message::text("2replay")).await.unwrap();
        ws.send(Message::text("43/cli,0[1]")).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), ack)
                .await
                .unwrap()
                .unwrap(),
            vec![json!(1)]
        );
        assert!(client.is_connected());
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(50)).await;
        tokio::time::resume();
        let mut blocks = 0;
        let mut pong = false;
        while blocks < 128 {
            let frame = ws.next().await.unwrap().unwrap().into_text().unwrap();
            if frame == "3replay" {
                pong = true;
            } else {
                assert!(frame.starts_with(r#"42/cli,["block","#));
                blocks += 1;
            }
        }
        assert!(pong);
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        client.stop(Duration::ZERO);
    }

    #[tokio::test]
    async fn established_write_services_inbound_ack_under_backpressure() {
        let (client, mut events, mut ws) = slow_peer().await;
        accept_namespace(&mut ws).await;
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        let ack = client.emit_with_ack("probe", vec![], None);
        tokio::pin!(ack);
        assert!(futures_util::FutureExt::now_or_never(ack.as_mut()).is_none());
        assert!(client.emit("upload", vec![Value::String("x".repeat(8 << 20))]));
        assert_eq!(
            ws.next().await.unwrap().unwrap(),
            Message::text(r#"42/cli,0["probe"]"#)
        );
        ws.send(Message::text("43/cli,0[1]")).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), ack)
                .await
                .unwrap()
                .unwrap(),
            vec![json!(1)]
        );
        client.stop(Duration::ZERO);
    }

    #[tokio::test]
    async fn replay_answers_requests_and_reports_server_disconnect() {
        let (client, mut events, mut ws) = slow_peer().await;
        queue_backlog(&client);
        accept_namespace(&mut ws).await;
        read_first(&mut ws).await;
        ws.send(Message::text(r#"42/cli,9["question"]"#))
            .await
            .unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .unwrap(),
            Some(Event::Connected)
        ));
        assert!(client.is_connected());
        let Some(Event::Message { ack: Some(ack), .. }) =
            tokio::time::timeout(Duration::from_secs(2), events.recv())
                .await
                .unwrap()
        else {
            panic!("expected question during replay");
        };
        assert!(ack.send(vec![json!(true)]));
        let mut blocks = 0;
        loop {
            let text = ws.next().await.unwrap().unwrap().into_text().unwrap();
            if text == "43/cli,9[true]" {
                break;
            }
            assert!(text.starts_with(r#"42/cli,["block","#));
            blocks += 1;
        }
        assert_eq!(blocks, 128);
        ws.send(Message::text("41/cli,")).await.unwrap();
        assert!(
            matches!(events.recv().await, Some(Event::Disconnected(reason)) if reason == "io server disconnect")
        );
        assert!(events.recv().await.is_none());
    }

    #[tokio::test]
    async fn handler_emit_precedes_ack_in_live_and_shutdown_writes() {
        for stop in [false, true] {
            let (client, mut events, mut ws) = slow_peer().await;
            accept_namespace(&mut ws).await;
            assert!(matches!(events.recv().await, Some(Event::Connected)));
            ws.send(Message::text(r#"42/cli,7["request"]"#))
                .await
                .unwrap();
            let Some(Event::Message { ack: Some(ack), .. }) = events.recv().await else {
                panic!("expected request");
            };
            assert!(client.emit("result", vec![]));
            assert!(ack.send(vec![json!(true)]));
            if stop {
                client.stop(Duration::from_secs(2));
            }
            assert_eq!(
                ws.next().await.unwrap().unwrap(),
                Message::text(r#"42/cli,["result"]"#)
            );
            assert_eq!(
                ws.next().await.unwrap().unwrap(),
                Message::text("43/cli,7[true]")
            );
            if stop {
                assert_eq!(ws.next().await.unwrap().unwrap(), Message::text("41/cli,"));
            } else {
                client.stop(Duration::ZERO);
            }
        }
    }

    #[tokio::test]
    async fn reliable_emit_at_expiry_reaches_the_next_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (client, mut events) = Client::start(url, vec![], "token".into(), "s".into());
        let mut ws = open(&listener).await;
        accept_namespace(&mut ws).await;
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        tokio::time::pause();
        assert!(client.emit("retained", vec![]));
        tokio::time::advance(Duration::from_secs(91)).await;
        assert!(matches!(events.recv().await, Some(Event::Disconnected(_))));
        tokio::time::resume();
        let mut next = tokio::time::timeout(Duration::from_secs(4), open(&listener))
            .await
            .unwrap();
        accept_namespace(&mut next).await;
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), next.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            Message::text(r#"42/cli,["retained"]"#)
        );
        client.stop(Duration::ZERO);
    }

    #[tokio::test]
    async fn failed_replay_reports_disconnect_after_connect() {
        let (client, mut events, mut ws) = slow_peer().await;
        queue_backlog(&client);
        accept_namespace(&mut ws).await;
        read_first(&mut ws).await;
        drop(ws);
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        assert!(matches!(events.recv().await, Some(Event::Disconnected(_))));
        client.stop(Duration::ZERO);
        assert!(events.recv().await.is_none());
    }

    #[tokio::test]
    async fn stop_during_initial_flush_drains_the_accepted_namespace() {
        let (client, mut events, mut ws) = slow_peer().await;
        queue_backlog(&client);
        accept_namespace(&mut ws).await;
        read_first(&mut ws).await;
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        assert!(client.is_connected());
        assert!(client.emit("session-end", vec![]));
        client.stop(Duration::from_secs(10));
        for _ in 0..128 {
            let text = ws.next().await.unwrap().unwrap().into_text().unwrap();
            assert!(text.starts_with(r#"42/cli,["block","#));
        }
        assert_eq!(
            ws.next().await.unwrap().unwrap(),
            Message::text(r#"42/cli,["session-end"]"#)
        );
        assert_eq!(ws.next().await.unwrap().unwrap(), Message::text("41/cli,"));
        assert!(matches!(ws.next().await, Some(Ok(Message::Close(_)))));
        ws.flush().await.unwrap();
        assert!(
            matches!(events.recv().await, Some(Event::Disconnected(reason)) if reason == "io client disconnect")
        );
        assert!(events.recv().await.is_none());
    }

    #[tokio::test]
    async fn caller_controls_stop_deadline() {
        let (client, mut events, mut ws) = slow_peer().await;
        accept_namespace(&mut ws).await;
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        queue_backlog(&client);
        read_first(&mut ws).await;
        tokio::time::pause();
        client.stop(Duration::from_secs(2));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        assert!(matches!(
            events.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        tokio::time::advance(Duration::from_secs(1)).await;
        let event = tokio::time::timeout(Duration::from_millis(5), events.recv())
            .await
            .unwrap();
        assert!(
            matches!(event,Some(Event::Disconnected(reason)) if reason=="io client disconnect: drain timeout")
        );
        assert!(!client.is_connected());
        assert!(!client.emit("late", vec![]));
        assert!(events.recv().await.is_none());
    }

    #[tokio::test]
    async fn stop_drains_without_dispatching_inbound_frames() {
        let (client, mut events, mut ws) = slow_peer().await;
        accept_namespace(&mut ws).await;
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        ws.send(Message::text(r#"42/cli,["late"]"#)).await.unwrap();
        ws.send(Message::text("41/cli,")).await.unwrap();
        for i in 0..32 {
            assert!(client.emit("final", vec![json!(i)]));
        }
        client.stop(Duration::from_secs(1));
        for i in 0..32 {
            let frame = ws.next().await.unwrap().unwrap();
            assert_eq!(frame, Message::text(format!(r#"42/cli,["final",{i}]"#)));
        }
        assert_eq!(ws.next().await.unwrap().unwrap(), Message::text("41/cli,"));
        assert!(matches!(ws.next().await, Some(Ok(Message::Close(_)))));
        let _ = ws.flush().await;
        assert!(
            matches!(events.recv().await,Some(Event::Disconnected(reason)) if reason=="io client disconnect")
        );
        assert!(events.recv().await.is_none());
    }

    #[tokio::test]
    async fn drain_survives_ping_expiry_and_answers_ping_under_backpressure() {
        let (client, mut events, mut ws) = slow_peer().await;
        accept_namespace(&mut ws).await;
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        queue_backlog(&client);
        read_first(&mut ws).await;
        ws.send(Message::text("2before-stop")).await.unwrap();
        ws.send(Message::text(r#"42/cli,["after-ping"]"#))
            .await
            .unwrap();
        assert!(
            matches!(events.recv().await, Some(Event::Message { name, .. }) if name == "after-ping")
        );
        tokio::time::pause();
        client.stop(Duration::from_secs(120));
        ws.send(Message::text("2draining")).await.unwrap();
        tokio::time::advance(Duration::from_secs(91)).await;
        tokio::time::resume();
        let mut blocks = 0;
        let mut pongs = Vec::new();
        loop {
            let text = ws.next().await.unwrap().unwrap().into_text().unwrap();
            if text == "41/cli," {
                break;
            }
            if text.starts_with('3') {
                assert!(blocks < 128);
                pongs.push(text.to_string());
            } else {
                assert!(text.starts_with(r#"42/cli,["block","#));
                blocks += 1;
            }
        }
        assert_eq!(pongs, ["3before-stop", "3draining"]);
        assert_eq!(blocks, 128);
        assert!(matches!(ws.next().await, Some(Ok(Message::Close(_)))));
        let _ = ws.flush().await;
        assert!(
            matches!(events.recv().await,Some(Event::Disconnected(reason)) if reason=="io client disconnect")
        );
    }

    #[tokio::test]
    async fn peer_closing_during_drain_reports_failure() {
        let (client, mut events, mut ws) = slow_peer().await;
        accept_namespace(&mut ws).await;
        assert!(matches!(events.recv().await, Some(Event::Connected)));
        queue_backlog(&client);
        read_first(&mut ws).await;
        client.stop(Duration::from_secs(5));
        ws.send(Message::text("1")).await.unwrap();
        assert!(
            matches!(events.recv().await, Some(Event::Disconnected(reason)) if reason.contains("drain failed"))
        );
        assert!(!client.is_connected());
        assert!(!client.emit("late", vec![]));
    }

    #[tokio::test]
    async fn empty_namespace_sid_is_a_connect_error() {
        let (client, mut events, mut ws) = slow_peer().await;
        ws.send(Message::text(r#"40/cli,{"sid":""}"#))
            .await
            .unwrap();
        assert!(matches!(
            events.recv().await,
            Some(Event::ConnectError { fatal: false, .. })
        ));
        assert!(!client.is_connected());
        client.stop(Duration::ZERO);
    }

    #[test]
    fn disconnect_fails_inflight_ack_and_preserves_buffered_ack() {
        let mut state = State::default();
        let (inflight, mut failed) = oneshot::channel();
        let (buffered, mut kept) = oneshot::channel();
        state.pending.extend([(0, inflight), (1, buffered)]);
        state.enqueue(
            Payload::Event {
                id: Some(1),
                name: "queued".into(),
                args: vec![],
            },
            false,
        );
        state.disconnect();
        assert_eq!(failed.try_recv(), Err(oneshot::error::TryRecvError::Closed));
        assert!(matches!(
            state.queue.pop_front().unwrap().payload,
            Payload::Event { id: Some(1), .. }
        ));
        state
            .pending
            .remove(&1)
            .unwrap()
            .send(vec![json!("reply")])
            .unwrap();
        assert_eq!(kept.try_recv().unwrap(), vec![json!("reply")]);
    }

    proptest! {
        #[test]
        fn buffer_order(ops in prop::collection::vec(0u8..4,0..100)) {
            let mut state=State::default();let mut expected=Vec::new();
            for (i,op) in ops.into_iter().enumerate(){
                match op{
                    0|1=>{
                        let volatile=op==1;
                        let accepted= !volatile || state.connected && state.writable;
                        prop_assert_eq!(state.enqueue(Payload::Event{id:None,name:i.to_string().into(),args:vec![]},volatile),accepted);
                        if accepted{expected.push((i.to_string(),volatile));}
                    }
                    2=>{state.disconnect();expected.retain(|(_,volatile)|!*volatile);}
                    _=>{
                        let names:Vec<_>=state.queue.drain(..).filter_map(|p| match p.payload{Payload::Event{name,..}=>Some(name.as_str().unwrap().to_owned()),_=>None}).collect();
                        prop_assert_eq!(names,expected.drain(..).map(|(n,_)|n).collect::<Vec<_>>());
                        state.connected=true;state.writable=true;
                    }
                }
            }
        }
    }
}
