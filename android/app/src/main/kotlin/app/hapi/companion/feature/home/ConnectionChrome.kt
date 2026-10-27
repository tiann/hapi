package app.hapi.companion.feature.home

import app.hapi.data.sse.ConnectionFailure
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.transformLatest

/**
 * What the global connection banner should show right now — the Android twin
 * of the web reference's banner stack (`web/src/App.tsx`: `SyncingBanner`
 * above `ReconnectingBanner`).
 *
 * Syncing wins while a full resync is in flight (web:
 * `showReconnectingBanner = sseDisconnected && !isSyncing`); otherwise a
 * reconnecting notice appears once the outage has outlived the 4 s grace
 * (`reconnectNoticeFailure` — the flow [ConnectionChrome] consumes), carrying
 * the attributed failure for the reason label (`ReconnectingBanner.tsx`).
 */
sealed interface GlobalConnectionNotice {
    /** Reconnecting after a failure; [failure] labels the reason when known. */
    data class Reconnecting(val failure: ConnectionFailure?) : GlobalConnectionNotice

    /** A gap-triggered full resync is in flight (web `useSyncingState`). */
    data object Syncing : GlobalConnectionNotice
}

/** One resync "episode": depth-counted, timer-restarted on every new start. */
private data class SyncActivity(
    val active: Boolean = false,
    val startedAtMs: Long = 0L,
)

/**
 * Home-screen connection chrome: folds the global pipe's attributed-failure
 * notice and the resync lifecycle into the single [notice] the banner renders.
 *
 * The reconnecting half is fed by the engine's
 * `SseEngine.connectionFailureNotice(SseSubscriptionKey.Global)` (grace +
 * failure attribution computed on the engine's own clock); the syncing half is
 * fed synchronously through [onResyncEvent] — wired via
 * [app.hapi.data.store.StoreSyncTargets]'s `onResyncEvent` hook — so no event
 * can be missed between construction and the first collector.
 *
 * Timing contract (web `useSyncingState`): a syncing banner only shows if the
 * sync outlives a 300 ms debounce, auto-clears after 10 s (stuck-spinner
 * guard), and hides the moment the last resync finishes.
 */
class ConnectionChrome(
    globalFailureNotice: Flow<ConnectionFailure?>,
    scope: CoroutineScope,
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
    private val syncActivity = MutableStateFlow(SyncActivity())
    private var resyncDepth = 0

    /**
     * Resync lifecycle input (true = a full resync started, false = finished).
     * Depth-counted: overlapping resyncs keep one episode open; every start
     * restarts the debounce/max timers (web `doStartSync` clears and
     * reschedules on each call), an end with others still running does not.
     *
     * Declared divergence from the web's display policy: `useSyncingState`
     * only shows for the first connect's force resync and for resyncs started
     * within 30 s of returning from the background; here every resync episode
     * (each session pipe's first connect, foreground network flaps) opens a
     * debounced episode — a strictly more-eager surface, still bounded by the
     * 300 ms debounce and the 10 s cap.
     */
    fun onResyncEvent(active: Boolean) {
        synchronized(this) {
            resyncDepth = (resyncDepth + if (active) 1 else -1).coerceAtLeast(0)
            val current = syncActivity.value
            val next = when {
                resyncDepth == 0 -> SyncActivity()
                // A new start (or a start while open) restarts the timers.
                active -> SyncActivity(active = true, startedAtMs = nowMs())
                // An ending sync with others still running: keep the episode.
                else -> current
            }
            if (next != current) syncActivity.value = next
        }
    }

    /**
     * Last value this pipeline emitted downstream (volatile: the pre-restart
     * block reads it after transformLatest cancelled it).
     */
    @Volatile private var syncNoticeShown = false

    @OptIn(ExperimentalCoroutinesApi::class)
    private val syncingNotice: Flow<Boolean> =
        syncActivity.transformLatest { activity ->
                if (!activity.active) {
                    syncNoticeShown = false
                    emit(false)
                } else {
                    // A restart while the banner was already shown keeps it
                    // shown (web `doStartSync` reshuffles timers with
                    // isSyncing staying true — no blink); only a fresh
                    // episode debounces up from hidden.
                    if (!syncNoticeShown) emit(false)
                    delay(SYNC_DEBOUNCE_MS)
                    syncNoticeShown = true
                    emit(true)
                    delay(SYNC_MAX_DURATION_MS)
                    // Stuck-spinner guard: never show longer than the cap.
                    syncNoticeShown = false
                    emit(false)
                }
            }
            .distinctUntilChanged()

    @OptIn(ExperimentalCoroutinesApi::class)
    private val reconnectingNotice: Flow<GlobalConnectionNotice?> =
        globalFailureNotice.map { failure -> failure?.let { GlobalConnectionNotice.Reconnecting(it) } }

    /** The banner state; null = no banner. */
    val notice: StateFlow<GlobalConnectionNotice?> =
        combine(reconnectingNotice, syncingNotice) { reconnecting, syncing ->
                if (syncing) GlobalConnectionNotice.Syncing else reconnecting
            }
            .stateIn(scope, SharingStarted.Eagerly, null)

    private companion object {
        /** Web `DEBOUNCE_MS` — only show if the sync takes longer than this. */
        const val SYNC_DEBOUNCE_MS = 300L

        /** Web `MAX_SYNC_DURATION_MS` — auto-clear safety cap. */
        const val SYNC_MAX_DURATION_MS = 10_000L
    }
}
