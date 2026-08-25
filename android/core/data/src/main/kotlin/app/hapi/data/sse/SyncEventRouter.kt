package app.hapi.data.sse

import app.hapi.protocol.wire.SyncEvent

/**
 * Where routed events land. M2 wires the real stores behind this; the router
 * itself stays free of store logic.
 *
 * Every callback receives the subscription [SseSubscriptionKey] the event
 * arrived on, because handling is scope-dependent (`sse.md#dual-subscription-model`):
 * the global pipe must keep queued/optimistic bookkeeping correct even for
 * message-stream events, while only the session pipe ingests them into the
 * open message window. The two pipes have no ordering relationship — targets
 * must gate versioned session patches with strictly-greater version checks
 * (`app.hapi.protocol.patch.SessionPatching`).
 */
interface SyncTargets {
    /** `session-added` / `session-updated` / `session-removed` / `session-ended`. */
    fun onSessionEvent(scope: SseSubscriptionKey, event: SyncEvent)

    /** `machine-updated` (full `Machine`, patch, `null` = removed, absent = refetch). */
    fun onMachineEvent(scope: SseSubscriptionKey, event: SyncEvent.MachineUpdated)

    /**
     * The message-stream family: `message-received`, `messages-consumed`,
     * `message-cancelled`, `scheduled-matured`, plus the structural
     * `messages-invalidated` (discard the window, fresh tail sync).
     */
    fun onMessageEvent(scope: SseSubscriptionKey, event: SyncEvent)

    /** `toast` — visibility-targeted in-app banner; never replayed, no id. */
    fun onToast(event: SyncEvent.Toast)

    /**
     * The handshake verdict was `gap` (or absent — older hubs): the hub could
     * not prove continuity for [scope]'s filter set. Full refetch: session
     * list, open session detail, message tail sync, queued-state reconcile.
     */
    fun requestFullResync(scope: SseSubscriptionKey)

    /**
     * Every `connection-changed {status: connected}` handshake, with the
     * hub-minted [subscriptionId] (changes on every reconnect) —
     * `POST /api/visibility` reporting hangs off this. Default no-op so
     * pre-M3 targets are unaffected.
     */
    fun onHandshake(scope: SseSubscriptionKey, subscriptionId: String?) {}
}

/**
 * Thin fan-out from [SseEngine]'s per-key stream to [SyncTargets]: maps the
 * 13-type `SyncEvent` union (`docs/api/client-contract/sse.md#syncevent-union-13-types`)
 * plus [SyncEvent.Unknown] (ignored — forward compatibility), and turns a
 * `resume: gap` handshake into [SyncTargets.requestFullResync]. `heartbeat` /
 * `connection-changed` are engine-internal (watchdog / handshake) and no-ops
 * here; they appear only for exhaustiveness.
 */
class SyncEventRouter(private val targets: SyncTargets) {

    fun route(scope: SseSubscriptionKey, event: EngineEvent) {
        when (event) {
            is EngineEvent.Handshake -> {
                targets.onHandshake(scope, event.subscriptionId)
                if (event.resume == EngineEvent.Resume.Gap) {
                    targets.requestFullResync(scope)
                }
            }
            is EngineEvent.Sync -> routeSync(scope, event.event)
        }
    }

    private fun routeSync(scope: SseSubscriptionKey, event: SyncEvent) {
        when (event) {
            is SyncEvent.SessionAdded,
            is SyncEvent.SessionUpdated,
            is SyncEvent.SessionRemoved,
            is SyncEvent.SessionEnded,
            -> targets.onSessionEvent(scope, event)

            is SyncEvent.MessageReceived,
            is SyncEvent.MessagesConsumed,
            is SyncEvent.MessagesIndeterminate,
            is SyncEvent.MessagesRequeued,
            is SyncEvent.MessageCancelled,
            is SyncEvent.ScheduledMatured,
            is SyncEvent.MessagesInvalidated,
            -> targets.onMessageEvent(scope, event)

            is SyncEvent.MachineUpdated -> targets.onMachineEvent(scope, event)

            is SyncEvent.Toast -> targets.onToast(event)

            is SyncEvent.Heartbeat,
            is SyncEvent.ConnectionChanged,
            is SyncEvent.Unknown,
            -> Unit
        }
    }
}
