use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};

struct Backfill {
    after: i64,
    live_ids: HashMap<String, i64>,
}

fn remember(ids: &mut VecDeque<String>, id: &str, capacity: usize) -> bool {
    let index = ids.iter().position(|entry| entry == id);
    if let Some(index) = index {
        let existing = ids.remove(index).unwrap();
        ids.push_back(existing);
    } else {
        ids.push_back(id.to_owned());
        if ids.len() > capacity {
            ids.pop_front();
        }
    }
    index.is_none()
}

struct PendingRewind {
    epoch: u64,
    after: i64,
}

#[derive(Default)]
struct Rewind {
    reconciled_operation: Option<String>,
    observed_claude: Option<String>,
    epoch: u64,
    pending: Option<PendingRewind>,
    scheduled: bool,
    syncing: bool,
}

pub struct IncomingFilter {
    seen: VecDeque<String>,
    capacity: usize,
    backfill: Option<Backfill>,
    cursor: Option<i64>,
    rewind: Rewind,
}
impl Default for IncomingFilter {
    fn default() -> Self {
        Self::new(256)
    }
}
impl IncomingFilter {
    pub fn new(capacity: usize) -> Self {
        Self {
            seen: VecDeque::new(),
            capacity,
            backfill: None,
            cursor: None,
            rewind: Rewind::default(),
        }
    }
    pub fn cursor(&self) -> Option<i64> {
        self.cursor
    }
    pub fn rewind_cursor(&mut self, last_retained: i64) {
        if let Some(cursor) = &mut self.cursor {
            *cursor = (*cursor).min(last_retained);
        }
    }
    pub(super) fn reconcile_rewind(&mut self, metadata: &Value) {
        let intent = super::metadata::claude_rewind(metadata)
            .and_then(|r| r["truncateFromLocalId"].as_str().map(str::to_owned));
        let previous = std::mem::replace(&mut self.rewind.observed_claude, intent);
        if previous.is_some() && self.rewind.observed_claude.is_none() {
            self.arm_rewind();
        }
        let operation = &metadata["opencodeRewind"];
        if operation["phase"] != "committed" {
            return;
        }
        if let Some(id) = operation["operationId"].as_str() {
            if self.rewind.reconciled_operation.as_deref() != Some(id) {
                self.rewind.reconciled_operation = Some(id.to_owned());
                self.arm_rewind();
            }
        }
    }
    pub(super) fn arm_claude_rewind_on_reconnect(&mut self) {
        if self.rewind.observed_claude.is_some() {
            self.arm_rewind();
        }
    }
    fn arm_rewind(&mut self) {
        self.rewind_cursor(0);
        let after = match self.rewind.pending.as_ref().map(|p| p.after) {
            None => self.cursor,
            Some(floor) => Some(floor.min(self.cursor.unwrap_or(floor))),
        };
        self.rewind.epoch += 1;
        self.rewind.pending = after.map(|after| PendingRewind {
            epoch: self.rewind.epoch,
            after,
        });
        if let Some(after) = after {
            let progress = self.backfill.get_or_insert_with(|| Backfill {
                after,
                live_ids: HashMap::new(),
            });
            progress.after = progress.after.min(after);
        }
    }
    pub(super) fn rewind_pending(&self) -> bool {
        self.rewind.pending.is_some()
    }
    pub(super) fn rewind_restart(&self, epoch: u64) -> Option<(i64, u64)> {
        (self.rewind.epoch != epoch).then(|| {
            let after = self.rewind.pending.as_ref().map(|p| p.after);
            (after.or(self.cursor).unwrap_or(0), self.rewind.epoch)
        })
    }
    pub(super) fn backfill_start(&self, start_cursor: Option<i64>) -> Option<(i64, u64)> {
        let start = match &self.rewind.pending {
            Some(pending) => pending.after,
            None => match self.backfill_cursor() {
                Some(after) => after,
                None => start_cursor?,
            },
        };
        Some((start, self.rewind.epoch))
    }
    pub(super) fn complete_rewind(&mut self, epoch: u64) {
        if self
            .rewind
            .pending
            .as_ref()
            .is_some_and(|p| p.epoch == epoch)
        {
            self.rewind.pending = None;
        }
    }
    pub(super) fn rewind_stale(&self, attempted_epoch: u64) -> bool {
        self.rewind
            .pending
            .as_ref()
            .is_some_and(|p| p.epoch != attempted_epoch)
    }
    pub(super) fn set_rewind_syncing(&mut self, syncing: bool) {
        self.rewind.syncing = syncing;
    }
    pub(super) fn claim_rewind_schedule(&mut self) -> bool {
        let claim = self.rewind.pending.is_some() && !self.rewind.scheduled && !self.rewind.syncing;
        self.rewind.scheduled |= claim;
        claim
    }
    pub(super) fn release_rewind_schedule(&mut self) {
        self.rewind.scheduled = false;
    }
    pub(super) fn start_backfill(&mut self) -> Option<i64> {
        let cursor = self.cursor?;
        Some(
            self.backfill
                .get_or_insert_with(|| Backfill {
                    after: cursor,
                    live_ids: HashMap::new(),
                })
                .after,
        )
    }
    pub(super) fn backfill_cursor(&self) -> Option<i64> {
        self.backfill.as_ref().map(|progress| progress.after)
    }
    pub(super) fn page_scanned(&mut self, after: i64) {
        if let Some(pending) = &mut self.rewind.pending {
            pending.after = pending.after.max(after);
            self.cursor = Some(self.cursor.unwrap_or(after).max(after));
        }
        if let Some(progress) = &mut self.backfill {
            progress.after = progress.after.max(after);
            let after = progress.after;
            progress.live_ids.retain(|_, seq| *seq > after);
        }
    }
    pub(super) fn finish_backfill(&mut self) {
        if self.rewind.pending.is_none() {
            self.backfill = None;
        }
    }
    pub(super) fn accept_delivery(
        &mut self,
        id: Option<&str>,
        seq: Option<i64>,
        from_page: bool,
    ) -> bool {
        let accepted = self.accept(id, seq);
        let Some(progress) = &mut self.backfill else {
            return accepted;
        };
        let Some(id) = id.filter(|s| !s.is_empty()) else {
            return accepted;
        };
        if from_page {
            if progress.live_ids.remove(id).is_some() {
                return false;
            }
            accepted
        } else if let Some(seq) = seq.filter(|s| *s > progress.after) {
            progress.live_ids.insert(id.to_owned(), seq).is_none() && accepted
        } else {
            accepted
        }
    }
    pub fn accept(&mut self, id: Option<&str>, seq: Option<i64>) -> bool {
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            if !remember(&mut self.seen, id, self.capacity) {
                return false;
            }
        } else if seq.zip(self.cursor).is_some_and(|(n, c)| n <= c) {
            return false;
        }
        if let Some(n) = seq {
            self.cursor = Some(n.max(self.cursor.unwrap_or(0)));
        }
        true
    }
}
pub(super) fn user_message(raw: &Value) -> Option<Value> {
    let content = &raw["content"];
    if raw["role"] != "user" || content["type"] != "text" {
        return None;
    }
    let mut out = json!({"role":"user","content":{"type":"text","text":content["text"].as_str()?}});
    if let Some(k) = raw.get("localKey") {
        out["localKey"] = k.as_str()?.into();
    }
    if let Some(items) = content.get("attachments") {
        let mut attachments = Vec::new();
        for item in items.as_array()? {
            let mut a = json!({"size":item["size"].as_number()?});
            for key in ["id", "filename", "mimeType", "path"] {
                a[key] = item[key].as_str()?.into();
            }
            if let Some(s) = item.get("previewUrl") {
                a["previewUrl"] = s.as_str()?.into();
            }
            attachments.push(a);
        }
        out["content"]["attachments"] = attachments.into();
    }
    if let Some(meta) = raw.get("meta") {
        let mut m = json!({});
        for (k, v) in meta.as_object()? {
            let valid = match k.as_str() {
                "sentFrom" => v.is_string(),
                "isNativeQueuedMessage" | "isTranscriptEcho" => v.is_boolean(),
                "deliveryMode" => v == "queue" || v == "steer",
                "fallbackModel" | "customSystemPrompt" | "appendSystemPrompt" => {
                    v.is_null() || v.is_string()
                }
                "allowedTools" | "disallowedTools" => {
                    v.is_null() || v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
                }
                _ => continue,
            };
            if !valid {
                return None;
            }
            m[k] = v.clone();
        }
        out["meta"] = m;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::{prelude::*, test_runner::RngSeed};
    #[test]
    fn stalled_backfill_keeps_live_ids_until_page_passes_them() {
        let mut filter = IncomingFilter::new(3);
        assert!(filter.accept(Some("initial"), Some(1)));
        assert_eq!(filter.start_backfill(), Some(1));
        for n in 2..100 {
            assert!(filter.accept_delivery(Some(&n.to_string()), Some(n), false));
        }
        assert!(!filter.accept_delivery(Some("97"), Some(97), false));
        for n in 2..50 {
            assert!(!filter.accept_delivery(Some(&n.to_string()), Some(n), true));
        }
        filter.page_scanned(49);
        assert_eq!(filter.backfill.as_ref().unwrap().live_ids.len(), 50);
        assert!(filter.accept_delivery(Some("100"), Some(100), true));
        for n in 50..100 {
            assert!(!filter.accept_delivery(Some(&n.to_string()), Some(n), true));
        }
        filter.page_scanned(100);
        assert!(filter.backfill.as_ref().unwrap().live_ids.is_empty());
    }

    #[test]
    fn rewind_arms_like_typescript_reconcile() {
        let committed = |id: &str| json!({"opencodeRewind":{"operationId":id,"phase":"committed"}});
        let intent = json!({"claudeRewind":{"targetLocalId":"t","truncateFromLocalId":"cut","keepBoundary":"k","droppedPrompts":[]}});
        let mut both = committed("a");
        both["claudeRewind"] = intent["claudeRewind"].clone();
        let mut f = IncomingFilter::default();
        f.reconcile_rewind(&both);
        assert!(!f.rewind_pending());
        assert!(f.accept(Some("x"), Some(100)));
        f.reconcile_rewind(&both);
        f.reconcile_rewind(&intent);
        assert!(!f.rewind_pending());
        f.arm_claude_rewind_on_reconnect();
        assert_eq!(f.backfill_start(Some(100)), Some((0, 2)));
        assert_eq!(f.cursor(), Some(0));
        f.complete_rewind(2);
        assert_eq!(f.backfill_start(Some(100)), Some((0, 2)));
        f.finish_backfill();
        assert_eq!(f.backfill_start(Some(100)), Some((100, 2)));
        assert!(f.accept(Some("y"), Some(50)));
        f.reconcile_rewind(&json!({}));
        assert_eq!(f.backfill_start(None), Some((0, 3)));
        assert!(!f.accept(Some("x"), Some(100)));
        f.accept(None, Some(30));
        f.reconcile_rewind(&json!({"opencodeRewind":{"operationId":"b","phase":"prepared"}}));
        assert_eq!(f.rewind_restart(3), None);
        f.reconcile_rewind(&committed("b"));
        assert_eq!(f.rewind_restart(3), Some((0, 4)));
        assert!(f.rewind_stale(3));
        f.complete_rewind(3);
        assert!(f.rewind_pending());
        f.finish_backfill();
        assert!(f.backfill.is_some());
        f.complete_rewind(4);
        f.finish_backfill();
        assert!(f.backfill.is_none());
        let mut fresh = IncomingFilter::default();
        fresh.reconcile_rewind(&committed("c"));
        assert!(!fresh.rewind_pending());
        assert!(!fresh.claim_rewind_schedule());
    }
    #[test]
    fn interrupted_rewind_resumes_from_last_completed_page() {
        let mut f = IncomingFilter::default();
        f.accept(Some("a"), Some(500));
        f.reconcile_rewind(&json!({"opencodeRewind":{"operationId":"op","phase":"committed"}}));
        assert_eq!(f.backfill_start(None), Some((0, 1)));
        f.page_scanned(200);
        f.page_scanned(400);
        f.start_backfill();
        assert_eq!(f.backfill_start(Some(0)), Some((400, 1)));
        assert_eq!(f.rewind_restart(0), Some((400, 1)));
        f.reconcile_rewind(&json!({"opencodeRewind":{"operationId":"op2","phase":"committed"}}));
        assert_eq!(f.backfill_start(None), Some((0, 2)));
        f.page_scanned(100);
        f.complete_rewind(2);
        assert_eq!(f.backfill_start(Some(0)), Some((100, 2)));
    }
    #[test]
    fn interrupted_backfill_resumes_from_scanned_page_after_live_delivery() {
        let mut f = IncomingFilter::default();
        assert!(f.accept(Some("a"), Some(100)));
        assert_eq!(f.start_backfill(), Some(100));
        assert_eq!(f.backfill_start(f.cursor()), Some((100, 0)));
        assert!(f.accept_delivery(Some("live"), Some(500), false));
        assert_eq!(f.cursor(), Some(500));
        assert_eq!(f.backfill_start(f.cursor()), Some((100, 0)));
        assert!(f.accept_delivery(Some("p"), Some(200), true));
        f.page_scanned(200);
        assert_eq!(f.start_backfill(), Some(200));
        assert_eq!(f.backfill_start(f.cursor()), Some((200, 0)));
        assert!(!f.accept_delivery(Some("live"), Some(500), true));
        f.page_scanned(500);
        f.finish_backfill();
        assert_eq!(f.backfill_start(f.cursor()), Some((500, 0)));
    }
    #[test]
    fn completed_rewind_keeps_scanned_sequence_as_cursor() {
        let mut f = IncomingFilter::default();
        assert!(f.accept(Some("a"), Some(10)));
        assert!(f.accept(Some("b"), Some(20)));
        f.reconcile_rewind(&json!({"opencodeRewind":{"operationId":"op","phase":"committed"}}));
        assert_eq!(f.backfill_start(None), Some((0, 1)));
        assert!(!f.accept_delivery(Some("a"), Some(10), true));
        assert!(!f.accept_delivery(Some("b"), Some(20), true));
        f.page_scanned(20);
        f.complete_rewind(1);
        f.finish_backfill();
        assert_eq!(f.cursor(), Some(20));
        assert_eq!(f.backfill_start(f.cursor()), Some((20, 1)));
        assert!(!f.accept(None, Some(15)));
        assert!(f.accept(None, Some(21)));
    }
    #[test]
    fn rewind_schedule_claims_once_and_waits_for_reconnect_sync() {
        let mut f = IncomingFilter::default();
        f.accept(Some("a"), Some(5));
        f.arm_claude_rewind_on_reconnect();
        f.reconcile_rewind(&json!({"opencodeRewind":{"operationId":"op","phase":"committed"}}));
        f.set_rewind_syncing(true);
        assert!(!f.claim_rewind_schedule());
        f.set_rewind_syncing(false);
        assert!(f.claim_rewind_schedule());
        assert!(!f.claim_rewind_schedule());
        f.release_rewind_schedule();
        assert!(f.claim_rewind_schedule());
    }

    #[test]
    fn mature_and_idless() {
        let mut f = IncomingFilter::default();
        assert!(f.accept(Some("new"), Some(11)));
        assert!(f.accept(Some("mature"), Some(10)));
        assert!(!f.accept(Some("mature"), Some(13)));
        assert_eq!(f.cursor(), Some(11));
        assert!(!f.accept(None, Some(11)));
        assert!(f.accept(None, Some(12)));
        assert!(f.accept(None, None));
    }
    #[test]
    fn refreshes_recency_before_eviction() {
        let mut f = IncomingFilter::new(2);
        for (id, accept) in [
            ("a", true),
            ("b", true),
            ("a", false),
            ("c", true),
            ("a", false),
            ("b", true),
        ] {
            assert_eq!(f.accept(Some(id), Some(1)), accept);
        }
    }
    proptest! {
        #![proptest_config(ProptestConfig{rng_seed:RngSeed::Fixed(2053),cases:128,..Default::default()})]
        #[test]
        fn cursor_and_id_lru(cap in 1usize..9,stream in prop::collection::vec((prop::option::of(0u8..12),prop::option::of(-2i64..40)),1..200)){
            let mut filter=IncomingFilter::new(cap);let mut recency=std::collections::HashMap::new();let mut cursor=None;
            for (step,(id,seq)) in stream.into_iter().enumerate(){
                let expected=if let Some(id)=id{
                    let new=recency.insert(id,step).is_none();
                    if recency.len()>cap{let old=*recency.iter().min_by_key(|(_,n)|**n).unwrap().0;recency.remove(&old);}
                    new
                }else{!seq.zip(cursor).is_some_and(|(n,c)|n<=c)};
                if expected{if let Some(s)=seq{cursor=Some(s.max(cursor.unwrap_or(0)));}}
                prop_assert_eq!(filter.accept(id.map(|i|i.to_string()).as_deref(),seq),expected);
                prop_assert_eq!(filter.cursor(),cursor);
            }
        }
    }
}

#[cfg(test)]
mod schema_tests {
    use super::*;
    #[test]
    fn typed_user_fields_and_unknown_keys() {
        let attachment = json!({"id":"a","filename":"f","mimeType":"t","path":"/f","size":42});
        let mut preview = attachment.clone();
        preview["previewUrl"] = "https://example.invalid".into();
        let expected = json!({"role":"user","localKey":"key","content":{"type":"text","text":"hi","attachments":[attachment,preview]},"meta":{"sentFrom":"web","isNativeQueuedMessage":true,"isTranscriptEcho":false,"deliveryMode":"steer","fallbackModel":"m","customSystemPrompt":"a","appendSystemPrompt":"b","allowedTools":["a"],"disallowedTools":[] }});
        let mut input = expected.clone();
        input["extra"] = 1.into();
        input["content"]["extra"] = true.into();
        input["content"]["attachments"][0]["extra"] = 1.into();
        input["meta"]["extra"] = 1.into();
        assert_eq!(user_message(&input), Some(expected.clone()));
        for key in expected["meta"].as_object().unwrap().keys() {
            let mut bad = expected.clone();
            bad["meta"][key] = 42.into();
            assert!(user_message(&bad).is_none(), "{key}");
            bad["meta"][key] = Value::Null;
            assert_eq!(
                user_message(&bad).is_some(),
                matches!(
                    key.as_str(),
                    "fallbackModel"
                        | "customSystemPrompt"
                        | "appendSystemPrompt"
                        | "allowedTools"
                        | "disallowedTools"
                )
            );
        }
        for val in [json!("later"), Value::Null] {
            let mut bad = expected.clone();
            bad["meta"]["deliveryMode"] = val;
            assert!(user_message(&bad).is_none());
        }
        let mut bad = expected.clone();
        bad["meta"]["allowedTools"] = json!([3]);
        assert!(user_message(&bad).is_none());
        for key in ["id", "filename", "mimeType", "path", "size", "previewUrl"] {
            let mut bad = expected.clone();
            bad["content"]["attachments"][0][key] = Value::Null;
            assert!(user_message(&bad).is_none(), "{key}");
        }
        let mut bad = expected;
        bad["localKey"] = false.into();
        assert!(user_message(&bad).is_none());
    }
}
