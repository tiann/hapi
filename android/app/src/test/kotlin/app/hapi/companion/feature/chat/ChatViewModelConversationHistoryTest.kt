package app.hapi.companion.feature.chat

import app.hapi.data.api.ApiError
import app.hapi.protocol.wire.AgentState
import app.hapi.protocol.wire.ConversationHistoryCapabilities
import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.ForkConversationResponse
import app.hapi.protocol.wire.MessagesResponse
import app.hapi.protocol.wire.OptionalField
import app.hapi.protocol.wire.RewindConversationResponse
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionCapabilities
import app.hapi.protocol.wire.SessionMetadata
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Conversation-history actions end to end at the ViewModel seam (batch 18 A):
 * the [ChatHistoryGate] projection through the real pipeline, the
 * confirm-dialog state machine, exact fork/rewind RPC payloads
 * (null-vs-localId), fork navigation via [ChatEvent.SessionSuperseded], the
 * rewind authoritative reload, and the rewind fallback / diverged error
 * classes. Reuses the [Harness] from [ChatViewModelTest] with a scripted
 * fork/rewind API.
 *
 * Timing convention (same as ChatViewModelInteractionTest): VM `scope.launch`
 * work only progresses while the test coroutine is suspended — assertions on
 * side effects wait via `first { }` / [withTimeout], never `runCurrent()`.
 */

private class HistoryApi : FakeMessagesApi() {
    val forkCalls = MutableStateFlow<List<Pair<String, String?>>>(emptyList())
    val rewindCalls = MutableStateFlow<List<Pair<String, String>>>(emptyList())
    var forkResult: ForkConversationResponse = ForkConversationResponse(sessionId = "sess-fork")
    var forkFailure: Exception? = null
    var forkGate: CompletableDeferred<Unit>? = null
    var rewindFailure: Exception? = null

    override suspend fun forkConversation(
        sessionId: String,
        messageLocalId: String?,
    ): ForkConversationResponse {
        forkCalls.value = forkCalls.value + (sessionId to messageLocalId)
        forkGate?.await()
        forkFailure?.let { throw it }
        return forkResult
    }

    override suspend fun rewindConversation(
        sessionId: String,
        messageLocalId: String,
    ): RewindConversationResponse {
        rewindCalls.value = rewindCalls.value + (sessionId to messageLocalId)
        rewindFailure?.let { throw it }
        return RewindConversationResponse(success = true)
    }
}

/** Invoked user row (`id != localId`, explicit `invokedAt`). */
private fun userRow(id: String, localId: String, at: Long): DecryptedMessage = DecryptedMessage(
    id = id,
    seq = at / 1_000,
    localId = localId,
    createdAt = at,
    invokedAt = OptionalField.Present(at),
    content = buildJsonObject {
        put("role", "user")
        putJsonObject("content") {
            put("type", "text")
            put("text", "prompt $id")
        }
    },
)

private fun historyDetail(
    thinking: Boolean = false,
    active: Boolean = true,
    capabilities: ConversationHistoryCapabilities? = ConversationHistoryCapabilities(
        forkCurrent = true,
        forkAtMessage = true,
        rewindToMessage = true,
    ),
    points: Map<String, Boolean>? = mapOf("u-local-1" to true, "u-local-2" to true),
    diverged: Boolean? = null,
    agentState: AgentState? = null,
    activeTurnStartedAt: Long? = null,
): Session = Session(
    id = SESSION_ID,
    namespace = "default",
    seq = 3,
    createdAt = 1,
    updatedAt = 2,
    active = active,
    metadata = SessionMetadata(
        path = "/repo/app",
        host = "devbox",
        flavor = "codex",
        capabilities = SessionCapabilities(conversationHistory = capabilities),
        conversationHistoryPoints = points,
        conversationHistoryDiverged = diverged,
    ),
    metadataVersion = 1,
    agentState = agentState,
    agentStateVersion = 1,
    thinking = thinking,
    thinkingAt = 0,
    activeTurnStartedAt = activeTurnStartedAt,
)

private fun historyHarness(testScope: TestScope, api: HistoryApi, detail: Session): Harness {
    val harness = Harness(testScope, ScriptedTransport(listOf("ok")), api)
    harness.sessionStore.detailToLoad = detail
    return harness
}

private fun tailWithOneTurn(): MessagesResponse = MessagesResponse(
    listOf(userRow("u1", "u-local-1", 1_000), agentMessage("a1", 2, 2_000, "done")),
    page("latest", hasMore = false),
)

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ChatViewModelConversationHistoryTest {

    /** Starts the harness and waits until the scripted turn is rendered. */
    private suspend fun Harness.startWithTurn() {
        api.tailResponses += tailWithOneTurn()
        viewModel.start()
        viewModel.uiState.first { it.blocks.isNotEmpty() }
    }

    /** Collects VM events into [events] while the caller suspends. */
    private fun Harness.recordEvents(events: MutableList<ChatEvent>) {
        scope.launch { viewModel.events.collect { events += it } }
    }

    // ---------------------------------------------------------------- gate --

    @Test
    fun `history gate surfaces capabilities points and the latest boundary`() = runTest {
        val api = HistoryApi()
        val h = historyHarness(this, api, historyDetail())
        h.startWithTurn()

        val state = h.viewModel.uiState.first { it.historyGate.available }
        val gate = state.historyGate
        assertFalse(gate.locked)
        assertTrue(gate.forkCurrent)
        assertTrue(gate.forkAtMessage)
        assertTrue(gate.rewindToMessage)
        assertEquals(mapOf("u-local-1" to true, "u-local-2" to true), gate.historyPoints)
        assertEquals("agent-text:a1:0", gate.latestBoundaryKey)
        h.viewModel.stop()
    }

    @Test
    fun `flavors without conversation history capabilities render no gate`() = runTest {
        val api = HistoryApi()
        val h = historyHarness(this, api, historyDetail(capabilities = null))
        h.startWithTurn()

        val state = h.viewModel.uiState.first { it.blocks.isNotEmpty() }
        assertEquals(ChatHistoryGate(), state.historyGate)
        h.viewModel.stop()
    }

    @Test
    fun `thinking locks the gate and refuses new dialogs`() = runTest {
        val api = HistoryApi()
        val h = historyHarness(this, api, historyDetail(thinking = true))
        h.startWithTurn()

        assertTrue(h.viewModel.uiState.first { it.blocks.isNotEmpty() }.historyGate.locked)
        h.viewModel.requestForkCurrent()
        h.viewModel.requestRewind("u-local-1")
        runCurrent()
        assertNull(h.viewModel.conversationHistory.value.dialog)
        h.viewModel.stop()
    }

    @Test
    fun `inactive or terminal-controlled sessions render no gate`() = runTest {
        val api = HistoryApi()
        val h = historyHarness(
            this,
            api,
            historyDetail(agentState = AgentState(controlledByUser = true)),
        )
        h.startWithTurn()

        assertFalse(h.viewModel.uiState.first { it.blocks.isNotEmpty() }.historyGate.available)
        h.viewModel.stop()
    }

    // ---------------------------------------------------------------- fork --

    @Test
    fun `fork current confirms dismisses and navigates to the child session`() = runTest {
        val api = HistoryApi()
        val h = historyHarness(this, api, historyDetail())
        h.startWithTurn()
        val events = mutableListOf<ChatEvent>()
        h.recordEvents(events)

        h.viewModel.requestForkCurrent()
        assertEquals(
            PendingHistoryAction.ForkCurrent,
            h.viewModel.conversationHistory.first { it.dialog != null }.dialog,
        )

        // Idle dismiss clears the dialog without calling the API.
        h.viewModel.dismissHistoryDialog()
        assertNull(h.viewModel.conversationHistory.first { it.dialog == null }.dialog)
        assertTrue(api.forkCalls.value.isEmpty())

        h.viewModel.requestForkCurrent()
        h.viewModel.conversationHistory.first { it.dialog != null }
        h.viewModel.confirmHistoryAction()
        withTimeout(1_000) { api.forkCalls.first { it.isNotEmpty() } }

        // Current-head fork omits the field entirely (web `{}`).
        assertEquals(listOf(SESSION_ID to null), api.forkCalls.value)
        val settled = h.viewModel.conversationHistory.first { !it.opPending && it.dialog == null }
        assertNull(settled.dialog)
        assertFalse(settled.opPending)
        val supersede = events.filterIsInstance<ChatEvent.SessionSuperseded>().singleOrNull()
        assertEquals("sess-fork", supersede?.sessionId)
        h.viewModel.stop()
    }

    @Test
    fun `fork at message carries the boundary local id`() = runTest {
        val api = HistoryApi()
        val h = historyHarness(this, api, historyDetail())
        h.startWithTurn()

        h.viewModel.requestForkAtMessage("u-local-1")
        assertEquals(
            PendingHistoryAction.ForkAtMessage("u-local-1"),
            h.viewModel.conversationHistory.first { it.dialog != null }.dialog,
        )
        h.viewModel.confirmHistoryAction()
        withTimeout(1_000) { api.forkCalls.first { it.isNotEmpty() } }
        assertEquals(listOf(SESSION_ID to "u-local-1"), api.forkCalls.value)
        h.viewModel.conversationHistory.first { it.dialog == null && !it.opPending }
        h.viewModel.stop()
    }

    @Test
    fun `fork failure closes the dialog surfaces the hub error and releases pending`() = runTest {
        val api = HistoryApi()
        api.forkFailure = ApiError(
            status = 409,
            code = "Session is busy",
            body = """{"error":"Session is busy"}""",
        )
        val h = historyHarness(this, api, historyDetail())
        h.startWithTurn()
        val events = mutableListOf<ChatEvent>()
        h.recordEvents(events)

        h.viewModel.requestForkCurrent()
        h.viewModel.conversationHistory.first { it.dialog != null }
        h.viewModel.confirmHistoryAction()
        val settled = h.viewModel.conversationHistory.first { it.dialog == null && !it.opPending }

        assertNull(settled.dialog)
        withTimeout(1_000) { api.forkCalls.first { it.isNotEmpty() } }
        val notice = events.filterIsInstance<ChatEvent.Notice>().singleOrNull()?.notice
        assertEquals(ChatNotice.ForkFailed("Session is busy"), notice)

        // Pending released — a fresh request opens a dialog again.
        h.viewModel.requestForkCurrent()
        assertEquals(
            PendingHistoryAction.ForkCurrent,
            h.viewModel.conversationHistory.first { it.dialog != null }.dialog,
        )
        h.viewModel.stop()
    }

    @Test
    fun `dismiss is refused while the fork RPC is in flight`() = runTest {
        val api = HistoryApi()
        api.forkGate = CompletableDeferred()
        val h = historyHarness(this, api, historyDetail())
        h.startWithTurn()

        h.viewModel.requestForkCurrent()
        h.viewModel.conversationHistory.first { it.dialog != null }
        h.viewModel.confirmHistoryAction()
        val inFlight = h.viewModel.conversationHistory.first { it.opPending }
        assertEquals(PendingHistoryAction.ForkCurrent, inFlight.dialog)

        // Refused: pending RPC keeps the dialog (no re-emission can occur —
        // the test body holds the scheduler while it runs).
        h.viewModel.dismissHistoryDialog()
        assertEquals(PendingHistoryAction.ForkCurrent, h.viewModel.conversationHistory.value.dialog)

        api.forkGate?.complete(Unit)
        withTimeout(1_000) { api.forkCalls.first { it.isNotEmpty() } }
        h.viewModel.conversationHistory.first { it.dialog == null && !it.opPending }
        h.viewModel.stop()
    }

    // -------------------------------------------------------------- rewind --

    @Test
    fun `rewind posts the boundary id resyncs the tail and jumps to latest`() = runTest {
        val api = HistoryApi()
        val h = historyHarness(this, api, historyDetail())
        h.startWithTurn()
        val jumpBefore = h.viewModel.jumpToken.value

        h.viewModel.requestRewind("u-local-1")
        assertEquals(
            PendingHistoryAction.Rewind("u-local-1"),
            h.viewModel.conversationHistory.first { it.dialog != null }.dialog,
        )
        api.tailResponses += tailWithOneTurn()
        val queriesBefore = api.queries.value.size
        h.viewModel.confirmHistoryAction()
        withTimeout(1_000) { api.rewindCalls.first { it.isNotEmpty() } }
        assertEquals(listOf(SESSION_ID to "u-local-1"), api.rewindCalls.value)
        h.viewModel.conversationHistory.first { it.dialog == null && !it.opPending }
        // Authoritative reload: the forced resync fetches fresh truth (an
        // After-increment against the current cursor, self-healing to a full
        // replace if the hub reports a reset), then the view jumps to the tail.
        withTimeout(1_000) { api.queries.first { it.size > queriesBefore } }
        withTimeout(1_000) { h.viewModel.jumpToken.first { it > jumpBefore } }
        h.viewModel.stop()
    }

    @Test
    fun `fork-safe rewind refusal opens the fork here fallback`() = runTest {
        val api = HistoryApi()
        api.rewindFailure = ApiError(
            status = 409,
            code = REWIND_FALLBACK_CODE,
            body = """{"error":"Boundary ambiguous","code":"ambiguous_native_boundary_fork_safe"}""",
        )
        val h = historyHarness(this, api, historyDetail())
        h.startWithTurn()
        val events = mutableListOf<ChatEvent>()
        h.recordEvents(events)

        h.viewModel.requestRewind("u-local-1")
        h.viewModel.conversationHistory.first { it.dialog != null }
        h.viewModel.confirmHistoryAction()
        val fallback = h.viewModel.conversationHistory.first { it.rewindFallbackLocalId != null }
        assertNull(fallback.dialog)
        assertEquals("u-local-1", fallback.rewindFallbackLocalId)

        // Confirming the fallback forks at the same boundary (and closes the
        // fallback dialog on settle either way).
        h.viewModel.confirmRewindFallback()
        withTimeout(1_000) { api.forkCalls.first { it.isNotEmpty() } }
        assertEquals(listOf(SESSION_ID to "u-local-1"), api.forkCalls.value)
        h.viewModel.conversationHistory.first { it.rewindFallbackLocalId == null && !it.opPending }
        assertEquals(
            "sess-fork",
            events.filterIsInstance<ChatEvent.SessionSuperseded>().singleOrNull()?.sessionId,
        )

        // Dismissing the fallback closes it without forking.
        api.forkCalls.value = emptyList()
        h.viewModel.requestRewind("u-local-1")
        h.viewModel.conversationHistory.first { it.dialog != null }
        h.viewModel.confirmHistoryAction()
        h.viewModel.conversationHistory.first { it.rewindFallbackLocalId != null }
        h.viewModel.dismissRewindFallback()
        assertNull(h.viewModel.conversationHistory.first { it.rewindFallbackLocalId == null }.rewindFallbackLocalId)
        assertTrue(api.forkCalls.value.isEmpty())
        h.viewModel.stop()
    }

    @Test
    fun `hydrate failure after rewind surfaces the diverged notice`() = runTest {
        val api = HistoryApi()
        api.rewindFailure = ApiError(
            status = 500,
            body = """{"error":"Rewind outcome is unknown","hydrateFailed":true}""",
        )
        val h = historyHarness(this, api, historyDetail())
        h.startWithTurn()
        val events = mutableListOf<ChatEvent>()
        h.recordEvents(events)

        h.viewModel.requestRewind("u-local-1")
        h.viewModel.conversationHistory.first { it.dialog != null }
        h.viewModel.confirmHistoryAction()
        val settled = h.viewModel.conversationHistory.first { it.dialog == null && !it.opPending }

        assertNull(settled.dialog)
        assertNull(settled.rewindFallbackLocalId)
        assertEquals(
            ChatNotice.RewindDiverged,
            events.filterIsInstance<ChatEvent.Notice>().singleOrNull()?.notice,
        )
        h.viewModel.stop()
    }

    @Test
    fun `plain rewind failure surfaces the hub error text`() = runTest {
        val api = HistoryApi()
        api.rewindFailure = ApiError(
            status = 409,
            code = "History boundary message not found or not yet invoked",
            body = """{"error":"History boundary message not found or not yet invoked"}""",
        )
        val h = historyHarness(this, api, historyDetail())
        h.startWithTurn()
        val events = mutableListOf<ChatEvent>()
        h.recordEvents(events)

        h.viewModel.requestRewind("u-local-1")
        h.viewModel.conversationHistory.first { it.dialog != null }
        h.viewModel.confirmHistoryAction()
        h.viewModel.conversationHistory.first { it.dialog == null && !it.opPending }

        assertEquals(
            ChatNotice.RewindFailed("History boundary message not found or not yet invoked"),
            events.filterIsInstance<ChatEvent.Notice>().singleOrNull()?.notice,
        )
        h.viewModel.stop()
    }
}
