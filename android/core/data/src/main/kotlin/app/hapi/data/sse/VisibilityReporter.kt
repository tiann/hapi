package app.hapi.data.sse

import app.hapi.data.api.ApiError
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * `POST /api/visibility` reporting (B-M3ab): tracks the hub-minted
 * subscription id of every live SSE pipe (fed by [onHandshake] via
 * `SyncTargets`) and reports foreground/background flips so the hub can
 * suppress redundant push notifications while the app is visibly connected.
 *
 * Connect-time visibility already rides the SSE URL (`SseEngine` includes
 * `visibility=visible|hidden`), so only *transitions after connect* need a
 * POST. A `404` means the subscription died server-side — the entry is
 * dropped (the reconnect handshake re-registers a fresh id).
 */
class VisibilityReporter(
    private val setVisibility: suspend (subscriptionId: String, visibility: String) -> Unit,
    private val scope: CoroutineScope,
) {
    private val mutex = Mutex()
    private val subscriptionIds = mutableMapOf<String, String>()
    @Volatile private var foreground = true

    /** Handshake hook (`SyncTargets.onHandshake`): remember [subscriptionId] per pipe. */
    fun onHandshake(key: SseSubscriptionKey, subscriptionId: String?) {
        if (subscriptionId == null) return
        scope.launch {
            mutex.withLock { subscriptionIds[key.key] = subscriptionId }
        }
    }

    /** Lifecycle input: report the flip to every tracked live subscription. */
    fun setForeground(isForeground: Boolean) {
        if (foreground == isForeground) return
        foreground = isForeground
        val visibility = if (isForeground) "visible" else "hidden"
        scope.launch {
            val snapshot = mutex.withLock { subscriptionIds.toMap() }
            for ((key, subscriptionId) in snapshot) {
                try {
                    setVisibility(subscriptionId, visibility)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: ApiError) {
                    if (error.status == 404) {
                        mutex.withLock {
                            if (subscriptionIds[key] == subscriptionId) subscriptionIds.remove(key)
                        }
                    }
                    // Other statuses: transient — the next flip retries.
                } catch (_: Exception) {
                    // Offline: nothing to do, the reconnect handshake re-syncs.
                }
            }
        }
    }
}
