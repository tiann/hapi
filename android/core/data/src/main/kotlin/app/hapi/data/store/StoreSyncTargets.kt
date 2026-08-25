package app.hapi.data.store

import app.hapi.data.sse.SseSubscriptionKey
import app.hapi.data.sse.SyncTargets
import app.hapi.protocol.wire.SyncEvent
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/**
 * Wires `SyncEventRouter` to the stores, mirroring the scope rules of
 * `web/src/hooks/useSSE.ts`:
 *
 * - session lifecycle events → [SessionListStore.applySessionEvent]; a
 *   `session-removed` additionally clears that session's message window;
 * - `machine-updated` → [MachineListStore.applyMachineEvent];
 * - global-scope message-stream events refresh the session list where the web
 *   invalidates it (`messages-invalidated`, `messages-consumed`,
 *   `message-cancelled`, `scheduled-matured`, and a `message-received`
 *   carrying `scheduledAt` — they all move the hub-computed scheduled/queued
 *   fields the client cannot derive);
 * - message-stream events also reach an **open** [MessageWindowStore]
 *   ([messageWindows], the M2c half): the session pipe ingests everything;
 *   the global pipe performs only queued/optimistic bookkeeping
 *   (`messages-consumed` / `message-cancelled`) — per the web reference it
 *   never ingests `message-received` nor clears the window;
 * - a `gap` handshake verdict triggers the full REST resync, plus — on a
 *   session-scoped pipe — that window's catch-up tail sync.
 *
 * Window deliveries are funneled through an unbounded [Channel] consumed by a
 * single coroutine, so bookkeeping applies in SSE arrival order even though
 * the store calls suspend.
 */
class StoreSyncTargets(
    private val sessions: SessionListStore,
    private val machines: MachineListStore,
    private val scope: CoroutineScope,
    private val messageWindows: MessageWindowStores? = null,
    private val onToastEvent: (SyncEvent.Toast) -> Unit = {},
    /** Handshake hook (subscription id per pipe) — feeds visibility reporting. */
    private val onHandshakeEvent: (SseSubscriptionKey, String?) -> Unit = { _, _ -> },
) : SyncTargets {

    private val windowEvents: Channel<Pair<SseSubscriptionKey, SyncEvent>>? =
        if (messageWindows == null) null else Channel(Channel.UNLIMITED)

    init {
        val channel = windowEvents
        val windows = messageWindows
        if (channel != null && windows != null) {
            scope.launch {
                for ((eventScope, event) in channel) {
                    try {
                        deliverToWindow(windows, eventScope, event)
                    } catch (cancellation: CancellationException) {
                        throw cancellation
                    } catch (_: Exception) {
                        // A failed tail sync inside onMessageEvent surfaces as
                        // the window's own warning state; keep consuming.
                    }
                }
            }
        }
    }

    override fun onSessionEvent(scope: SseSubscriptionKey, event: SyncEvent) {
        sessions.applySessionEvent(scope, event)
        if (event is SyncEvent.SessionRemoved) {
            windowEvents?.trySend(scope to event)
        }
    }

    override fun onMachineEvent(scope: SseSubscriptionKey, event: SyncEvent.MachineUpdated) {
        machines.applyMachineEvent(event)
    }

    override fun onMessageEvent(scope: SseSubscriptionKey, event: SyncEvent) {
        windowEvents?.trySend(scope to event)

        // Session-list bookkeeping is a global-pipe concern only.
        if (scope !is SseSubscriptionKey.Global) return
        when (event) {
            is SyncEvent.MessagesInvalidated,
            is SyncEvent.MessagesConsumed,
            is SyncEvent.MessagesIndeterminate,
            is SyncEvent.MessagesRequeued,
            is SyncEvent.MessageCancelled,
            is SyncEvent.ScheduledMatured,
            -> sessions.scheduleRefresh()

            is SyncEvent.MessageReceived -> {
                if (event.message.scheduledAt != null) sessions.scheduleRefresh()
            }

            else -> Unit
        }
    }

    override fun onToast(event: SyncEvent.Toast) {
        onToastEvent(event)
    }

    override fun onHandshake(scope: SseSubscriptionKey, subscriptionId: String?) {
        onHandshakeEvent(scope, subscriptionId)
    }

    override fun requestFullResync(scope: SseSubscriptionKey) {
        this.scope.launch {
            try {
                sessions.fullResync()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                // Offline: snapshot state stays; the next reconnect retries.
            }
            try {
                machines.refresh()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
            }
            // A session-pipe gap means that window's replay is unproven:
            // catch up past any in-flight sync (web `resyncMessages`) AND
            // reconcile queued optimistic sends against the hub verdict
            // (web `queued-state-reconciliation` — the drain includes the
            // ensureAfterCurrent tail sync).
            if (scope is SseSubscriptionKey.Session) {
                val store = messageWindows?.peek(scope.sessionId) ?: return@launch
                try {
                    store.reconcileQueuedState()
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (_: Exception) {
                    // Failure lands in the window's warning state.
                }
            }
        }
    }

    private suspend fun deliverToWindow(
        windows: MessageWindowStores,
        eventScope: SseSubscriptionKey,
        event: SyncEvent,
    ) {
        val sessionId = event.sessionIdOrNull() ?: return
        if (event is SyncEvent.SessionRemoved) {
            // Web `clearMessageWindow(sessionId)` — whichever pipe delivered it.
            windows.clear(sessionId)
            return
        }
        // peek, never open: only a window someone already opened (chat screen /
        // snapshot-backed) tracks live events — mirroring the web, where these
        // handlers write into existing per-session store state.
        val store = windows.peek(sessionId) ?: return
        when (eventScope) {
            is SseSubscriptionKey.Session -> store.onMessageEvent(event)
            is SseSubscriptionKey.Global -> when (event) {
                // Global pipe: queued/optimistic bookkeeping only (see class doc).
                is SyncEvent.MessagesConsumed -> store.markConsumed(event.localIds, event.invokedAt)
                is SyncEvent.MessagesIndeterminate -> store.markIndeterminate(event.localIds)
                is SyncEvent.MessagesRequeued -> store.markRequeued(event.localIds)
                is SyncEvent.MessageCancelled -> store.removeMessage(event.messageId)
                else -> Unit
            }
        }
    }

    private fun SyncEvent.sessionIdOrNull(): String? = when (this) {
        is SyncEvent.MessageReceived -> sessionId
        is SyncEvent.MessagesConsumed -> sessionId
        is SyncEvent.MessagesIndeterminate -> sessionId
        is SyncEvent.MessagesRequeued -> sessionId
        is SyncEvent.MessageCancelled -> sessionId
        is SyncEvent.MessagesInvalidated -> sessionId
        is SyncEvent.ScheduledMatured -> sessionId
        is SyncEvent.SessionRemoved -> sessionId
        else -> null
    }
}
