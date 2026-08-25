package app.hapi.data.sse

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.onSubscription
import kotlinx.coroutines.launch

/**
 * Hub-lifetime owner of the **global** SSE subscription (B-M3ab lifecycle
 * fix). Before M3 the session-list screen owned this pipe, so navigating into
 * a chat tore it down and queued/consumed bookkeeping + list badges went
 * stale while a chat was open. `HubGraph` now [start]s one of these for its
 * whole lifetime; screens only ever add their session pipes on top
 * (`sse.md#dual-subscription-model`).
 */
class GlobalSsePipe(
    private val sseEngine: SseEngine,
    targets: SyncTargets,
    private val scope: CoroutineScope,
) {
    private val router = SyncEventRouter(targets)
    private var job: Job? = null

    /** Idempotent: collector registers before `subscribe` (zero-replay flow). */
    fun start() {
        if (job?.isActive == true) return
        val key = SseSubscriptionKey.Global
        job = scope.launch {
            sseEngine.events(key)
                .onSubscription { sseEngine.subscribe(key) }
                .collect { router.route(key, it) }
        }
    }

    /** Tears the pipe down (hub switch / tests); the engine keeps the cursor. */
    fun stop() {
        job?.cancel()
        job = null
        sseEngine.unsubscribe(SseSubscriptionKey.Global)
    }
}
