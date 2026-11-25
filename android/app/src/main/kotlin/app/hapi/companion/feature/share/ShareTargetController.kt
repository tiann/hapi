package app.hapi.companion.feature.share

import app.hapi.companion.feature.chat.composer.ChatDrafts
import app.hapi.companion.feature.sessions.formatReopenError
import app.hapi.data.store.MessageWindowStores
import app.hapi.data.store.SessionDetailStore
import app.hapi.protocol.wire.Session
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

interface ShareSessionGateway {
    /** Fresh authenticated detail for the requested source session. */
    suspend fun loadSession(sessionId: String): Session
    /** Includes history seeding and draft migration when the returned ID changes. */
    suspend fun reopen(sessionId: String, verified: Session): String
}

internal class StoreShareSessionGateway(
    private val sessions: SessionDetailStore,
    private val windows: MessageWindowStores,
    private val drafts: ChatDrafts,
) : ShareSessionGateway {
    override suspend fun loadSession(sessionId: String) = sessions.loadSessionDetail(sessionId)

    override suspend fun reopen(sessionId: String, verified: Session): String {
        val targetId = sessions.reopenSession(sessionId).sessionId
        if (targetId != sessionId) {
            // The source chat may never have been opened since upgrading.
            // Use its authenticated detail, not the replacement session's ID.
            windows.recoverLegacyFailedSends(sessionId, verified)
            windows.seed(sessionId, targetId)
            drafts.move(sessionId, targetId)
        }
        return targetId
    }
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
                val session = gateway.loadSession(sessionId)
                mutableState.value = if (!session.active && !confirmReopen) {
                    ShareTargetState(confirmSessionId = sessionId)
                } else {
                    ShareTargetState(resolvedSessionId = if (session.active) sessionId else gateway.reopen(sessionId, session))
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
