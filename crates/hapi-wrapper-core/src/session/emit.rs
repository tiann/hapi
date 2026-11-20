use super::{
    client::SessionClient,
    metadata::{now, spread},
};
use serde_json::{json, Value};
use std::{sync::LazyLock, time::Duration};
use uuid::Uuid;

pub(super) fn external_text(body: &Value) -> Option<String> {
    if body["type"] != "user"
        || body["isMeta"] == true
        || body["isSidechain"] == true
        || body["isCompactSummary"] == true
    {
        return None;
    }
    let c = &body["message"]["content"];
    let text = if let Some(s) = c.as_str() {
        s.into()
    } else {
        let parts: Vec<_> = c
            .as_array()?
            .iter()
            .filter(|p| p["type"] == "text")
            .filter_map(|p| p["text"].as_str())
            .collect();
        if parts.is_empty() {
            return None;
        }
        parts.join("\n")
    };
    (![
        "<task-notification>",
        "<command-name>",
        "<local-command-caveat>",
        "<system-reminder>",
    ]
    .iter()
    .any(|p| text.trim_start().starts_with(p)))
    .then_some(text)
}
fn parse_iso_timestamp_ms(s: &str) -> Option<i64> {
    static ISO: LazyLock<regex_lite::Regex> = LazyLock::new(|| {
        regex_lite::Regex::new(r"^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))?)?$").unwrap()
    });
    let c = ISO.captures(s.trim())?;
    let n = |i| {
        c.get(i)
            .and_then(|v| v.as_str().parse::<i64>().ok())
            .unwrap_or(0)
    };
    let (year, month, day, hour, min, sec) = (n(1), n(2), n(3), n(4), n(5), n(6));
    let ms = c.get(7).map_or(0, |s| {
        s.as_str()
            .bytes()
            .take(3)
            .zip([100, 10, 1])
            .map(|(digit, scale)| (digit - b'0') as i64 * scale)
            .sum()
    });
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 24
        || min > 59
        || sec > 59
        || (hour == 24 && min + sec + ms != 0)
        || n(9) > 23
        || n(10) > 59
    {
        return None;
    }
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let y = year.rem_euclid(400);
    let m = month + if month > 2 { -3 } else { 9 };
    let days = era * 146097 + y * 365 + y / 4 - y / 100 + (153 * m + 2) / 5 + day - 1 - 719468;
    let offset = (n(9) * 60 + n(10))
        * if c.get(8).is_some_and(|s| s.as_str() == "-") {
            -1
        } else {
            1
        };
    Some((((days * 24 + hour) * 60 + min - offset) * 60 + sec) * 1000 + ms)
}
fn transcript_summary(row: &Value) -> Option<&Value> {
    if row["type"] == "summary" && row.get("leafUuid").is_some() {
        row.get("summary")
    } else {
        None
    }
}

impl SessionClient {
    fn emit(&self, name: &str, mut payload: Value) {
        payload["sid"] = json!(self.id);
        self.socket.emit(name, vec![payload]);
    }
    fn message(&self, message: Value, id: Option<&str>, consume: bool) {
        let mut body = json!({"message":message});
        if let Some(id) = id {
            body["localId"] = id.into();
        }
        self.emit("message", body);
        if let Some(id) = id.filter(|s| consume && !s.is_empty()) {
            self.messages_consumed(&[id.to_owned()], false, false);
        }
    }
    pub fn send_claude_session_message(&self, body: &Value) {
        let payload = claude_payload(body, &mut self.echoes.lock().unwrap());
        self.emit("message", payload);
        if let Some(summary) = transcript_summary(body).cloned() {
            self.metadata.update(move |metadata| {
                let mut updated = metadata.clone();
                updated["summary"] = json!({"text":summary,"updatedAt":now()});
                updated
            });
        }
    }
    pub fn send_user_message(&self, text: &str, meta: &Value, id: Option<&str>) {
        if text.is_empty() {
            return;
        }
        let mut merged = json!({"sentFrom":"cli"});
        spread(&mut merged, meta);
        self.message(
            json!({"role":"user","content":{"type":"text","text":text},"meta":merged}),
            id,
            true,
        );
    }
    pub fn send_agent_message(&self, body: Value, id: Option<&str>) {
        self.message(json!({"role":"agent","content":{"type":"codex","data":body},"meta":{"sentFrom":"cli"}}),id,true);
    }
    pub fn send_session_event(&self, event: Value, id: Option<&str>, local_id: Option<&str>) {
        let id = id
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        self.message(
            json!({"role":"agent","content":{"id":id,"type":"event","data":event}}),
            local_id.filter(|s| !s.is_empty()),
            false,
        );
    }
    pub fn native_queue_message(&self, id: &str, text: Option<&str>) {
        self.emit("native-queue-message", json!({"localId":id,"text":text}));
    }
    pub fn keep_alive(&self, thinking: bool, mode: Option<&str>, runtime: &Value) {
        let mut latest = json!({"thinking":thinking});
        if let Some(mode) = mode {
            latest["mode"] = mode.into();
        }
        spread(&mut latest, runtime);
        *self.latest.lock().unwrap() = latest;
        self.alive(true);
    }
    pub fn session_ready(&self) {
        self.emit("session-ready", json!({"time":now()}));
    }
    pub fn session_end(&self, reason: Option<&str>) {
        self.stop_keep_alive();
        let mut body = json!({"time":now()});
        if let Some(reason) = reason {
            body["reason"] = reason.into();
        }
        self.emit("session-end", body);
    }
    pub fn messages_consumed(&self, ids: &[String], clear: bool, steered: bool) {
        if ids.is_empty() {
            return;
        }
        let mut body = json!({"localIds":ids});
        if clear {
            body["clearQueuedThinkingGrace"] = true.into();
        }
        if steered {
            body["steered"] = true.into();
        }
        self.emit("messages-consumed", body);
    }
    pub fn steer_indeterminate(&self, ids: &[String]) {
        if !ids.is_empty() {
            self.emit("messages-indeterminate", json!({"localIds":ids}));
        }
    }
    pub async fn steer_state(&self, ids: &[String], state: &str) -> bool {
        if ids.is_empty() {
            return false;
        }
        self.socket
            .emit_with_ack(
                "messages-steer-state",
                vec![json!({"sid":self.id,"localIds":ids,"state":state})],
                Some(Duration::from_secs(5)),
            )
            .await
            .is_ok_and(|a| a.first().is_some_and(|v| v["ok"] == true))
    }
}

pub(super) fn claude_payload(body: &Value, echoes: &mut super::echo::Echoes) -> Value {
    let mut echo = false;
    let message = match external_text(body) {
        Some(text) => {
            echo = echoes.consume(&text);
            let mut meta = json!({"sentFrom":"cli"});
            if echo {
                meta["isTranscriptEcho"] = true.into();
            }
            json!({"role":"user","content":{"type":"text","text":text},"meta":meta})
        }
        None => {
            json!({"role":"agent","content":{"type":"output","data":body},"meta":{"sentFrom":"cli"}})
        }
    };
    let mut payload = json!({"message":message});
    if let Some(ms) = body["timestamp"]
        .as_str()
        .and_then(parse_iso_timestamp_ms)
        .filter(|_| !echo)
    {
        payload["createdAt"] = ms.into();
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::echo::Echoes;
    #[test]
    fn summary_requires_log_type_text_field_and_leaf() {
        for invalid in [
            json!({"type":"summary","leafUuid":"leaf"}),
            json!({"type":"summary","summary":"text"}),
            json!({"type":"assistant","summary":"text","leafUuid":"leaf"}),
        ] {
            assert!(transcript_summary(&invalid).is_none());
        }
        assert_eq!(
            transcript_summary(&json!({"type":"summary","summary":"","leafUuid":"leaf"})),
            Some(&json!(""))
        );
    }
    fn row(content: Value) -> Value {
        json!({"type":"user","timestamp":"2024-03-10T00:00:00.000Z","message":{"content":content}})
    }
    fn echoed(payload: &Value) -> bool {
        payload["message"]["meta"]["isTranscriptEcho"] == true
    }
    #[test]
    fn real_user_and_injected_rows() {
        for (input, expected) in [
            (
                json!("hello <system-reminder>"),
                Some("hello <system-reminder>"),
            ),
            (
                json!([{"type":"text","text":"a"},{"type":"text","text":"b"}]),
                Some("a\nb"),
            ),
            (json!([{"type":"tool_result"}]), None),
            (json!(" \n<task-notification>x"), None),
            (json!("<command-name>x"), None),
            (json!("<local-command-caveat>x"), None),
            (json!("<system-reminder>x"), None),
        ] {
            assert_eq!(external_text(&row(input)).as_deref(), expected);
        }
        for (key, val) in [
            ("isMeta", json!(true)),
            ("isSidechain", json!(true)),
            ("isCompactSummary", json!(true)),
            ("type", json!("assistant")),
        ] {
            let mut body = row(json!("hello"));
            body[key] = val;
            assert!(external_text(&body).is_none());
        }
        let mut summary = row(json!("This session is being continued"));
        summary["isCompactSummary"] = true.into();
        let payload = claude_payload(&summary, &mut Echoes::default());
        assert_eq!(payload["message"]["role"], "agent");
        assert_eq!(payload["message"]["content"]["data"], summary);
        summary["isCompactSummary"] = false.into();
        let payload = claude_payload(&summary, &mut Echoes::default());
        assert_eq!(payload["message"]["role"], "user");
    }
    #[test]
    fn original_transcript_time() {
        let mut echoes = Echoes::default();
        let mut body = row(json!("local input"));
        for kind in ["user", "assistant"] {
            body["type"] = kind.into();
            let payload = claude_payload(&body, &mut echoes);
            assert_eq!(payload["createdAt"], 1710028800000_i64);
            assert!(!echoed(&payload));
        }
        body["timestamp"] = "invalid".into();
        assert!(claude_payload(&body, &mut echoes)
            .get("createdAt")
            .is_none());
    }
    #[test]
    fn formatted_batched_echo_only_once() {
        let mut echoes = Echoes::default();
        echoes.note("one", &["first".into()]);
        echoes.note("file\none\ntwo", &["first".into(), "second".into()]);
        for (text, expected) in [
            ("one", false),
            ("two", false),
            ("file\none\ntwo", true),
            ("file\none\ntwo", false),
        ] {
            let payload = claude_payload(&row(json!(text)), &mut echoes);
            assert_eq!(echoed(&payload), expected);
            assert_eq!(payload.get("createdAt").is_none(), expected);
        }
    }
    #[test]
    fn discarded_and_nameless_echoes() {
        let mut e = Echoes::default();
        e.note("x", &["id".into()]);
        e.discard_id("id");
        assert!(!e.consume("x"));
        e.note("a", &[]);
        e.note("b", &[]);
        assert!(!e.consume("a"));
        e.discard_text(" b ");
        assert!(!e.consume("b"));
        for i in 0..33 {
            e.note(&i.to_string(), &[i.to_string()]);
        }
        assert!(!e.consume("0"));
        assert!(e.consume("1"));
    }
}
