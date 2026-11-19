use hapi_wrapper_core::sio::{
    client::{Client, Connection, Event},
    packet::{Packet, Payload},
};
use serde_json::json;
use std::process::Stdio;
use std::{io::ErrorKind, path::Path, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc,
    time::timeout,
};

fn server() -> Command {
    let mut cmd = Command::new("bun");
    cmd.arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/server.cjs"))
        .kill_on_drop(true);
    cmd
}
fn spawn(cmd: &mut Command) -> Option<tokio::process::Child> {
    match cmd.spawn() {
        Ok(child) => Some(child),
        Err(e)
            if e.kind() == ErrorKind::NotFound
                && std::env::var("HAPI_SKIP_BUN_INTEROP").as_deref() == Ok("1") =>
        {
            eprintln!("SKIP Socket.IO interoperability test: bun is unavailable");
            None
        }
        Err(e) => panic!(
            "starting bun: {e} (HAPI_SKIP_BUN_INTEROP=1 permits skipping when Bun is missing)"
        ),
    }
}

async fn connected(rx: &mut mpsc::UnboundedReceiver<Event>, ordinal: u32) {
    assert!(matches!(rx.recv().await, Some(Event::Connected)));
    let Some(Event::Message {
        name,
        args,
        ack: Some(ack),
    }) = rx.recv().await
    else {
        panic!("expected server ack request")
    };
    assert_eq!(name, "request");
    assert_eq!(args, vec![json!(ordinal), json!(51.248178375505404)]);
    assert!(ack.send(vec![json!("reply"), args[0].clone(), args[1].clone()]));
    let Some(Event::Message {
        name,
        args,
        ack: None,
    }) = rx.recv().await
    else {
        panic!("expected server confirmation")
    };
    assert_eq!(name, "answered");
    assert_eq!(args, vec![json!("reply"), json!(ordinal)]);
}

#[tokio::test]
async fn real_server() {
    let Some(mut child) = spawn(server().stdout(Stdio::piped())) else {
        return;
    };
    timeout(Duration::from_secs(12), async {
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let port = lines.next_line().await.unwrap().unwrap();
        let url = format!("http://127.0.0.1:{port}");
        let headers = vec![
            ("x-fixture".into(),"old".into()),("X-Fixture".into(),"upgrade".into()),
            ("ConNection".into(),"bad".into()),("UPGRADE".into(),"bad".into()),
            ("Sec-WebSocket-Key".into(),"bad".into()),("Sec-WebSocket-Version".into(),"bad".into()),
            ("Sec-WebSocket-Protocol".into(),"unnegotiated".into())
        ];
        let (denied, mut rejected) = Client::start(url.clone(), headers.clone(), "rejected".into(), "s".into());
        assert!(matches!(rejected.recv().await, Some(Event::ConnectError {message,fatal:true}) if message=="Invalid token"));
        assert!(!denied.is_connected());
        assert!(!denied.emit("late", vec![]));
        assert!(rejected.recv().await.is_none());
        let (client, mut events) = Client::start(url.clone(), headers.clone(),"fixture-token".into(),"s".into());
        connected(&mut events, 1).await;
        assert!(client.volatile_emit("record", vec![json!("writable")]));
        assert!(!client.volatile_emit("record", vec![json!("unflushed")]));
        let title = client.emit_with_ack("title", vec![], None).await.unwrap();
        assert_eq!(title, vec![json!({"title": "�"})]);
        assert!(client.is_connected());
        let args = vec![json!({"v":1}), json!(null)];
        assert_eq!(
            client
                .emit_with_ack("echo", args.clone(), None)
                .await
                .unwrap(),
            args
        );
        assert_eq!(
            client
                .emit_with_ack("never", vec![], Some(Duration::from_millis(30)))
                .await
                .unwrap_err()
                .kind(),
            ErrorKind::TimedOut
        );
        assert_eq!(
            client
                .emit_with_ack("drop", vec![], None)
                .await
                .unwrap_err()
                .kind(),
            ErrorKind::NotConnected
        );
        assert!(matches!(events.recv().await, Some(Event::Disconnected(_))));
        assert!(!client.volatile_emit("record", vec![json!("volatile")]));
        assert!(client.emit("record", vec![json!("first")]));
        assert!(client.emit("record", vec![json!("second")]));
        assert_eq!(
            client
                .emit_with_ack(
                    "record",
                    vec![json!("expired")],
                    Some(Duration::from_millis(30))
                )
                .await
                .unwrap_err()
                .kind(),
            ErrorKind::TimedOut
        );
        let snapshot = client
            .emit_with_ack("snapshot", vec![], None)
            .await
            .unwrap();
        assert_eq!(
            snapshot,
            vec![json!({"received":["writable","first","second"],"connections":2})]
        );
        connected(&mut events, 2).await;
        assert!(client.emit("record",vec![json!("before-stop")]));
        client.stop(Duration::from_secs(1));
        assert!(matches!(events.recv().await, Some(Event::Disconnected(reason)) if reason=="io client disconnect"));
        assert!(events.recv().await.is_none());
        assert!(!client.emit("after-stop", vec![]));
        lines.next_line().await.unwrap().unwrap();
        let report:serde_json::Value=serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(report,json!({"reason":"client namespace disconnect","received":["writable","first","second","before-stop"],"connections":2}));
        let (client, mut events)=Client::start(url,headers,"fixture-token".into(),"s".into());
        connected(&mut events,3).await;
        assert!(client.emit("end",vec![]));
        assert!(matches!(events.recv().await,Some(Event::Disconnected(reason)) if reason=="io server disconnect"));
        assert!(!client.is_connected());
        assert!(!client.emit("late", vec![]));
        assert!(events.recv().await.is_none());
    })
    .await
    .expect("Socket.IO interop timed out");
    child.kill().await.unwrap();
}

async fn link(client: &Client, expected: Connection) {
    client
        .connection()
        .wait_for(|state| state == expected)
        .await
        .unwrap();
}

#[tokio::test]
async fn session_hooks() {
    let (archived, mut idle) = Client::start_session(
        "http://127.0.0.1:9".into(),
        vec![],
        "fixture-token".into(),
        "s".into(),
        true,
    );
    assert_eq!(archived.connection().get(), Connection::Stopped);
    assert!(idle.recv().await.is_none());
    assert!(!archived.is_connected());
    assert!(!archived.emit("late", vec![]));
    archived.request_connect();
    assert_eq!(archived.connection().get(), Connection::Stopped);
    let Some(mut child) = spawn(server().stdout(Stdio::piped())) else {
        return;
    };
    timeout(Duration::from_secs(12), async {
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let port = lines.next_line().await.unwrap().unwrap();
        let url = format!("http://127.0.0.1:{port}");
        let headers = vec![("x-fixture".to_string(), "upgrade".to_string())];
        let (denied, mut rejected) =
            Client::start_session(url.clone(), headers.clone(), "rejected".into(), "s".into(), false);
        for _ in 0..2 {
            assert!(matches!(rejected.recv().await, Some(Event::ConnectError {message,fatal:true}) if message=="Invalid token"));
            assert_eq!(denied.connection().get(), Connection::Offline);
            denied.request_connect();
        }
        assert!(matches!(rejected.recv().await, Some(Event::ConnectError {fatal:true,..})));
        denied.disable_reconnect();
        assert_eq!(denied.connection().get(), Connection::Stopped);
        assert!(rejected.recv().await.is_none());

        let (client, mut events) =
            Client::start_session(url.clone(), headers.clone(), "fixture-token".into(), "s".into(), false);
        let mut watcher = client.connection();
        assert_eq!(watcher.get_and_update(), Connection::Offline);
        connected(&mut events, 1).await;
        link(&client, Connection::Online(0)).await;
        client.request_connect();
        assert!(client.emit("end", vec![]));
        assert!(matches!(events.recv().await, Some(Event::Disconnected(reason)) if reason=="io server disconnect"));
        assert_eq!(client.connection().get(), Connection::Offline);
        assert!(!client.is_connected());
        assert!(client.emit("record", vec![json!("queued")]));
        assert!(timeout(Duration::from_millis(300), events.recv()).await.is_err());
        assert_eq!(client.connection().get(), Connection::Offline);
        client.request_connect();
        connected(&mut events, 2).await;
        link(&client, Connection::Online(1)).await;
        let snapshot = client.emit_with_ack("snapshot", vec![], None).await.unwrap();
        assert_eq!(snapshot, vec![json!({"received":["queued"],"connections":2})]);
        assert!(client.emit("drop", vec![]));
        assert!(matches!(events.recv().await, Some(Event::Disconnected(_))));
        client.request_connect();
        connected(&mut events, 3).await;
        link(&client, Connection::Online(2)).await;
        client.stop(Duration::from_secs(1));
        assert_eq!(client.connection().get(), Connection::Stopped);
        assert!(matches!(events.recv().await, Some(Event::Disconnected(reason)) if reason=="io client disconnect"));
        assert!(events.recv().await.is_none());
        client.request_connect();
        assert_eq!(client.connection().get(), Connection::Stopped);
    })
    .await
    .expect("Socket.IO session hooks timed out");
    child.kill().await.unwrap();
}

#[tokio::test]
async fn parser_interop() {
    let Some(mut child) = spawn(
        server()
            .arg("parser")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped()),
    ) else {
        return;
    };
    let mut wires = Vec::new();
    for i in 0..200 {
        let args = vec![json!({"str":"a,b😀","nested":[true,null,i]})];
        let payload = match i % 5 {
            0 => Payload::Connect(Some(json!({"id":i}))),
            1 => Payload::Disconnect,
            2 => Payload::Event {
                id: (i % 2 == 0).then_some(i),
                name: format!("event,{i}😀").into(),
                args,
            },
            3 => Payload::Ack { id: i, args },
            _ => Payload::ConnectError(json!({"message":"failed"})),
        };
        let packet = Packet {
            namespace: if i % 2 == 0 {
                "/".into()
            } else {
                format!("/ns{i}")
            },
            payload,
        };
        wires.push(packet.encode().unwrap());
    }
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&wires).unwrap())
        .await
        .unwrap();
    let output = child.wait_with_output().await.unwrap();
    assert!(output.status.success());
    let mut count = 0;
    for line in String::from_utf8(output.stdout).unwrap().lines() {
        let row: serde_json::Value = serde_json::from_str(line).unwrap();
        let expected = Packet {
            namespace: "/cli".into(),
            payload: Payload::Event {
                id: Some(5),
                name: row["name"].clone(),
                args: vec![json!(true)],
            },
        };
        let wire = row["wire"].as_str().unwrap();
        if row["valid"] == true {
            assert_eq!(Packet::decode(wire).unwrap(), expected);
            assert_eq!(expected.encode().unwrap(), wire);
        } else {
            assert!(Packet::decode(wire).is_err());
            assert!(expected.encode().is_err());
        }
        count += 1;
    }
    assert_eq!(count, 10);
}
