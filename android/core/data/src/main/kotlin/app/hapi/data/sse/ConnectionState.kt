package app.hapi.data.sse

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.transformLatest

/**
 * Why an SSE attempt ended — the Android twin of the web reference's
 * reconnect reasons (`web/src/hooks/useSSE.ts`): each maps to a localized
 * label on the reconnecting banner (`ReconnectingBanner.tsx`).
 */
enum class DisconnectReason {
    /** No frame of any kind for 90 s while foregrounded (staleness watchdog). */
    HeartbeatTimeout,

    /** A background→foreground resume found a stale connection (45 s rule). */
    VisibilityRecovery,

    /** The handshake did not arrive within the 10 s connect deadline. */
    ConnectTimeout,

    /** The transport reported a failure — HTTP status rides in [ConnectionFailure.httpCode]. */
    TransportError,

    /** The stream ended without a failure (clean server EOF / socket close). */
    Closed,
}

/** The failure behind an outage: attributed reason + optional HTTP status. */
data class ConnectionFailure(
    val reason: DisconnectReason,
    val httpCode: Int? = null,
)

/** Transport state is separate from the ordered, cursor-bearing message stream. */
data class ConnectionState(
    val phase: Phase = Phase.Idle,
    val outageStartedAtMs: Long? = null,
    /**
     * The failure behind the current/last outage, for banner labeling.
     * Cleared on the next successful handshake; retained (invisible) while
     * [phase] is [Phase.Suspended].
     */
    val lastFailure: ConnectionFailure? = null,
) {
    enum class Phase { Idle, Connecting, Connected, Backoff, Suspended }
}

/** Route identity excludes metering/validation: a LAN hub need not reach the internet. */
data class NetworkRoute(
    val networkId: Long?,
    val interfaceName: String? = null,
    val routes: Set<String> = emptySet(),
    val addresses: Set<String> = emptySet(),
)

@OptIn(ExperimentalCoroutinesApi::class)
fun Flow<ConnectionState>.reconnectNotice(nowMs: () -> Long): Flow<Boolean> = transformLatest { state ->
    val start = state.outageStartedAtMs
    if (start == null) {
        emit(false)
    } else {
        val remaining = start + 4_000 - nowMs()
        if (remaining > 0) {
            emit(false)
            delay(remaining)
        }
        emit(true)
    }
}.distinctUntilChanged()

/**
 * The [reconnectNotice] grace applied to the attributed failure: null until
 * the outage has spanned the 4 s grace (or once recovered), then the current
 * [ConnectionState.lastFailure] so a banner can label the reason. A suspended
 * (backgrounded) pipe is always hidden — its banner host is invisible.
 */
@OptIn(ExperimentalCoroutinesApi::class)
fun Flow<ConnectionState>.reconnectNoticeFailure(nowMs: () -> Long): Flow<ConnectionFailure?> =
    transformLatest { state ->
        val start = state.outageStartedAtMs
        if (start == null || state.phase == ConnectionState.Phase.Suspended) {
            emit(null)
        } else {
            val remaining = start + 4_000 - nowMs()
            if (remaining > 0) {
                emit(null)
                delay(remaining)
            }
            emit(state.lastFailure)
        }
    }.distinctUntilChanged()
