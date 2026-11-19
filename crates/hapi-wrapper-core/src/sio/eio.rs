use super::packet::{invalid, EnginePacket, Open, Packet};
use futures_util::{Sink, SinkExt, StreamExt};
use hyper::{
    header::{HeaderName, HeaderValue},
    Uri,
};
use rustls::{
    pki_types::{pem::PemObject, CertificateDer},
    ClientConfig, RootCertStore,
};
use std::{future::poll_fn, pin::Pin};
use std::{io, path::Path, sync::Arc, time::Duration};
use tokio::{
    net::TcpStream,
    time::{timeout_at, Instant},
};
use tokio_tungstenite::{
    client_async_tls_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
    Connector, MaybeTlsStream, WebSocketStream,
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

static TLS_CONFIG: tokio::sync::OnceCell<Arc<ClientConfig>> = tokio::sync::OnceCell::const_new();

fn load_tls_config(extra_ca: Option<&Path>) -> io::Result<Arc<ClientConfig>> {
    let mut roots = RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    if let Some(path) = extra_ca {
        match CertificateDer::pem_file_iter(path) {
            Ok(certs) => {
                let mut parse_error = false;
                let (_, invalid) = roots.add_parsable_certificates(certs.filter_map(|cert| {
                    parse_error |= cert.is_err();
                    cert.ok()
                }));
                if parse_error || invalid > 0 {
                    eprintln!("Ignoring invalid certificates in NODE_EXTRA_CA_CERTS");
                }
            }
            Err(err) => eprintln!("Could not open NODE_EXTRA_CA_CERTS: {err}"),
        }
    }
    if roots.is_empty() {
        return Err(io::Error::other("no TLS trust anchors available"));
    }
    Ok(Arc::new(
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    ))
}

pub(crate) async fn tls_config() -> io::Result<Arc<ClientConfig>> {
    let config = TLS_CONFIG
        .get_or_try_init(|| async {
            tokio::task::spawn_blocking(|| {
                let path = std::env::var_os("NODE_EXTRA_CA_CERTS").filter(|s| !s.is_empty());
                load_tls_config(path.as_deref().map(Path::new))
            })
            .await?
        })
        .await?;
    Ok(config.clone())
}

fn endpoint(url: &str) -> io::Result<(String, String, u16, bool)> {
    let uri: Uri = url.parse().map_err(io::Error::other)?;
    let secure = match uri.scheme_str() {
        Some("https" | "wss") => true,
        Some("http" | "ws") => false,
        _ => return Err(invalid("invalid hub URL scheme")),
    };
    let authority = uri
        .authority()
        .ok_or_else(|| invalid("missing hub authority"))?;
    let scheme = if secure { "wss" } else { "ws" };
    let url = format!("{scheme}://{authority}/socket.io/?EIO=4&transport=websocket");
    let host = authority.host();
    let host_port = authority.as_str().rsplit('@').next().unwrap();
    let port = match &host_port[host.len()..] {
        "" if secure => 443,
        "" => 80,
        suffix => suffix
            .strip_prefix(':')
            .filter(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| invalid("invalid hub port"))?,
    };
    Ok((url, host.trim_matches(['[', ']']).into(), port, secure))
}

async fn read(socket: &mut Socket) -> io::Result<EnginePacket> {
    while let Some(frame) = socket.next().await {
        match frame.map_err(io::Error::other)? {
            Message::Text(s) => return EnginePacket::decode(&s),
            Message::Close(_) => break,
            Message::Ping(_) => socket.flush().await.map_err(io::Error::other)?,
            Message::Pong(_) => {}
            _ => return Err(invalid("expected Engine.IO text frame")),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::UnexpectedEof,
        "transport closed",
    ))
}

fn deadline(watchdog: Duration) -> io::Result<Instant> {
    Instant::now()
        .checked_add(watchdog)
        .ok_or_else(|| invalid("invalid heartbeat duration"))
}

fn ping_timeout(_: tokio::time::error::Elapsed) -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "ping timeout")
}

pub struct Transport {
    socket: Socket,
    pending_write: Option<Message>,
    watchdog: Duration,
    expires: Instant,
}

impl Transport {
    pub async fn connect(url: &str, headers: &[(String, String)]) -> io::Result<Self> {
        let (url, host, port, secure) = endpoint(url)?;
        let mut req = url.into_client_request().map_err(io::Error::other)?;
        for (name, value) in headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(io::Error::other)?;
            if matches!(name.as_str(), "connection" | "upgrade")
                || name.as_str().starts_with("sec-websocket-")
            {
                continue;
            }
            req.headers_mut().insert(
                name,
                HeaderValue::from_str(value).map_err(io::Error::other)?,
            );
        }
        let tcp = TcpStream::connect((host.as_str(), port)).await?;
        tcp.set_nodelay(true)?;
        let connector = if secure {
            Some(Connector::Rustls(tls_config().await?))
        } else {
            None
        };
        let limit = Some(100 << 20);
        let config = WebSocketConfig::default()
            .max_frame_size(limit)
            .max_message_size(limit);
        let (mut socket, _) = client_async_tls_with_config(req, tcp, Some(config), connector)
            .await
            .map_err(io::Error::other)?;
        let EnginePacket::Open(Open {
            ping_interval,
            ping_timeout,
            ..
        }) = read(&mut socket).await?
        else {
            return Err(invalid("expected Engine.IO open"));
        };
        let watchdog = Duration::from_millis(
            ping_interval
                .checked_add(ping_timeout)
                .ok_or_else(|| invalid("invalid heartbeat duration"))?,
        );
        Ok(Self {
            socket,
            pending_write: None,
            watchdog,
            expires: deadline(watchdog)?,
        })
    }

    pub(super) fn check_heartbeat(&self) -> io::Result<()> {
        if Instant::now() >= self.expires {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "ping timeout"));
        }
        Ok(())
    }

    pub(super) async fn replay_packet(
        &mut self,
        packet: Packet,
        mut receive: impl FnMut(Packet) -> io::Result<bool>,
    ) -> io::Result<bool> {
        let (mut sink, mut stream) = (&mut self.socket).split();
        let mut frames = std::collections::VecDeque::from([Message::text(
            EnginePacket::Message(packet.encode()?).encode(),
        )]);
        while let Some(frame) = frames.pop_front() {
            let write = sink.send(frame);
            tokio::pin!(write);
            loop {
                tokio::select! {
                    incoming = stream.next() => {
                        match incoming.transpose().map_err(io::Error::other)? {
                            Some(Message::Text(s)) => match EnginePacket::decode(&s)? {
                                EnginePacket::Ping(data) => {
                                    self.expires = deadline(self.watchdog)?;
                                    frames.push_back(Message::text(EnginePacket::Pong(data).encode()));
                                }
                                EnginePacket::Message(data) => {
                                    if !receive(Packet::decode(&data)?)? { return Ok(false); }
                                }
                                EnginePacket::Noop | EnginePacket::Pong(_) => {}
                                EnginePacket::Close => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "transport closed")),
                                _ => return Err(invalid("unexpected Engine.IO packet")),
                            },
                            None | Some(Message::Close(_)) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "transport closed")),
                            Some(Message::Ping(_) | Message::Pong(_)) => {}
                            _ => return Err(invalid("expected Engine.IO text frame")),
                        }
                    }
                    result = &mut write => {
                        result.map_err(io::Error::other)?;
                        break;
                    }
                    _ = tokio::time::sleep_until(self.expires) => return Err(io::Error::new(io::ErrorKind::TimedOut, "ping timeout")),
                }
            }
        }
        Ok(true)
    }

    pub(super) async fn drain(&mut self, packets: impl Iterator<Item = Packet>) -> io::Result<()> {
        let mut outgoing = self
            .pending_write
            .take()
            .into_iter()
            .map(Ok::<_, io::Error>)
            .chain(packets.map(|p| Ok(Message::text(EnginePacket::Message(p.encode()?).encode()))));
        let (mut sink, mut stream) = (&mut self.socket).split();
        let mut pongs = std::collections::VecDeque::new();
        let mut prefer_pong = true;
        loop {
            let frame = if prefer_pong && !pongs.is_empty() {
                prefer_pong = false;
                pongs.pop_front().map(Ok)
            } else {
                prefer_pong = true;
                outgoing.next().or_else(|| pongs.pop_front().map(Ok))
            };
            let Some(frame) = frame else {
                break;
            };
            let write = sink.send(frame?);
            tokio::pin!(write);
            loop {
                tokio::select! {
                    incoming = stream.next() => {
                        match incoming.transpose().map_err(io::Error::other)? {
                            Some(Message::Text(text)) if text.starts_with('2') => {
                                pongs.push_back(Message::text(format!("3{}", &text[1..])));
                            }
                            Some(Message::Text(text)) if text.starts_with('1') => {
                                return Err(io::Error::new(io::ErrorKind::UnexpectedEof,"transport closed during drain"));
                            }
                            None | Some(Message::Close(_)) => {
                                return Err(io::Error::new(io::ErrorKind::UnexpectedEof,"transport closed during drain"));
                            }
                            _ => {}
                        }
                    }
                    result = &mut write => {
                        result.map_err(io::Error::other)?;
                        break;
                    }
                }
            }
        }
        sink.send(Message::Close(None))
            .await
            .map_err(io::Error::other)?;
        while let Some(frame) = stream.next().await {
            if matches!(frame.map_err(io::Error::other)?, Message::Close(_)) {
                break;
            }
        }
        Ok(())
    }

    async fn send(&mut self, p: EnginePacket) -> io::Result<()> {
        self.pending_write = Some(Message::text(p.encode()));
        timeout_at(self.expires, async {
            poll_fn(|cx| Pin::new(&mut self.socket).poll_ready(cx)).await?;
            let frame = self.pending_write.take().expect("pending websocket write");
            Pin::new(&mut self.socket).start_send(frame)?;
            self.socket.flush().await
        })
        .await
        .map_err(ping_timeout)?
        .map_err(io::Error::other)
    }

    pub async fn write_packet(&mut self, p: &Packet) -> io::Result<()> {
        self.send(EnginePacket::Message(p.encode()?)).await
    }

    pub(super) async fn read_engine(&mut self) -> io::Result<EnginePacket> {
        timeout_at(self.expires, read(&mut self.socket))
            .await
            .map_err(ping_timeout)?
    }

    pub(super) async fn handle_engine(
        &mut self,
        packet: EnginePacket,
    ) -> io::Result<Option<Packet>> {
        match packet {
            EnginePacket::Ping(data) => {
                self.expires = deadline(self.watchdog)?;
                self.send(EnginePacket::Pong(data)).await?;
                Ok(None)
            }
            EnginePacket::Pong(_) | EnginePacket::Noop => Ok(None),
            EnginePacket::Message(data) => Packet::decode(&data).map(Some),
            EnginePacket::Close => Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "transport closed",
            )),
            _ => Err(invalid("unexpected Engine.IO packet")),
        }
    }

    pub async fn next_packet(&mut self) -> io::Result<Packet> {
        loop {
            let frame = self.read_engine().await?;
            if let Some(packet) = self.handle_engine(frame).await? {
                return Ok(packet);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;
    #[tokio::test]
    async fn extra_ca_wss() {
        if std::env::var_os("HAPI_WSS_TEST_CHILD").is_none() {
            let dir = tempfile::tempdir().unwrap();
            let bundle = dir.path().join("extra.pem");
            let mut contents = b"-----BEGIN CERTIFICATE-----\n!\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n".to_vec();
            contents.extend_from_slice(include_bytes!("../../tests/fixtures/test-ca.pem"));
            std::fs::write(&bundle, contents).unwrap();
            let status = tokio::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "sio::eio::tests::extra_ca_wss"])
                .env("NODE_EXTRA_CA_CERTS", &bundle)
                .env("HAPI_WSS_TEST_CHILD", "1")
                .status()
                .await
                .unwrap();
            assert!(status.success());
            return;
        }
        use rustls::{pki_types::PrivateKeyDer, ServerConfig};
        let pem = include_bytes!("../../tests/fixtures/localhost-test-server.pem");
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from_pem_slice(pem).unwrap()],
                PrivateKeyDer::from_pem_slice(pem).unwrap(),
            )
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let tls = acceptor
                    .accept(listener.accept().await.unwrap().0)
                    .await
                    .unwrap();
                assert_eq!(tls.get_ref().1.server_name(), Some("localhost"));
                let mut ws = accept_async(tls).await.unwrap();
                ws.send(Message::text(
                    r#"0{"sid":"s","pingInterval":60000,"pingTimeout":10000}"#,
                ))
                .await
                .unwrap();
                for frame in ["3", "6", "1closed"] {
                    ws.send(Message::text(frame)).await.unwrap();
                }
            }
        });
        let mut cached = None;
        for _ in 0..2 {
            let mut t = Transport::connect(&format!("wss://localhost:{port}"), &[])
                .await
                .unwrap();
            assert_eq!(t.socket.get_config().max_message_size, Some(100 << 20));
            assert_eq!(t.socket.get_config().max_frame_size, Some(100 << 20));
            assert_eq!(
                t.next_packet().await.unwrap_err().kind(),
                io::ErrorKind::UnexpectedEof
            );
            let config = TLS_CONFIG.get().expect("dial cached TLS config");
            if let Some(previous) = cached.replace(config.clone()) {
                assert!(Arc::ptr_eq(config, &previous));
            }
        }
        server.await.unwrap();
    }

    #[test]
    fn explicit_ports_are_validated() {
        for authority in ["hub:70000", "hub:abc", "[::1]:65536", "hub:"] {
            assert!(endpoint(&format!("https://{authority}")).is_err());
        }
        assert_eq!(endpoint("https://[::1]").unwrap().2, 443);
        assert_eq!(endpoint("http://[::1]:3006").unwrap().2, 3006);
    }

    #[test]
    fn missing_extra_ca_preserves_native_roots() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_tls_config(Some(&dir.path().join("missing"))).is_ok());
        assert!(load_tls_config(Some(dir.path())).is_ok());
    }

    #[tokio::test]
    async fn advertised_heartbeat() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (pong_tx, pong_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let mut ws = accept_async(listener.accept().await.unwrap().0)
                .await
                .unwrap();
            ws.send(Message::text(
                r#"0{"sid":"s","pingInterval":60,"pingTimeout":40,"maxPayload":1000}"#,
            ))
            .await
            .unwrap();
            ws.send(Message::text("2probe")).await.unwrap();
            assert_eq!(ws.next().await.unwrap().unwrap(), Message::text("3probe"));
            pong_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        let mut t = Transport::connect(&format!("http://{address}"), &[])
            .await
            .unwrap();
        assert_eq!(t.watchdog, Duration::from_millis(100));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), t.next_packet())
                .await
                .unwrap()
                .unwrap_err()
                .to_string(),
            "ping timeout"
        );
        tokio::time::timeout(Duration::from_secs(1), pong_rx)
            .await
            .unwrap()
            .unwrap();
        server.abort();
    }
}
