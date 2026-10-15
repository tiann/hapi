package app.hapi.companion.wear.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class WearSessionRow(
    val id: String,
    val name: String,
    val active: Boolean,
    val thinking: Boolean,
    val pendingRequestKinds: List<String>,
    val backgroundTaskCount: Int,
    val updatedAt: Long,
)

data class WearMessageRow(val role: String, val text: String, val createdAt: Long)

sealed interface WearLoadState<out T> {
    data object Loading : WearLoadState<Nothing>
    data class Loaded<T>(val value: T, val truncated: Boolean = false) : WearLoadState<T>
    data class Error(val reason: String) : WearLoadState<Nothing>
}

/**
 * Single global in-process store: the watch is a one-window app, and both
 * the listener service and every Activity run in the same process (standard
 * Wear OS shape — see [dev.hapi.companion.wear.data.PhoneBridgeBus] in the
 * prior dogfood build for the same call). [WatchDataLayerListenerService]
 * writes; Compose screens read via [StateFlow].
 */
object WatchRepository {
    private val _sessions = MutableStateFlow<WearLoadState<List<WearSessionRow>>>(WearLoadState.Loading)
    val sessions: StateFlow<WearLoadState<List<WearSessionRow>>> = _sessions.asStateFlow()

    /** Keyed by sessionId — only the most recently requested transcript is kept. */
    private val _transcript = MutableStateFlow<Pair<String, WearLoadState<List<WearMessageRow>>>?>(null)
    val transcript: StateFlow<Pair<String, WearLoadState<List<WearMessageRow>>>?> = _transcript.asStateFlow()

    /** Most recent relayed push, for the notification-tap deep link / banner. */
    private val _lastNotify = MutableStateFlow<WearNotifyEvent?>(null)
    val lastNotify: StateFlow<WearNotifyEvent?> = _lastNotify.asStateFlow()

    private val _lastActionResult = MutableStateFlow<Pair<String, Boolean>?>(null)
    val lastActionResult: StateFlow<Pair<String, Boolean>?> = _lastActionResult.asStateFlow()

    fun onSessionsLoading() {
        _sessions.value = WearLoadState.Loading
    }

    fun onSessions(rows: List<WearSessionRow>, error: String?) {
        _sessions.value = if (error != null) WearLoadState.Error(error) else WearLoadState.Loaded(rows)
    }

    fun onMessagesLoading(sessionId: String) {
        _transcript.value = sessionId to WearLoadState.Loading
    }

    fun onMessages(sessionId: String, rows: List<WearMessageRow>, truncated: Boolean, error: String?) {
        _transcript.value = sessionId to if (error != null) {
            WearLoadState.Error(error)
        } else {
            WearLoadState.Loaded(rows, truncated)
        }
    }

    fun onNotify(event: WearNotifyEvent) {
        _lastNotify.value = event
    }

    fun onActionResult(sessionId: String, ok: Boolean) {
        _lastActionResult.value = sessionId to ok
    }
}

data class WearNotifyEvent(
    val sessionId: String,
    val sessionName: String?,
    val type: String,
    val title: String?,
    val body: String?,
    val requestId: String?,
    val severity: String?,
    val supportsActions: Boolean,
    val ts: Long,
)
