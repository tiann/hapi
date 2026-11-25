package app.hapi.companion.feature.share

import app.hapi.companion.feature.sessions.formatReopenError
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

interface ShareSessionGateway {
    suspend fun isActive(sessionId: String): Boolean
    /** Includes history seeding and draft migration when the returned ID changes. */
    suspend fun reopen(sessionId: String): String
}

data class ShareTargetState(
    val busy: Boolean = false,
    val confirmSessionId: String? = null,
    val resolvedSessionId: String? = null,
    val failedSessionId: String? = null,
    val error: String? = null,
)

/** One instance per hub connection: switching hubs cancels its owning scope. */
class ShareTargetController(private val gateway: ShareSessionGateway, private val scope: CoroutineScope) {
    private val pending = AtomicBoolean(false)
    private val mutableState = MutableStateFlow(ShareTargetState())
    val state = mutableState.asStateFlow()

    fun select(sessionId: String, confirmReopen: Boolean = false) {
        if (state.value.resolvedSessionId != null) return
        if (!pending.compareAndSet(false, true)) return
        mutableState.value = ShareTargetState(busy = true)
        scope.launch {
            try {
                val active = gateway.isActive(sessionId)
                mutableState.value = if (!active && !confirmReopen) {
                    ShareTargetState(confirmSessionId = sessionId)
                } else {
                    ShareTargetState(resolvedSessionId = if (active) sessionId else gateway.reopen(sessionId))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                mutableState.value = ShareTargetState(failedSessionId = sessionId, error = formatReopenError(error))
            } finally {
                pending.set(false)
            }
        }
    }

    fun dismissConfirmation() { mutableState.value = ShareTargetState() }
    fun consumed() { mutableState.value = ShareTargetState() }
}
