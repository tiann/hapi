use bytes::Bytes;
use futures_util::Future;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::{body::Incoming, server::conn::http1, service::service_fn, Request, Response};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{convert::Infallible, io};
use tokio::{
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};

pub(crate) type Reply = Response<BoxBody<Bytes, Infallible>>;
pub(crate) fn reply(status: u16, mime: &str, data: impl Into<Bytes>) -> Reply {
    Response::builder()
        .status(status)
        .header("content-type", mime)
        .body(Full::new(data.into()).boxed())
        .unwrap()
}
pub struct Listener {
    pub port: u16,
    task: Option<JoinHandle<()>>,
    stop: tokio::sync::watch::Sender<bool>,
}
impl Drop for Listener {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
impl Listener {
    pub async fn shutdown(mut self) {
        self.stop.send_replace(true);
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
    pub(crate) async fn bind<F, Fut>(handler: F) -> io::Result<Self>
    where
        F: Fn(Request<Incoming>, u16, tokio::sync::watch::Receiver<bool>) -> Fut
            + Clone
            + Send
            + Sync
            + 'static,
        Fut: Future<Output = Reply> + Send + 'static,
    {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    _=stopped.changed()=>break,
                    (stream,_) = accept_with_retry(|| listener.accept()) => {
                        let handler=handler.clone();
                        let mut closing=stopped.clone();
                        connections.spawn(async move {
                            let signal = closing.clone();
                            let service=service_fn(move |r| { let response=handler(r, port, signal.clone()); async move {Ok::<_, Infallible>(response.await)} });
                            let conn=http1::Builder::new().timer(TokioTimer::new()).serve_connection(TokioIo::new(stream),service);
                            tokio::pin!(conn);
                            tokio::select!{_= &mut conn=>{},_=closing.changed()=>{conn.as_mut().graceful_shutdown();let _=conn.await;}}

                        });
                    }
                    _=connections.join_next(), if !connections.is_empty()=>{}
                }
            }
            let _ = tokio::time::timeout(std::time::Duration::from_secs(1), async {
                while connections.join_next().await.is_some() {}
            })
            .await;
        });
        Ok(Self {
            port,
            task: Some(task),
            stop,
        })
    }
}

async fn accept_with_retry<T, F: Future<Output = io::Result<T>>>(
    mut accept: impl FnMut() -> F,
) -> T {
    loop {
        match accept().await {
            Ok(stream) => return stream,
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
        }
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test(start_paused = true)]
    async fn accepts_after_transient_errors() {
        let mut attempts = 0;
        let start = tokio::time::Instant::now();
        super::accept_with_retry(|| {
            attempts += 1;
            std::future::ready(match attempts {
                1 => Err(std::io::ErrorKind::ConnectionAborted.into()),
                2 => Err(std::io::Error::other("too many open files")),
                _ => Ok(()),
            })
        })
        .await;
        assert_eq!(attempts, 3);
        assert_eq!(start.elapsed(), std::time::Duration::from_millis(100));
    }
    #[tokio::test(start_paused = true)]
    async fn incomplete_headers_expire_but_slow_replies_do_not() {
        use std::time::Duration;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let server = super::Listener::bind(|_, _, _| async {
            tokio::time::sleep(Duration::from_secs(120)).await;
            super::reply(200, "text/plain", "late")
        })
        .await
        .unwrap();
        let connect = || tokio::net::TcpStream::connect(("127.0.0.1", server.port));
        let mut partial = connect().await.unwrap();
        partial
            .write_all(b"POST / HTTP/1.1\r\nhost: x\r\n")
            .await
            .unwrap();
        let mut full = connect().await.unwrap();
        full.write_all(
            b"POST / HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
        )
        .await
        .unwrap();
        let mut out = Vec::new();
        tokio::time::timeout(Duration::from_secs(60), partial.read_to_end(&mut out))
            .await
            .expect("incomplete header was not timed out")
            .unwrap();
        let mut out = String::new();
        full.read_to_string(&mut out).await.unwrap();
        assert!(
            out.starts_with("HTTP/1.1 200") && out.ends_with("late"),
            "{out}"
        );
    }
}
