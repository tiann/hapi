package app.hapi.data.sse

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.transformLatest

/** Transport state is separate from the ordered, cursor-bearing message stream. */
data class ConnectionState(
    val phase: Phase = Phase.Idle,
    val outageStartedAtMs: Long? = null,
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
