use super::client::{Delivery, SessionClient};
use std::{io, sync::Weak};
impl SessionClient {
    pub(super) async fn backfill(weak: &Weak<Self>, start_cursor: Option<i64>) -> io::Result<()> {
        let Some(client) = weak.upgrade() else {
            return Ok(());
        };
        let lock = client.backfill_lock.clone();
        drop(client);
        let guard = lock.lock_owned().await;
        let Some(client) = weak.upgrade() else {
            return Ok(());
        };
        let Some((cursor, epoch)) = client.filter.lock().unwrap().backfill_start(start_cursor)
        else {
            return Ok(());
        };
        drop(client);
        let mut attempted = epoch;
        let result = Self::backfill_pages(weak, cursor, epoch, &mut attempted).await;
        drop(guard);
        if let Some(client) = weak.upgrade() {
            if client.filter.lock().unwrap().rewind_stale(attempted) {
                client.schedule_rewind_backfill();
            }
        }
        result
    }
    fn rewind_held(&self) -> bool {
        self.filter.lock().unwrap().rewind_pending() && self.rewind_paused()
    }
    async fn backfill_pages(
        weak: &Weak<Self>,
        mut cursor: i64,
        mut epoch: u64,
        attempted: &mut u64,
    ) -> io::Result<()> {
        loop {
            let (rest, id) = {
                let Some(client) = weak.upgrade() else {
                    return Ok(());
                };
                if client.rewind_held() {
                    return Ok(());
                }
                (client.rest.clone(), client.id.clone())
            };
            *attempted = epoch;
            let rows = rest.messages(&id, cursor).await?;
            let Some(client) = weak.upgrade() else {
                return Ok(());
            };
            if client.hub_archived() || client.is_closed() || client.rewind_held() {
                return Ok(());
            }
            if let Some(restart) = client.filter.lock().unwrap().rewind_restart(epoch) {
                (cursor, epoch) = restart;
                continue;
            }
            if rows.is_empty() {
                break;
            }
            let mut next = cursor;
            for row in &rows {
                if client.hub_archived() {
                    return Ok(());
                }
                next = next.max(row["seq"].as_i64().unwrap_or(cursor));
                if !row["invokedAt"].is_null()
                    && super::incoming_filter::user_message(&row["content"]).is_some()
                {
                    let mut filter = client.filter.lock().unwrap();
                    if filter.rewind_pending() {
                        filter.accept_delivery(row["id"].as_str(), row["seq"].as_i64(), true);
                        continue;
                    }
                }
                client.incoming_message(row, Delivery::Backfill);
            }
            if client.rewind_held() {
                return Ok(());
            }
            let rewinding = {
                let mut filter = client.filter.lock().unwrap();
                if let Some(restart) = filter.rewind_restart(epoch) {
                    (cursor, epoch) = restart;
                    continue;
                }
                let rewinding = filter.rewind_pending();
                filter.page_scanned(next);
                rewinding
            };
            if next <= cursor {
                if rewinding {
                    return Err(io::Error::other("Rewind backfill did not advance"));
                }
                break;
            }
            cursor = next;
            if rows.len() < 200 {
                break;
            }
        }
        if let Some(client) = weak.upgrade() {
            if !client.rewind_paused() {
                client.filter.lock().unwrap().complete_rewind(epoch);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, rest::Rest};
    use serde_json::json;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
    };

    #[tokio::test]
    async fn waiting_backfill_executes_after_lock_release() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = Config {
            home: Default::default(),
            api_url: format!("http://{}", listener.local_addr().unwrap()),
            cli_api_token: "token".into(),
            extra_headers: vec![],
            machine_id: None,
        };
        let rest = Rest::new(&config).await.unwrap();
        config.api_url = "http://127.0.0.1:0".into();
        let (client, _events) = SessionClient::start(
            &config,
            rest,
            &json!({"id":"s","metadataVersion":0,"agentStateVersion":0}),
        )
        .unwrap();
        let old_holder = client.backfill_lock.lock().await;
        let weak = Arc::downgrade(&client);
        let mut next = Box::pin(SessionClient::backfill(&weak, Some(19)));
        assert!(futures_util::FutureExt::now_or_never(next.as_mut()).is_none());
        drop(old_holder);
        let serve = async {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(&mut stream).lines();
            assert_eq!(
                reader.next_line().await.unwrap().unwrap(),
                "GET /cli/sessions/s/messages?afterSeq=19&limit=200 HTTP/1.1"
            );
            while !reader.next_line().await.unwrap().unwrap().is_empty() {}
            stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 15\r\n\r\n{\"messages\":[]}").await.unwrap();
        };
        let (result, ()) =
            tokio::time::timeout(Duration::from_secs(2), async { tokio::join!(next, serve) })
                .await
                .unwrap();
        result.unwrap();
        client.close();
    }

    #[tokio::test]
    async fn dropping_last_handle_during_held_page_skips_delivery() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = Config {
            home: Default::default(),
            api_url: format!("http://{}", listener.local_addr().unwrap()),
            cli_api_token: "token".into(),
            extra_headers: vec![],
            machine_id: None,
        };
        let rest = Rest::new(&config).await.unwrap();
        config.api_url = "http://127.0.0.1:0".into();
        let (client, _events) = SessionClient::start(
            &config,
            rest,
            &json!({"id":"s","metadataVersion":0,"agentStateVersion":0}),
        )
        .unwrap();
        let delivered = Arc::new(AtomicUsize::new(0));
        let counter = delivered.clone();
        client.on_user_message(Arc::new(move |_, _| {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        let weak = Arc::downgrade(&client);
        let task = tokio::spawn({
            let weak = weak.clone();
            async move { SessionClient::backfill(&weak, Some(0)).await }
        });
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut reader = BufReader::new(&mut stream).lines();
        while !reader.next_line().await.unwrap().unwrap().is_empty() {}
        drop(client);
        assert!(weak.upgrade().is_none());
        let body = json!({"messages":[{"id":"m1","seq":1,"createdAt":1,"localId":"l1","invokedAt":null,"content":{"role":"user","content":{"type":"text","text":"hi"},"meta":{"sentFrom":"web"}}}]}).to_string();
        stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(delivered.load(Ordering::SeqCst), 0);
    }
}
