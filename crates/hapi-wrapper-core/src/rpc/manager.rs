use crate::{jsjson::stringify, sio::client::Client};
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::{
    future::Future,
    sync::{Arc, Mutex},
};

type Handler =
    Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Option<Value>, String>> + Send + Sync>;
#[derive(Default)]
struct Registry {
    handlers: Vec<(String, Handler)>,
    socket: Option<Client>,
}
pub struct RpcHandlerManager {
    prefix: String,
    registry: Mutex<Registry>,
}
impl RpcHandlerManager {
    pub fn new(session_id: &str) -> Self {
        Self {
            prefix: format!("{session_id}:"),
            registry: Mutex::default(),
        }
    }
    fn method(&self, name: &str) -> String {
        format!("{}{name}", self.prefix)
    }
    pub fn register<F, Fut>(&self, name: &str, handler: F)
    where
        F: Fn(Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Option<Value>, String>> + Send + 'static,
    {
        let method = self.method(name);
        let handler: Handler = Arc::new(move |v| Box::pin(handler(v)));
        let mut registry = self.registry.lock().unwrap();
        if let Some((_, existing)) = registry.handlers.iter_mut().find(|(key, _)| key == &method) {
            *existing = handler;
        } else {
            registry.handlers.push((method.clone(), handler));
        }
        if let Some(socket) = &registry.socket {
            socket.emit("rpc-register", vec![json!({"method":method})]);
        }
    }
    pub fn on_connect(&self, socket: &Client) {
        let mut registry = self.registry.lock().unwrap();
        registry.socket = Some(socket.clone());
        for (method, _) in &registry.handlers {
            socket.emit("rpc-register", vec![json!({"method":method})]);
        }
    }
    pub fn on_disconnect(&self) {
        self.registry.lock().unwrap().socket = None;
    }
    pub fn count(&self) -> usize {
        self.registry.lock().unwrap().handlers.len()
    }
    pub fn has(&self, name: &str) -> bool {
        let key = self.method(name);
        self.registry
            .lock()
            .unwrap()
            .handlers
            .iter()
            .any(|(k, _)| k == &key)
    }
    pub fn clear(&self) {
        self.registry.lock().unwrap().handlers.clear();
    }
    pub async fn handle_request(&self, request: &Value) -> Option<String> {
        let method = request["method"].as_str();
        let handler = self
            .registry
            .lock()
            .unwrap()
            .handlers
            .iter()
            .find(|(k, _)| Some(k.as_str()) == method)
            .map(|(_, f)| f.clone());
        let Some(handler) = handler else {
            return Some(stringify(&json!({"error":"Method not found"})));
        };
        let params = request["params"]
            .as_str()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        match handler(params).await {
            Ok(v) => v.as_ref().map(stringify),
            Err(e) => Some(stringify(&json!({"error":e}))),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn scoped_lookup_and_replacement() {
        let m = RpcHandlerManager::new("s");
        m.register("double", |v| async move {
            Ok(Some(json!(v.as_i64().unwrap() * 2)))
        });
        assert!(m.has("double"));
        assert_eq!(m.count(), 1);
        assert_eq!(
            m.handle_request(&json!({"method":"s:double","params":"21"}))
                .await
                .as_deref(),
            Some("42")
        );
        assert_eq!(
            m.handle_request(&json!({"method":"other:double","params":"21"}))
                .await
                .as_deref(),
            Some(r#"{"error":"Method not found"}"#)
        );
        m.register("double", |_| async { Ok(None) });
        assert_eq!(m.count(), 1);
        assert_eq!(m.handle_request(&json!({"method":"s:double"})).await, None);
        m.clear();
        assert!(!m.has("double"));
        assert_eq!(m.count(), 0);
    }
    #[tokio::test]
    async fn malformed_params_and_handler_errors() {
        let m = RpcHandlerManager::new("s");
        m.register("echo", |v| async move { Ok(Some(v)) });
        m.register("fail", |_| async { Err("failed".into()) });
        assert_eq!(
            m.handle_request(&json!({"method":"s:echo","params":"{"}))
                .await
                .as_deref(),
            Some("null")
        );
        assert_eq!(
            m.handle_request(&json!({"method":"s:fail","params":"{}"}))
                .await
                .as_deref(),
            Some(r#"{"error":"failed"}"#)
        );
    }
}
