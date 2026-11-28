package app.hapi.companion.feature.chat

import androidx.annotation.MainThread
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.res.stringResource
import app.hapi.companion.R
import app.hapi.data.api.ChatSessionApi
import app.hapi.data.store.SessionDetailStore
import app.hapi.protocol.wire.ModelError
import app.hapi.protocol.wire.Session
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal data class ModelErrorRecoveryState(
    val error: ModelError? = null,
    val canBridge: Boolean = false,
    val busy: Boolean = false,
    val bridging: Boolean = false,
    val failureReason: String? = null,
    @StringRes val fallbackResource: Int? = null,
)

/** The rendered event ID is checked again against the live detail at click time. */
internal class ModelErrorRecovery(
    private val sessionId: String,
    private val api: ChatSessionApi,
    private val store: SessionDetailStore,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val mutableState = MutableStateFlow(ModelErrorRecoveryState())
    val state = mutableState.asStateFlow()

    private data class Request(val eventId: String, val bridge: Boolean)
    private var request: Request? = null
    private var pendingBridge: String? = null
    private data class Failure(val eventId: String, val reason: String?, @StringRes val fallback: Int)
    private var failure: Failure? = null

    init {
        scope.launch { store.sessionDetail(sessionId).collect { render() } }
    }

    private fun render(session: Session? = store.currentDetail(sessionId)) {
        val error = session?.metadata?.lastModelError?.takeIf { it.recoveryStatus != null }
        val eventId = error?.eventId
        if (pendingBridge != eventId || session?.active != true || error?.isBridgeable != true) {
            pendingBridge = null
        }
        if (failure?.eventId != eventId) failure = null
        mutableState.value = ModelErrorRecoveryState(
            error = error,
            canBridge = error?.isBridgeable == true &&
                session?.active == true && !session.thinking && session.metadata?.flavor == "cursor",
            busy = request != null,
            bridging = eventId != null && (pendingBridge == eventId ||
                (request?.eventId == eventId && request?.bridge == true)),
            failureReason = failure?.reason,
            fallbackResource = failure?.fallback,
        )
    }

    @MainThread fun bridge(eventId: String) = submit(eventId, bridge = true)
    @MainThread fun dismiss(eventId: String) = submit(eventId, bridge = false)

    @MainThread fun onAbort() {
        pendingBridge = null
        if (request?.bridge == true) request = null
        render()
    }

    private fun submit(eventId: String, bridge: Boolean) {
        render()
        val current = state.value
        if (eventId.isBlank() || current.error?.eventId != eventId || current.busy) return
        if (bridge && (!current.canBridge || current.bridging)) return
        val operation = Request(eventId, bridge)
        request = operation
        failure = null
        render()
        scope.launch {
            try {
                perform(operation)
            } finally {
                if (request === operation) request = null
                render()
            }
        }
    }

    private suspend fun perform(operation: Request) {
        val (eventId, bridge) = operation
        try {
            if (bridge) {
                val result = withContext(io) { api.bridgeModelError(sessionId, eventId) }
                if (request === operation) {
                    if (result.ok) pendingBridge = eventId
                    else fail(eventId, result.reason ?: "not_bridgeable")
                }
            } else {
                withContext(io) { api.acknowledgeModelError(sessionId, eventId) }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (request === operation) fail(eventId, e.message)
        }
        // A lost response can hide an accepted write; a stale-event rejection can
        // also mean a newer error replaced it. Refresh without sending the action again.
        try {
            store.scheduleRefresh()
            val detail = withContext(io) { store.loadSessionDetail(sessionId) }
            val observed = detail.metadata?.lastModelError
            if (!bridge && request === operation && failure == null &&
                observed?.eventId == eventId && observed.recoveryStatus != null
            ) fail(eventId, null, R.string.model_error_ack_unconfirmed)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (request === operation && failure == null) fail(eventId, e.message)
        }
    }

    private fun fail(eventId: String, message: String?, @StringRes resource: Int = R.string.model_error_action_failed) {
        failure = Failure(eventId, message?.takeIf { it.isNotBlank() }, resource)
    }
}

@Composable
internal fun ChatModelErrorRecovery(controller: ModelErrorRecovery) {
    val state by controller.state.collectAsState()
    ModelErrorBanner(
        error = state.error,
        canBridge = state.canBridge,
        bridging = state.bridging,
        busy = state.busy,
        failureReason = state.failureReason ?: state.fallbackResource?.let { stringResource(it) },
        onBridge = controller::bridge,
        onDismiss = controller::dismiss,
    )
}
