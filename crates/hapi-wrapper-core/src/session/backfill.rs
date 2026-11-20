use super::client::{Delivery, SessionClient};
use std::{io, sync::Arc};
impl SessionClient {
    pub(super) async fn backfill(self: &Arc<Self>, start_cursor: Option<i64>) -> io::Result<()> {
        let guard = self.backfill_lock.lock().await;
        let Some((cursor, epoch)) = self.filter.lock().unwrap().backfill_start(start_cursor) else {
            return Ok(());
        };
        let mut attempted = epoch;
        let result = self.backfill_pages(cursor, epoch, &mut attempted).await;
        drop(guard);
        if self.filter.lock().unwrap().rewind_stale(attempted) {
            self.schedule_rewind_backfill();
        }
        result
    }
    fn rewind_held(&self) -> bool {
        self.filter.lock().unwrap().rewind_pending() && self.rewind_paused()
    }
    async fn backfill_pages(
        &self,
        mut cursor: i64,
        mut epoch: u64,
        attempted: &mut u64,
    ) -> io::Result<()> {
        loop {
            if self.rewind_held() {
                return Ok(());
            }
            *attempted = epoch;
            let rows = self.rest.messages(&self.id, cursor).await?;
            if self.rewind_held() {
                return Ok(());
            }
            if let Some(restart) = self.filter.lock().unwrap().rewind_restart(epoch) {
                (cursor, epoch) = restart;
                continue;
            }
            if rows.is_empty() {
                break;
            }
            let mut next = cursor;
            for row in &rows {
                next = next.max(row["seq"].as_i64().unwrap_or(cursor));
                if !row["invokedAt"].is_null()
                    && super::incoming_filter::user_message(&row["content"]).is_some()
                {
                    let mut filter = self.filter.lock().unwrap();
                    if filter.rewind_pending() {
                        filter.accept_delivery(row["id"].as_str(), row["seq"].as_i64(), true);
                        continue;
                    }
                }
                self.incoming_message(row, Delivery::Backfill);
            }
            if self.rewind_held() {
                return Ok(());
            }
            let rewinding = {
                let mut filter = self.filter.lock().unwrap();
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
        if !self.rewind_paused() {
            self.filter.lock().unwrap().complete_rewind(epoch);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, rest::Rest};
    use serde_json::json;
    use std::time::Duration;
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
        let mut next = Box::pin(client.backfill(Some(19)));
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
}
