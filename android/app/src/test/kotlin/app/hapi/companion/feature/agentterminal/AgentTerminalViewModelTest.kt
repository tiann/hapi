package app.hapi.companion.feature.agentterminal

import app.hapi.companion.feature.terminal.TerminalStatus
import app.hapi.data.sse.SseSubscriptionKey
import app.hapi.data.store.SessionDetailStore
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionCapabilities
import app.hapi.protocol.wire.SessionMetadata
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SyncEvent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest

/**
 * AgentTerminalViewModel state machine against a scripted gateway + detail
 * store (requirement 5: subscribe/unsubscribe lifecycle, gating rejection,
 * buffer merging, resize) — the fake socket delivers events synchronously, so
 * every scenario is dense (no delays, no real I/O).
 */
class AgentTerminalViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var gateway: FakeAgentTerminalGateway

    // -------------------------------------------------- connect + subscribe --

    @Test
    fun connectsLazilyOnlyWhenPanelShown() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession()) }
        val vm = newViewModel(store)
        advance()
        // Detail OK but panel never opened: NO socket (web connects at hidden
        // mount; Android's declared lazy deviation).
        assertEquals(AgentTerminalGate.OK, vm.uiState.value.gate)
        assertEquals(0, gateway.connectCalls)

        vm.setVisible(true)
        advance()
        assertEquals(1, gateway.connectCalls)
        assertEquals(1, gateway.subscribes)
        assertEquals(TerminalStatus.Connected, vm.uiState.value.status)
        assertTrue(vm.uiState.value.subscribed)
    }

    @Test
    fun hideUnsubscribesButKeepsSocketForInstantResubscribe() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession()) }
        val vm = subscribedViewModel(store)

        vm.setVisible(false)
        advance()
        assertEquals(1, gateway.unsubscribes)
        // Web parity: hide = unsubscribe only; the socket survives.
        assertEquals(0, gateway.disconnectCalls)
        assertFalse(vm.uiState.value.subscribed)

        vm.setVisible(true)
        advance()
        assertEquals(2, gateway.subscribes)
        assertEquals(1, gateway.connectCalls)
    }

    @Test
    fun detailStillLoadingNeitherConnectsNorRefuses() = runTest(dispatcher) {
        val store = FakeSessionStore()
        val vm = newViewModel(store)
        advance()
        assertEquals(AgentTerminalGate.LOADING, vm.uiState.value.gate)
        vm.setVisible(true)
        advance()
        assertEquals(0, gateway.connectCalls)
    }

    // -------------------------------------------------------- gating reasons --

    @Test
    fun nonPtySessionRefusesWithReasonInsteadOfConnecting() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession(startingMode = "remote")) }
        val vm = newViewModel(store)
        advance()
        assertEquals(AgentTerminalGate.NOT_PTY, vm.uiState.value.gate)
        vm.setVisible(true)
        advance()
        assertEquals(0, gateway.connectCalls)
        assertEquals(0, gateway.subscribes)
    }

    @Test
    fun inactiveSessionUnsubscribesDisconnectsAndReviveReconnects() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession()) }
        val vm = subscribedViewModel(store)

        store.setDetail(ptySession(active = false))
        advance()
        assertEquals(AgentTerminalGate.INACTIVE, vm.uiState.value.gate)
        // Web unmount on !canViewAgentTerminal → unsubscribe + disconnect.
        assertEquals(1, gateway.unsubscribes)
        assertEquals(1, gateway.disconnectCalls)
        assertEquals(TerminalStatus.Idle, vm.uiState.value.status)

        store.setDetail(ptySession(active = true))
        advance()
        assertEquals(AgentTerminalGate.OK, vm.uiState.value.gate)
        assertEquals(2, gateway.connectCalls)
        assertEquals(2, gateway.subscribes)
    }

    // -------------------------------------------------------- buffer merging --

    @Test
    fun outputChunksMergeIncludingEscapeSequencesSplitAcrossChunks() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession()) }
        val vm = subscribedViewModel(store)

        // CUB split across two chunks: "AB" then ESC [ 2 D arrives as
        // "\u001b[" + "2D"; the emulator holds the partial CSI (persistent
        // parser) so the cursor really moves back two cells and XY overwrites.
        gateway.fireOutput("AB\u001b[")
        advance()
        gateway.fireOutput("2D")
        advance()
        gateway.fireOutput("XY")
        advance()
        assertEquals("XY", snapshotText(vm))
    }

    @Test
    fun outputRendersLinesAndStyleRunsFromMergedChunks() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession()) }
        val vm = subscribedViewModel(store)
        gateway.fireOutput("line1\r\n\u001b[31mred\u001b[0m\r\nline3")
        advance()
        val lines = vm.uiState.value.snapshot.lines
        // The snapshot carries the full 80x12 grid; only trailing blank rows
        // follow the content, so the first three lines are the merged output
        // (cursor blank cells stripped, like snapshotText).
        assertEquals(
            listOf("line1", "red", "line3"),
            lines.take(3).map { line ->
                line.runs.joinToString("") { if (it.isCursor) "" else it.text }
            },
        )
    }

    @Test
    fun resubscribeClearsThenReplaysInsteadOfDuplicating() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession()) }
        val vm = subscribedViewModel(store)
        gateway.fireOutput("old buffer")
        advance()
        assertTrue(snapshotText(vm).contains("old buffer"))

        vm.setVisible(false)
        advance()
        vm.setVisible(true)
        advance()
        // Clear-then-replay: the emulator was reset BEFORE the CLI refresh
        // replays its buffer (web keeps the local xterm and duplicates).
        assertFalse(snapshotText(vm).contains("old buffer"))

        gateway.fireOutput("fresh replay")
        advance()
        assertTrue(snapshotText(vm).contains("fresh replay"))
    }

    // ------------------------------------------------------------- reconnect --

    @Test
    fun reconnectResubscribesAndClearsWhileViewerStillWantsStream() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession()) }
        val vm = subscribedViewModel(store)
        gateway.fireOutput("buffered")
        advance()

        gateway.connected = false
        gateway.fireDisconnected("ping timeout")
        advance()
        assertTrue(vm.uiState.value.status is TerminalStatus.Error)

        gateway.simulateAutoReconnect()
        advance()
        assertEquals(TerminalStatus.Connected, vm.uiState.value.status)
        assertEquals(2, gateway.subscribes)
        assertFalse(snapshotText(vm).contains("buffered"))
    }

    @Test
    fun reconnectWhileHiddenDoesNotResubscribe() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession()) }
        val vm = subscribedViewModel(store)
        vm.setVisible(false)
        advance()

        gateway.connected = false
        gateway.simulateAutoReconnect()
        advance()
        // Web subscribedRef: a reconnect resubscribes only if still wanted.
        assertEquals(1, gateway.subscribes)
        assertEquals(1, gateway.unsubscribes)
        assertEquals(TerminalStatus.Connected, vm.uiState.value.status)
    }

    // ---------------------------------------------------------------- resize --

    @Test
    fun resizeFollowsPanelLayoutOnlyForwardingWhileSubscribed() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession()) }
        val vm = subscribedViewModel(store)
        vm.onGridMeasured(100, 30)
        advance()
        assertEquals(listOf("100:30"), gateway.resizes)
        assertEquals(100, vm.uiState.value.snapshot.cols)
        assertEquals(30, vm.uiState.value.snapshot.rows)

        vm.onGridMeasured(100, 30) // dedupe: identical measure
        advance()
        assertEquals(listOf("100:30"), gateway.resizes)

        // Hidden viewer: local emulator still tracks the layout, but no emit
        // (web: fit on a display:none container must not resize the PTY).
        vm.setVisible(false)
        advance()
        vm.onGridMeasured(120, 40)
        advance()
        assertEquals(listOf("100:30"), gateway.resizes)
        assertEquals(120, vm.uiState.value.snapshot.cols)

        // Re-attach at the pending size: the subscribe path repaints at it.
        vm.setVisible(true)
        advance()
        assertEquals(listOf("100:30", "120:40"), gateway.resizes)
    }

    @Test
    fun measureBeforeConnectResizesLocalEmulatorOnly() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession()) }
        val vm = newViewModel(store)
        vm.onGridMeasured(90, 20)
        advance()
        assertEquals(90, vm.uiState.value.snapshot.cols)
        assertEquals(emptyList(), gateway.resizes)
        assertEquals(0, gateway.connectCalls)

        vm.setVisible(true)
        advance()
        // First connect subscribes at the already-measured size.
        assertEquals(listOf("90:20"), gateway.resizes)
    }

    // ----------------------------------------------------------------- input --

    @Test
    fun inputIsInteractiveOnlyWhileConnected() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession()) }
        val vm = newViewModel(store)
        vm.setVisible(true)
        advance()
        vm.sendInput("\r")
        advance()
        assertEquals(listOf("\r"), gateway.inputs)

        vm.setVisible(false)
        advance()
        vm.sendInput("hidden") // socket still connected: web would send too,
        advance() // but the panel is gone — gated like the hidden xterm.
        assertEquals(listOf("\r"), gateway.inputs)
    }

    @Test
    fun closeUnsubscribesAndStopsSocket() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(ptySession()) }
        val vm = subscribedViewModel(store)
        vm.close()
        assertEquals(1, gateway.unsubscribes)
        assertEquals(1, gateway.disconnectCalls)
        assertEquals(TerminalStatus.Idle, vm.uiState.value.status)
    }

    // -------------------------------------------------------------- fixtures --

    private fun advance() {
        dispatcher.scheduler.advanceUntilIdle()
    }

    private fun newViewModel(store: FakeSessionStore): AgentTerminalViewModel {
        val scope = CoroutineScope(SupervisorJob() + dispatcher)
        return AgentTerminalViewModel(
            sessionId = SESSION_ID,
            sessionStore = store,
            gatewayFactory = { listener ->
                FakeAgentTerminalGateway(listener).also { gateway = it }
            },
            scope = scope,
        )
    }

    /** Detail loaded + subscribed at the initial 80x12 geometry. */
    private fun subscribedViewModel(store: FakeSessionStore): AgentTerminalViewModel {
        val vm = newViewModel(store)
        vm.setVisible(true)
        advance()
        return vm
    }

    /** Content text only — the cursor's flagged blank cell is UI, not content. */
    private fun snapshotText(vm: AgentTerminalViewModel): String =
        vm.uiState.value.snapshot.lines.joinToString("") { line ->
            line.runs.joinToString("") { if (it.isCursor) "" else it.text }
        }

    private fun ptySession(
        active: Boolean = true,
        startingMode: String? = "pty",
    ): Session = Session(
        id = SESSION_ID,
        namespace = "default",
        seq = 1,
        createdAt = 1,
        updatedAt = 1,
        active = active,
        metadata = SessionMetadata(
            path = "/repo",
            host = "mac",
            capabilities = SessionCapabilities(terminal = true),
            startingMode = startingMode,
        ),
        metadataVersion = 1,
        agentStateVersion = 1,
        thinking = false,
        thinkingAt = 0,
    )

    private companion object {
        const val SESSION_ID = "sess-1"
    }
}

/** Records emits; connect() synchronously delivers NamespaceConnected. */
private class FakeAgentTerminalGateway(
    private val listener: AgentTerminalEventListener,
) : AgentTerminalGateway {
    var subscribes = 0
        private set
    var unsubscribes = 0
        private set
    val resizes = mutableListOf<String>()
    val inputs = mutableListOf<String>()
    var connectCalls = 0
        private set
    var disconnectCalls = 0
        private set
    var connected = false

    override fun connect() {
        connectCalls += 1
        connected = true
        listener.onEvent(AgentTerminalGatewayEvent.NamespaceConnected)
    }

    override fun disconnect() {
        disconnectCalls += 1
        connected = false
    }

    override val isConnected: Boolean
        get() = connected

    override fun subscribe() {
        subscribes += 1
    }

    override fun unsubscribe() {
        unsubscribes += 1
    }

    override fun resize(cols: Int, rows: Int) {
        resizes += "$cols:$rows"
    }

    override fun sendInput(data: String) {
        inputs += data
    }

    fun fireOutput(data: String) {
        listener.onEvent(AgentTerminalGatewayEvent.Output(data))
    }

    fun fireDisconnected(reason: String) {
        listener.onEvent(AgentTerminalGatewayEvent.Disconnected(reason))
    }

    /** What the real client does on its own after a transport drop. */
    fun simulateAutoReconnect() {
        connected = true
        listener.onEvent(AgentTerminalGatewayEvent.NamespaceConnected)
    }
}

/** Same seam fake as ChatViewModelTest, trimmed to the detail surface. */
private class FakeSessionStore : SessionDetailStore {
    val summaries = MutableStateFlow<List<SessionSummary>>(emptyList())
    override val sessions: StateFlow<List<SessionSummary>> = summaries

    private val details = MutableStateFlow<Map<String, Session>>(emptyMap())

    fun setDetail(session: Session) {
        details.value = details.value + (session.id to session)
    }

    override fun sessionDetail(sessionId: String): Flow<Session?> =
        details.map { it[sessionId] }.distinctUntilChanged()

    override suspend fun loadSessionDetail(sessionId: String): Session =
        details.value[sessionId] ?: error("no scripted detail")

    override fun currentDetail(sessionId: String): Session? = details.value[sessionId]

    override fun releaseDetail(sessionId: String) {
        details.value = details.value - sessionId
    }

    override fun updateDetailLocal(sessionId: String, transform: (Session) -> Session) {
        val current = details.value[sessionId] ?: return
        details.value = details.value + (sessionId to transform(current))
    }

    override suspend fun refresh() = Unit
    override fun scheduleRefresh() = Unit
    override suspend fun fullResync() = Unit
    override fun applySessionEvent(scope: SseSubscriptionKey, event: SyncEvent) = Unit
    override suspend fun setPinMode(sessionId: String, mode: String) = Unit
    override suspend fun archiveSession(sessionId: String) = Unit
    override suspend fun renameSession(sessionId: String, name: String) = Unit
    override suspend fun deleteSession(sessionId: String) = Unit
    override suspend fun reopenSession(sessionId: String): app.hapi.protocol.wire.ReopenSessionResponse =
        app.hapi.protocol.wire.ReopenSessionResponse(sessionId = sessionId, resumed = true)
}
