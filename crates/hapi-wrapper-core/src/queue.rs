use crate::session::client::Cancellation;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::sync::{oneshot, watch};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Internal {
    Control,
    ModelErrorBridge(String),
}

#[derive(Debug, Clone)]
pub struct QueueItem<T> {
    pub message: String,
    pub mode: T,
    pub hash: String,
    pub local_id: Option<String>,
    pub isolated: bool,
    pub internal: Option<Internal>,
    order: i64,
}
#[derive(Debug, Clone)]
pub struct Batch<T> {
    pub message: String,
    pub mode: T,
    pub hash: String,
    pub isolated: bool,
    pub items: Vec<QueueItem<T>>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    Push,
    Immediate,
    Isolated,
    IsolateAndClear,
    Unshift,
    UnshiftIsolated,
}
#[derive(Clone)]
pub struct Reservation<T> {
    item: QueueItem<T>,
    flags: Arc<ReservationFlags>,
}
impl<T> Reservation<T> {
    pub fn item(&self) -> &QueueItem<T> {
        &self.item
    }
}

pub struct AbortController(watch::Sender<bool>);
#[derive(Clone)]
pub struct AbortSignal(watch::Receiver<bool>);

impl AbortController {
    pub fn channel() -> (Self, AbortSignal) {
        let (sender, receiver) = watch::channel(false);
        (Self(sender), AbortSignal(receiver))
    }

    pub fn abort(&self) {
        self.0.send_replace(true);
    }
}

struct ReservationFlags {
    reset: AtomicBool,
    ambiguous: AtomicBool,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Reserved,
    Dispatching,
    Indeterminate,
}
struct Held<T> {
    handle: Reservation<T>,
    state: State,
}
type Arrival<T> = Box<dyn Fn(&str, &T) + Send + Sync>;
type Consumed = Box<dyn Fn(&[String]) + Send + Sync>;
pub struct MessageQueue2<T> {
    items: VecDeque<QueueItem<T>>,
    held: HashMap<String, Held<T>>,
    consumed: VecDeque<String>,
    in_flight: HashSet<String>,
    head: i64,
    tail: i64,
    closed: bool,
    waiter: Option<oneshot::Sender<bool>>,
    hasher: Box<dyn Fn(&T) -> String + Send + Sync>,
    pub on_message: Option<Arrival<T>>,
    pub on_batch_consumed: Option<Consumed>,
    pub before_dequeue: Option<Box<dyn Fn() -> io::Result<()> + Send + Sync>>,
}
impl<T: Clone> MessageQueue2<T> {
    pub fn new(hasher: impl Fn(&T) -> String + Send + Sync + 'static) -> Self {
        Self {
            items: Default::default(),
            held: Default::default(),
            consumed: Default::default(),
            in_flight: Default::default(),
            head: 0,
            tail: 0,
            closed: false,
            waiter: None,
            hasher: Box::new(hasher),
            on_message: None,
            on_batch_consumed: None,
            before_dequeue: None,
        }
    }
    pub fn size(&self) -> usize {
        self.items.len()
    }
    pub fn is_closed(&self) -> bool {
        self.closed
    }
    pub fn enqueue(
        &mut self,
        placement: Placement,
        message: String,
        mode: T,
        local_id: Option<String>,
        internal: Option<Internal>,
    ) -> io::Result<()> {
        let front = matches!(placement, Placement::Unshift | Placement::UnshiftIsolated);
        if self.closed {
            return Err(io::Error::other(if front {
                "Cannot unshift to closed queue"
            } else {
                "Cannot push to closed queue"
            }));
        }
        if placement == Placement::IsolateAndClear {
            self.items.clear();
            self.cancel_reservations(false);
        }
        let order = if front {
            self.head -= 1;
            self.head
        } else {
            self.tail += 1;
            self.tail
        };
        let hash = (self.hasher)(&mode);
        let item = QueueItem {
            message,
            mode,
            hash,
            local_id,
            internal,
            order,
            isolated: matches!(
                placement,
                Placement::Isolated | Placement::IsolateAndClear | Placement::UnshiftIsolated
            ),
        };
        let inserted = if front {
            if let Some(id) = &item.local_id {
                self.in_flight.remove(id);
            }
            self.items.push_front(item);
            self.items.front().unwrap()
        } else {
            self.items.push_back(item);
            self.items.back().unwrap()
        };
        if let Some(f) = &self.on_message {
            f(&inserted.message, &inserted.mode);
        }
        self.wake(true);
        Ok(())
    }
    fn wake(&mut self, ready: bool) {
        if let Some(tx) = self.waiter.take() {
            let _ = tx.send(ready);
        }
    }
    fn cancel_reservations(&mut self, preserve: bool) {
        self.held.retain(|_, held| {
            let keep = preserve && held.state != State::Reserved;
            if !keep {
                held.handle.flags.reset.store(true, Ordering::Relaxed);
            }
            keep
        });
    }
    pub fn reset(&mut self, preserve_dispatching: bool) {
        self.closed = false;
        self.items.clear();
        self.in_flight.clear();
        self.cancel_reservations(preserve_dispatching);
        self.waiter.take();
    }
    pub fn close(&mut self) {
        self.closed = true;
        self.cancel_reservations(false);
        self.in_flight.clear();
        self.wake(false);
    }
    pub fn pending_local_ids(&self) -> Vec<String> {
        self.items
            .iter()
            .filter_map(|i| i.local_id.clone())
            .collect()
    }
    pub fn has_message_matching(&self, f: impl Fn(&str) -> bool) -> bool {
        self.items.iter().any(|i| f(&i.message))
    }
    pub fn remove_items_matching(&mut self, f: impl Fn(&QueueItem<T>) -> bool) -> usize {
        let before = self.items.len();
        self.items.retain(|i| {
            if !f(i) {
                return true;
            }
            if let Some(id) = &i.local_id {
                self.held.remove(id);
            }
            false
        });
        before - self.items.len()
    }
    pub fn has_pending_non_bridge_turn(&self) -> bool {
        self.items.iter().any(|i| i.internal.is_none())
            || self.held.values().any(|h| h.handle.item.internal.is_none())
    }
    pub fn cancel_model_error_bridge(&mut self, event: &str) -> bool {
        if event.is_empty() {
            return false;
        }
        let index = self
            .items
            .iter()
            .position(|i| matches!(&i.internal,Some(Internal::ModelErrorBridge(v)) if v==event));
        index.and_then(|n| self.items.remove(n)).is_some()
    }
    pub fn peek_by_local_id(&self, id: &str) -> Option<&QueueItem<T>> {
        self.position(id).map(|n| &self.items[n])
    }
    pub fn peek_next_batch_mode(&self) -> Option<(&T, bool)> {
        self.items.front().map(|item| (&item.mode, item.isolated))
    }
    fn position(&self, id: &str) -> Option<usize> {
        if id.is_empty() {
            return None;
        }
        self.items
            .iter()
            .position(|i| i.local_id.as_deref() == Some(id))
    }
    pub fn cancel_by_local_id(&mut self, id: &str) -> Cancellation {
        if let Some(n) = self.position(id) {
            self.items.remove(n);
            return Cancellation::Removed;
        }
        if self.in_flight.contains(id)
            || self
                .held
                .get(id)
                .is_some_and(|h| h.state == State::Dispatching)
        {
            return Cancellation::InFlight;
        }
        if self.held.remove(id).is_some() {
            Cancellation::Removed
        } else if self.consumed.iter().any(|v| v == id) {
            Cancellation::Consumed
        } else {
            Cancellation::Missing
        }
    }
    pub fn take_by_local_id(&mut self, id: &str) -> Option<Reservation<T>> {
        let (item, ambiguous) = if let Some(h) = self.held.get(id) {
            if h.state != State::Indeterminate {
                return None;
            }
            (h.handle.item.clone(), true)
        } else {
            let n = self.position(id)?;
            (self.items.remove(n)?, false)
        };
        let handle = Reservation {
            item,
            flags: Arc::new(ReservationFlags {
                reset: AtomicBool::new(false),
                ambiguous: AtomicBool::new(ambiguous),
            }),
        };
        self.held.insert(
            id.into(),
            Held {
                handle: handle.clone(),
                state: State::Reserved,
            },
        );
        Some(handle)
    }
    fn active(&mut self, r: &Reservation<T>) -> Option<&mut Held<T>> {
        self.held
            .get_mut(r.item.local_id.as_ref()?)
            .filter(|h| Arc::ptr_eq(&h.handle.flags, &r.flags))
    }
    fn held_reservation(&self, r: &Reservation<T>) -> Option<&Held<T>> {
        self.held
            .get(r.item.local_id.as_ref()?)
            .filter(|h| Arc::ptr_eq(&h.handle.flags, &r.flags))
    }
    pub fn is_dispatching(&self, r: &Reservation<T>) -> bool {
        self.held_reservation(r)
            .is_some_and(|h| h.state == State::Dispatching)
    }
    pub fn is_ambiguous(&self, r: &Reservation<T>) -> bool {
        r.flags.ambiguous.load(Ordering::Relaxed)
    }
    pub fn begin_dispatch(&mut self, r: &Reservation<T>) -> bool {
        if let Some(h) = self.active(r).filter(|h| h.state == State::Reserved) {
            h.state = State::Dispatching;
            true
        } else {
            false
        }
    }
    pub fn mark_indeterminate(&mut self, r: &Reservation<T>) -> bool {
        if let Some(h) = self.active(r).filter(|h| h.state == State::Dispatching) {
            r.flags.ambiguous.store(true, Ordering::Relaxed);
            h.state = State::Indeterminate;
            true
        } else {
            false
        }
    }
    pub fn release_indeterminate(&mut self, id: &str) -> bool {
        if self
            .held
            .get(id)
            .is_some_and(|h| h.state == State::Indeterminate)
        {
            self.held.remove(id);
            true
        } else {
            false
        }
    }
    pub fn restore(&mut self, r: &Reservation<T>) -> bool {
        let Some(h) = self.active(r) else {
            return false;
        };
        if r.flags.ambiguous.load(Ordering::Relaxed) {
            h.state = State::Indeterminate;
            return true;
        }
        let Some(id) = r.item.local_id.as_ref() else {
            return false;
        };
        if self.closed {
            return false;
        }
        let item = self.held.remove(id).unwrap().handle.item;
        let index = self.items.partition_point(|i| i.order < item.order);
        self.items.insert(index, item);
        self.wake(true);
        true
    }
    pub fn commit(&mut self, r: &Reservation<T>) -> bool {
        let Some(id) = r.item.local_id.as_ref() else {
            return false;
        };
        if self.active(r).is_some() {
            self.held.remove(id);
        } else if !r.flags.reset.load(Ordering::Relaxed) {
            return false;
        }
        self.consumed.retain(|v| v != id);
        self.consumed.push_back(id.clone());
        if self.consumed.len() > 256 {
            self.consumed.pop_front();
        }
        true
    }
    pub fn collect(&mut self, deferred: bool) -> io::Result<Option<Batch<T>>> {
        let Some(first) = self.items.front() else {
            return Ok(None);
        };
        if let Some(f) = &self.before_dequeue {
            f()?
        }
        let count = if first.isolated {
            1
        } else {
            self.items
                .iter()
                .take_while(|i| !i.isolated && i.hash == first.hash)
                .count()
        };
        let (mode, hash, isolated) = (first.mode.clone(), first.hash.clone(), first.isolated);
        let items: Vec<_> = self.items.drain(..count).collect();
        let message = items
            .iter()
            .map(|i| i.message.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let batch = Batch {
            message,
            mode,
            hash,
            isolated,
            items,
        };
        if deferred {
            self.begin_batch(&batch)
        } else {
            self.ack(&batch)
        }
        Ok(Some(batch))
    }
    pub async fn wait(
        queue: &Mutex<Self>,
        abort: AbortSignal,
        deferred: bool,
    ) -> io::Result<Option<Batch<T>>> {
        let AbortSignal(mut abort) = abort;
        let rx = {
            let mut q = queue.lock().unwrap();
            if *abort.borrow() {
                return Ok(None);
            }
            if !q.items.is_empty() {
                return q.collect(deferred);
            }
            if q.closed {
                return Ok(None);
            }
            let (tx, rx) = oneshot::channel();
            q.waiter = Some(tx);
            rx
        };
        let ready = tokio::select! {
            biased;
            Ok(_) = abort.wait_for(|v|*v) => false,
            Ok(ready) = rx => ready,
            else => false,
        };
        if !ready {
            return Ok(None);
        }
        let mut q = queue.lock().unwrap();
        if *abort.borrow() {
            return Ok(None);
        }
        q.collect(deferred)
    }
    fn ids(batch: &Batch<T>) -> impl Iterator<Item = &String> {
        batch
            .items
            .iter()
            .filter_map(|i| i.local_id.as_ref())
            .filter(|id| !id.is_empty())
    }
    fn ack(&self, b: &Batch<T>) {
        if let Some(f) = &self.on_batch_consumed {
            let ids: Vec<_> = Self::ids(b).cloned().collect();
            if !ids.is_empty() {
                f(&ids)
            }
        }
    }
    pub fn begin_batch(&mut self, b: &Batch<T>) {
        self.in_flight.extend(Self::ids(b).cloned());
    }
    pub fn release_batch(&mut self, b: &Batch<T>) {
        for id in Self::ids(b) {
            self.in_flight.remove(id);
        }
    }
    pub fn commit_batch(&mut self, b: &Batch<T>) {
        self.release_batch(b);
        self.ack(b);
    }
    pub fn unshift_batch(&mut self, b: &Batch<T>) -> io::Result<()> {
        for item in b.items.iter().rev() {
            self.enqueue(
                if b.isolated {
                    Placement::UnshiftIsolated
                } else {
                    Placement::Unshift
                },
                item.message.clone(),
                b.mode.clone(),
                item.local_id.clone(),
                item.internal.clone(),
            )?
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;
    use proptest::{prelude::*, test_runner::RngSeed};
    use serde_json::{json, Value};
    #[test]
    fn matches_ts_reservation_vectors() {
        let output = std::process::Command::new("bun")
            .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../cli"))
            .args(["-e", r#"import { mock } from 'bun:test'
mock.module('@/ui/logger', () => ({ logger: { debug() {} } }))
const { MessageQueue2 } = await import('./src/utils/MessageQueue2')
const queue = new MessageQueue2<number>(String)
const held = new Map()
let seed = 126
const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 12
const rows = []
for (let n = 0; n < 2048; n++) {
    const op = next() % 13, id = String(next() % 5), mode = next() % 2
    let result = null
    switch (op) {
        case 0: queue.push(id, mode, id); break
        case 1: queue.pushImmediate(id, mode, id); break
        case 2: queue.unshift(id, mode, id); break
        case 3: queue.pushIsolated(id, mode, id); break
        case 4: queue.pushIsolateAndClear(id, mode, id); break
        case 5: {
            const r = queue.takeByLocalId(id)
            if (r) held.set(id, r)
            result = !!r
            break
        }
        case 6: result = held.has(id) && queue.beginReservationDispatch(held.get(id)); break
        case 7: result = held.has(id) && queue.markReservationIndeterminate(held.get(id)); break
        case 8: result = held.has(id) && queue.restoreReservation(held.get(id)); break
        case 9: result = held.has(id) && queue.commitReservation(held.get(id)); break
        case 10: result = queue.cancelByLocalId(id); break
        case 11: result = queue.size() ? (await queue.waitForMessagesAndGetAsString())!.message : null; break
        case 12: queue.reset({preserveDispatchingReservations: !!mode}); break
    }
    rows.push([op,id,mode,result,queue.pendingLocalIds()])
}
console.log(JSON.stringify(rows))
"#])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut q = MessageQueue2::new(u64::to_string);
        let mut handles = HashMap::new();
        for row in serde_json::from_slice::<Vec<Value>>(&output.stdout).unwrap() {
            let op = row[0].as_u64().unwrap();
            let id = row[1].as_str().unwrap();
            let mode = row[2].as_u64().unwrap();
            let actual = match op {
                0..=4 => {
                    let p = [
                        Placement::Push,
                        Placement::Immediate,
                        Placement::Unshift,
                        Placement::Isolated,
                        Placement::IsolateAndClear,
                    ][op as usize];
                    q.enqueue(p, id.into(), mode, Some(id.into()), None)
                        .unwrap();
                    Value::Null
                }
                5 => {
                    let r = q.take_by_local_id(id);
                    let found = r.is_some();
                    if let Some(r) = r {
                        handles.insert(id.to_owned(), r);
                    }
                    json!(found)
                }
                6..=9 => json!(handles.get(id).is_some_and(|r| match op {
                    6 => q.begin_dispatch(r),
                    7 => q.mark_indeterminate(r),
                    8 => q.restore(r),
                    _ => q.commit(r),
                })),
                10 => match q.cancel_by_local_id(id) {
                    Cancellation::Missing => json!(false),
                    Cancellation::Consumed => json!("consumed"),
                    Cancellation::InFlight => json!("in-flight"),
                    Cancellation::Removed => json!(true),
                    _ => unreachable!(),
                },
                11 => json!(q.collect(false).unwrap().map(|b| b.message)),
                _ => {
                    q.reset(mode != 0);
                    Value::Null
                }
            };
            assert_eq!(actual, row[3], "{row}");
            assert_eq!(json!(q.pending_local_ids()), row[4]);
        }
    }
    #[tokio::test]
    async fn aborted_wake_preserves_isolated_control_and_ack() {
        let q = Mutex::new(MessageQueue2::new(u8::to_string));
        let (abort, rx) = AbortController::channel();
        let mut wait = Box::pin(MessageQueue2::wait(&q, rx, false));
        assert!(wait.as_mut().now_or_never().is_none());
        q.lock()
            .unwrap()
            .enqueue(
                Placement::Isolated,
                "control".into(),
                1,
                None,
                Some(Internal::Control),
            )
            .unwrap();
        abort.abort();
        assert!(wait.await.unwrap().is_none());
        let mut q = q.lock().unwrap();
        assert!(!q.has_pending_non_bridge_turn());
        let b = q.collect(false).unwrap().unwrap();
        assert_eq!(b.items[0].internal, Some(Internal::Control));
        q.unshift_batch(&b).unwrap();
        assert!(q.collect(false).unwrap().unwrap().isolated);
    }
    #[tokio::test]
    async fn close_wakes_and_rejects_push() {
        let q = Mutex::new(MessageQueue2::new(u8::to_string));
        let (_tx, rx) = AbortController::channel();
        let mut w = Box::pin(MessageQueue2::wait(&q, rx, false));
        assert!(w.as_mut().now_or_never().is_none());
        q.lock().unwrap().close();
        assert!(w.await.unwrap().is_none());
        assert!(q
            .lock()
            .unwrap()
            .enqueue(Placement::Push, String::new(), 0, None, None)
            .is_err());
    }
    #[test]
    fn deferred_ack_and_requeue() {
        let mut q = MessageQueue2::new(u8::to_string);
        let ack = Arc::new(Mutex::new(Vec::new()));
        let sink = ack.clone();
        q.on_batch_consumed = Some(Box::new(move |ids| {
            sink.lock().unwrap().extend_from_slice(ids)
        }));
        for id in ["a", "b"] {
            q.enqueue(Placement::Push, id.into(), 0, Some(id.into()), None)
                .unwrap();
        }
        let b = q.collect(true).unwrap().unwrap();
        for _ in 0..2 {
            assert!(q.cancel_by_local_id("a") == Cancellation::InFlight)
        }
        q.unshift_batch(&b).unwrap();
        assert_eq!(q.pending_local_ids(), ["a", "b"]);
        let b = q.collect(true).unwrap().unwrap();
        q.release_batch(&b);
        assert!(q.cancel_by_local_id("a") == Cancellation::Missing);
        assert!(ack.lock().unwrap().is_empty());
        q.begin_batch(&b);
        q.commit_batch(&b);
        assert_eq!(*ack.lock().unwrap(), ["a", "b"]);
    }
    #[test]
    fn equivalent_modes_and_explicit_resets() {
        let mut q = MessageQueue2::new(|v: &Value| {
            let mut v = v.clone();
            v.sort_all_objects();
            crate::jsjson::stringify(&v)
        });
        let base = json!({"permissionMode":"default"});
        let modes = [
            json!({"model":"sonnet","permissionMode":"default"}),
            json!({"permissionMode":"default","model":"sonnet"}),
            base.clone(),
            json!({"fallbackModel":"opus"}),
            json!({"customSystemPrompt":"help"}),
            base.clone(),
            json!({"appendSystemPrompt":"short"}),
            json!({"allowedTools":["Read","Write"]}),
            base.clone(),
            json!({"disallowedTools":["Bash"]}),
            base,
        ];
        for (n, m) in modes.iter().enumerate() {
            q.enqueue(Placement::Push, n.to_string(), m.clone(), None, None)
                .unwrap();
        }
        let first = q.collect(false).unwrap().unwrap();
        assert_eq!(first.mode, modes[0]);
        assert_eq!(first.message, "0\n1");
        for (n, m) in modes.iter().enumerate().skip(2) {
            let b = q.collect(false).unwrap().unwrap();
            assert_eq!(b.message, n.to_string());
            assert_eq!(&b.mode, m);
        }
        assert!(q.collect(false).unwrap().is_none());
    }

    #[test]
    fn synthetic_bridge_cannot_ack_forged_id() {
        let mut q = MessageQueue2::new(u8::to_string);
        let received = Arc::new(Mutex::new(Vec::new()));
        let ack = received.clone();
        q.on_batch_consumed = Some(Box::new(move |ids| {
            ack.lock().unwrap().extend_from_slice(ids)
        }));
        q.enqueue(
            Placement::UnshiftIsolated,
            "bridge retry".into(),
            1,
            None,
            Some(Internal::ModelErrorBridge("event".into())),
        )
        .unwrap();
        q.enqueue(
            Placement::Push,
            "real prompt".into(),
            1,
            Some("bridge:event".into()),
            None,
        )
        .unwrap();
        assert_eq!(q.collect(false).unwrap().unwrap().message, "bridge retry");
        assert!(received.lock().unwrap().is_empty());
        let r = q.take_by_local_id("bridge:event").unwrap();
        assert!(q.has_pending_non_bridge_turn());
        assert!(q.begin_dispatch(&r));
        assert!(q.restore(&r));
        q.collect(false).unwrap();
        assert_eq!(*received.lock().unwrap(), ["bridge:event"]);
        assert!(!q.has_pending_non_bridge_turn());
    }

    #[tokio::test]
    async fn pending_and_woken_waits_abort_without_ack() {
        for pending in [true, false] {
            let q = Mutex::new(MessageQueue2::new(u8::to_string));
            let (controller, rx) = AbortController::channel();
            let mut wait = Box::pin(MessageQueue2::wait(&q, rx.clone(), false));
            if !pending {
                assert!(wait.as_mut().now_or_never().is_none());
            }
            controller.abort();
            q.lock()
                .unwrap()
                .enqueue(Placement::Push, "turn".into(), 1, Some("a".into()), None)
                .unwrap();
            assert!(wait.await.unwrap().is_none());
            assert_eq!(q.lock().unwrap().pending_local_ids(), ["a"]);
            let (_next, rx) = AbortController::channel();
            assert_eq!(
                MessageQueue2::wait(&q, rx, false)
                    .await
                    .unwrap()
                    .unwrap()
                    .message,
                "turn"
            );
        }
    }

    #[tokio::test]
    async fn new_turn_cannot_clear_previous_waiters_abort() {
        let q = Mutex::new(MessageQueue2::new(u8::to_string));
        let (controller, signal) = AbortController::channel();
        let mut old = Box::pin(MessageQueue2::wait(&q, signal, false));
        assert!(old.as_mut().now_or_never().is_none());
        controller.abort();
        let (_next_controller, next_signal) = AbortController::channel();
        let mut next = Box::pin(MessageQueue2::wait(&q, next_signal, false));
        assert!(next.as_mut().now_or_never().is_none());
        q.lock()
            .unwrap()
            .enqueue(Placement::Push, "next".into(), 1, Some("id".into()), None)
            .unwrap();
        assert!(old.await.unwrap().is_none());
        assert_eq!(q.lock().unwrap().pending_local_ids(), ["id"]);
        assert_eq!(next.await.unwrap().unwrap().message, "next");
    }

    #[test]
    fn ambiguous_retries_and_late_commit_after_reset() {
        let mut q = MessageQueue2::new(u8::to_string);
        q.enqueue(Placement::Push, "turn".into(), 0, Some("a".into()), None)
            .unwrap();
        let r = q.take_by_local_id("a").unwrap();
        assert!(q.begin_dispatch(&r));
        q.reset(true);
        assert!(q.mark_indeterminate(&r));
        let retry = q.take_by_local_id("a").unwrap();
        assert!(!q.commit(&r));
        assert!(q.begin_dispatch(&retry));
        assert!(q.restore(&retry));
        assert_eq!(q.size(), 0);
        q.reset(false);
        assert!(!q.restore(&retry));
        assert!(q.commit(&retry));
        assert!(q.cancel_by_local_id("a") == Cancellation::Consumed);
    }
    #[tokio::test]
    async fn empty_wait_wakes_for_each_arrival_and_closed_queue_drains() {
        let q = Mutex::new(MessageQueue2::new(u8::to_string));
        let (_controller, rx) = AbortController::channel();
        for placement in [
            Placement::Push,
            Placement::Immediate,
            Placement::Unshift,
            Placement::Isolated,
        ] {
            let mut wait = Box::pin(MessageQueue2::wait(&q, rx.clone(), true));
            assert!(wait.as_mut().now_or_never().is_none());
            q.lock()
                .unwrap()
                .enqueue(placement, "one".into(), 2, Some("id".into()), None)
                .unwrap();
            let b = wait.await.unwrap().unwrap();
            assert_eq!(b.message, "one");
            assert_eq!(b.isolated, placement == Placement::Isolated);
            let mut q = q.lock().unwrap();
            assert!(q.cancel_by_local_id("id") == Cancellation::InFlight);
            q.reset(false);
            assert!(q.cancel_by_local_id("id") == Cancellation::Missing);
        }
        let mut q = q.lock().unwrap();
        q.enqueue(Placement::Push, "last".into(), 0, None, None)
            .unwrap();
        q.close();
        assert_eq!(q.collect(false).unwrap().unwrap().message, "last");
        assert!(q.is_closed());
    }

    #[test]
    fn restore_uses_surviving_neighbors_for_overlapping_reservations() {
        for reverse in [true, false] {
            let mut q = MessageQueue2::new(u8::to_string);
            for id in ["a", "b", "c", "d"] {
                q.enqueue(Placement::Push, id.into(), 0, Some(id.into()), None)
                    .unwrap();
            }
            let b = q.take_by_local_id("b").unwrap();
            let c = q.take_by_local_id("c").unwrap();
            assert!(q.cancel_by_local_id("a") == Cancellation::Removed);
            for r in if reverse { [&c, &b] } else { [&b, &c] } {
                assert!(q.restore(r));
            }
            assert_eq!(q.pending_local_ids(), ["b", "c", "d"]);
        }
    }

    #[test]
    fn cancel_only_removes_first_matching_nonempty_id() {
        let mut q = MessageQueue2::new(u8::to_string);
        for (text, id) in [
            ("first", Some("dup")),
            ("anonymous", None),
            ("second", Some("dup")),
            ("blank", Some("")),
        ] {
            q.enqueue(Placement::Push, text.into(), 0, id.map(String::from), None)
                .unwrap();
        }
        assert!(q.cancel_by_local_id("") == Cancellation::Missing);
        assert!(q.cancel_by_local_id("unknown") == Cancellation::Missing);
        assert!(q.cancel_by_local_id("dup") == Cancellation::Removed);
        assert_eq!(q.peek_by_local_id("dup").unwrap().message, "second");
        assert_eq!(
            q.collect(false).unwrap().unwrap().message,
            "anonymous\nsecond\nblank"
        );
    }
    #[tokio::test]
    async fn detached_abort_and_displaced_waiters() {
        let q = Mutex::new(MessageQueue2::new(u8::to_string));
        let (abort, signal) = AbortController::channel();
        let mut old = Box::pin(MessageQueue2::wait(&q, signal.clone(), false));
        assert!(old.as_mut().now_or_never().is_none());
        q.lock().unwrap().reset(true);
        assert!(old.as_mut().now_or_never().is_none());
        let mut replaced = Box::pin(MessageQueue2::wait(&q, signal, false));
        assert!(replaced.as_mut().now_or_never().is_none());
        let mut current = Box::pin(MessageQueue2::wait(&q, AbortController::channel().1, false));
        assert!(current.as_mut().now_or_never().is_none());
        assert!(replaced.as_mut().now_or_never().is_none());
        q.lock()
            .unwrap()
            .enqueue(Placement::Push, "x".into(), 1, None, None)
            .unwrap();
        assert_eq!(current.await.unwrap().unwrap().message, "x");
        abort.abort();
        assert!(old.await.unwrap().is_none());
        assert!(replaced.await.unwrap().is_none());
    }
    #[tokio::test]
    async fn reset_finishes_wait_without_an_abort_sender() {
        let q = Mutex::new(MessageQueue2::new(u8::to_string));
        let mut wait = Box::pin(MessageQueue2::wait(&q, AbortController::channel().1, false));
        assert!(wait.as_mut().now_or_never().is_none());
        q.lock().unwrap().reset(false);
        assert!(wait.now_or_never().unwrap().unwrap().is_none());
    }

    #[tokio::test]
    async fn cancellation_while_waiter_reacquires_lock_preserves_batch() {
        let q = Mutex::new(MessageQueue2::new(u8::to_string));
        q.lock().unwrap().on_batch_consumed = Some(Box::new(|_| panic!("cancelled batch ACK")));
        let (abort, signal) = AbortController::channel();
        let mut wait = Box::pin(MessageQueue2::wait(&q, signal, false));
        assert!(wait.as_mut().now_or_never().is_none());
        std::thread::scope(|scope| {
            let mut guard = q.lock().unwrap();
            guard
                .enqueue(Placement::Push, "one".into(), 1, Some("id".into()), None)
                .unwrap();
            let (started, polling) = std::sync::mpsc::sync_channel(0);
            let waiting = scope.spawn(move || {
                started.send(()).unwrap();
                wait.now_or_never().unwrap().unwrap()
            });
            polling.recv().unwrap();
            abort.abort();
            drop(guard);
            assert!(waiting.join().unwrap().is_none());
        });
        assert_eq!(q.lock().unwrap().pending_local_ids(), ["id"]);
    }

    #[test]
    fn admission_filters_and_reservation_release() {
        let mut q = MessageQueue2::new(u8::to_string);
        for id in ["held", "filter", "bridge", "keep"] {
            q.enqueue(
                Placement::Push,
                id.into(),
                1,
                Some(id.into()),
                (id == "bridge").then(|| Internal::ModelErrorBridge("e".into())),
            )
            .unwrap();
        }
        q.before_dequeue = Some(Box::new(|| Err(io::Error::other("busy"))));
        assert!(q.collect(false).is_err());
        assert_eq!(q.size(), 4);
        let r = q.take_by_local_id("held").unwrap();
        assert!(!q.release_indeterminate("held"));
        assert!(q.begin_dispatch(&r));
        assert!(q.mark_indeterminate(&r));
        assert!(q.release_indeterminate("held"));
        assert!(!q.commit(&r));
        assert_eq!(q.remove_items_matching(|i| i.message == "filter"), 1);
        assert!(q.cancel_model_error_bridge("e"));
        assert_eq!(q.pending_local_ids(), ["keep"]);
        q.close();
        let r = q.take_by_local_id("keep").unwrap();
        assert!(!q.restore(&r));
    }
    #[test]
    fn closed_restore_preserves_reserved_and_ambiguous_retry() {
        let mut q = MessageQueue2::new(u8::to_string);
        for id in ["clear", "retry"] {
            q.enqueue(Placement::Push, id.into(), 1, Some(id.into()), None)
                .unwrap();
        }
        q.close();
        let r = q.take_by_local_id("clear").unwrap();
        assert!(!q.restore(&r));
        assert!(q.commit(&r));
        assert!(q.cancel_by_local_id("clear") == Cancellation::Consumed);
        let first = q.take_by_local_id("retry").unwrap();
        assert!(!q.is_ambiguous(&first));
        assert!(!q.is_dispatching(&first));
        assert!(q.begin_dispatch(&first));
        assert!(q.is_dispatching(&first));
        assert!(q.mark_indeterminate(&first));
        let retry = q.take_by_local_id("retry").unwrap();
        assert!(q.is_ambiguous(&retry));
        assert!(q.begin_dispatch(&retry));
        assert!(q.restore(&retry));
        assert!(q.is_ambiguous(&retry));
        assert!(!q.is_dispatching(&retry));
        assert!(q.release_indeterminate("retry"));
        assert!(q.is_ambiguous(&retry));
        assert!(!q.is_dispatching(&retry));
        assert!(!q.has_pending_non_bridge_turn());
    }
    fn check_conservation_and_fifo(ops: Vec<(u8, bool, usize)>) -> Result<(), TestCaseError> {
        let mut q = MessageQueue2::new(bool::to_string);
        let mut live = HashSet::new();
        let mut held = Vec::new();
        for (n, (op, mode, k)) in ops.into_iter().enumerate() {
            let id = n.to_string();
            match op {
                0..=3 => {
                    let p = [
                        Placement::Push,
                        Placement::Unshift,
                        Placement::Isolated,
                        Placement::IsolateAndClear,
                    ][op as usize];
                    if op == 3 {
                        live.clear();
                        held.clear()
                    }
                    q.enqueue(p, id.clone(), mode, Some(id.clone()), None)
                        .unwrap();
                    live.insert(id);
                }
                4 | 5 if !q.items.is_empty() => {
                    let id = q.items[k % q.size()].local_id.clone().unwrap();
                    if op == 4 {
                        held.push(q.take_by_local_id(&id).unwrap())
                    } else {
                        prop_assert!(q.cancel_by_local_id(&id) == Cancellation::Removed);
                        live.remove(&id);
                    }
                }
                6..=8 if !held.is_empty() => {
                    let i = k % held.len();
                    let r = held.swap_remove(i);
                    if op == 6 {
                        prop_assert!(q.restore(&r));
                    } else if op == 7 {
                        prop_assert!(q.commit(&r));
                        live.remove(r.item.local_id.as_ref().unwrap());
                    } else {
                        prop_assert!(q.begin_dispatch(&r));
                        prop_assert!(q.mark_indeterminate(&r));
                    }
                }
                _ => {
                    if let Some(b) = q.collect(false).unwrap() {
                        prop_assert!(!b.isolated || b.items.len() == 1);
                        prop_assert!(b.items.windows(2).all(|w| w[0].order < w[1].order));
                        for i in b.items {
                            prop_assert_eq!(i.mode, b.mode);
                            prop_assert!(live.remove(i.local_id.as_ref().unwrap()));
                        }
                    }
                }
            }
            let remaining = q
                .pending_local_ids()
                .into_iter()
                .chain(q.held.keys().cloned())
                .collect::<HashSet<_>>();
            prop_assert_eq!(&live, &remaining);
        }
        Ok(())
    }
    proptest! {#![proptest_config(ProptestConfig{rng_seed:RngSeed::Fixed(126),..Default::default()})]
    #[test] fn conservation_and_fifo(ops in prop::collection::vec((0u8..10,any::<bool>(),any::<usize>()),1..150)) {check_conservation_and_fifo(ops)?;}
    }
    #[derive(Clone)]
    struct ModelRow {
        id: String,
        mode: bool,
        isolated: bool,
        taken: bool,
    }

    proptest! {
        #[test]
        fn queue_matches_ordered_model(
            operations in prop::collection::vec((0u8..11, any::<bool>(), any::<usize>()), 1..150)
        ) {
            let mut queue = MessageQueue2::new(bool::to_string);
            let mut rows: Vec<ModelRow> = Vec::new();
            let mut active = HashMap::new();
            let mut stale = Vec::new();
            let mut delivered = HashSet::new();
            let mut deferred: Option<(Batch<bool>, Vec<ModelRow>)> = None;

            for (n, (operation, mode, index)) in operations.into_iter().enumerate() {
                match operation {
                    0..=3 => {
                        let placement = [Placement::Push, Placement::Immediate, Placement::Isolated,
                            Placement::Unshift][operation as usize];
                        let id = n.to_string();
                        queue.enqueue(placement, id.clone(), mode, Some(id.clone()), None).unwrap();
                        let row = ModelRow { id, mode, isolated: placement == Placement::Isolated, taken: false };
                        if placement == Placement::Unshift {
                            rows.insert(0, row);
                        } else {
                            rows.push(row);
                        }
                    }
                    4..=6 if !rows.is_empty() => {
                        let i = index % rows.len();
                        let row = &mut rows[i];
                        if !row.taken {
                            let handle = queue.take_by_local_id(&row.id).unwrap();
                            active.insert(row.id.clone(), handle);
                            row.taken = true;
                        } else {
                            let handle = active.remove(&row.id).unwrap();
                            if operation == 4 {
                                prop_assert!(queue.restore(&handle));
                                row.taken = false;
                            } else {
                                if operation == 5 {
                                    prop_assert!(queue.commit(&handle));
                                    prop_assert!(delivered.insert(row.id.clone()));
                                } else {
                                    prop_assert!(queue.cancel_by_local_id(&row.id) == Cancellation::Removed);
                                }
                                rows.remove(i);
                            }
                            stale.push(handle);
                        }
                    }
                    7 if !stale.is_empty() => {
                        let handle = &stale[index % stale.len()];
                        prop_assert!(!queue.commit(handle));
                        prop_assert!(!queue.restore(handle));
                    }
                    8 | 9 if deferred.is_some() => {
                        let (batch, mut batch_rows) = deferred.take().unwrap();
                        if operation == 8 {
                            queue.unshift_batch(&batch).unwrap();
                            batch_rows.append(&mut rows);
                            rows = batch_rows;
                        } else {
                            queue.commit_batch(&batch);
                            for row in batch_rows {
                                prop_assert!(delivered.insert(row.id));
                            }
                        }
                    }
                    _ if deferred.is_none() => {
                        let batch = queue.collect(true).unwrap();
                        let mut pending = rows.iter().filter(|r| !r.taken);
                        if let Some(head) = pending.next() {
                            let mut expected = vec![head.clone()];
                            if !head.isolated {
                                expected.extend(pending.take_while(|r| !r.isolated && r.mode == head.mode).cloned());
                            }
                            let batch = batch.unwrap();
                            let ids: Vec<_> = batch.items.iter().map(|r| r.local_id.as_ref().unwrap()).collect();
                            prop_assert_eq!(ids, expected.iter().map(|r| &r.id).collect::<Vec<_>>());
                            rows.retain(|r| !expected.iter().any(|item| item.id == r.id));
                            deferred = Some((batch, expected));
                        } else {
                            prop_assert!(batch.is_none());
                        }
                    }
                    _ => {}
                }
                let pending: Vec<_> = rows.iter().filter(|r| !r.taken).collect();
                prop_assert_eq!(queue.peek_next_batch_mode(), pending.first().map(|r| (&r.mode, r.isolated)));
                prop_assert_eq!(queue.pending_local_ids(), pending.iter().map(|r| r.id.clone()).collect::<Vec<_>>());
            }
        }
    }
}
