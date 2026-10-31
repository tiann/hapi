package app.hapi.companion.feature.terminal

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
import kotlin.test.assertNull
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
 * TerminalViewModel state machine against a scripted gateway + detail store:
 * create flow, output/snapshot, write/resize gating, exit handling, inactive
 * disconnect, retry (same terminalId), reconnect clear-then-replay, font
 * ladder persistence.
 */
class TerminalViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var gateway: FakeTerminalGateway

    // ------------------------------------------------------------ connect flow --

    @Test
    fun waitsForGridSizeAndActiveDetailBeforeConnecting() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = newViewModel(store)
        advance()
        assertEquals(0, gateway.connectCalls)
        vm.onGridMeasured(80, 24)
        advance()
        assertEquals(1, gateway.connectCalls)
        assertEquals(listOf("${vm.terminalId}:80:24"), gateway.creates)
        assertEquals(TerminalStatus.Connecting, vm.uiState.value.status)
    }

    @Test
    fun readyMovesToConnectedAndOutputFeedsSnapshot() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = connectedViewModel(store)
        gateway.listener.onEvent(TerminalGatewayEvent.Output(vm.terminalId, "hello"))
        advance()
        assertEquals(TerminalStatus.Connected, vm.uiState.value.status)
        assertTrue(snapshotText(vm).contains("hello"))
    }

    @Test
    fun outputForAnotherTerminalIdIsIgnored() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = connectedViewModel(store)
        gateway.listener.onEvent(TerminalGatewayEvent.Output("other-terminal", "noise"))
        advance()
        assertFalse(snapshotText(vm).contains("noise"))
    }

    // ----------------------------------------------------------- input gating --

    @Test
    fun writeDropsUnlessConnected() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = newViewModel(store)
        vm.onGridMeasured(80, 24)
        advance()
        // Connecting (namespace up, terminal:ready not yet): dropped.
        vm.write("early")
        advance()
        assertEquals(emptyList(), gateway.writes)

        gateway.listener.onEvent(TerminalGatewayEvent.Ready(vm.terminalId))
        advance()
        vm.write("ls\r")
        advance()
        assertEquals(listOf("ls\r"), gateway.writes)
    }

    @Test
    fun resizeDedupesAndForwardsOnlyWhenConnected() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = newViewModel(store)
        vm.onGridMeasured(80, 24)
        advance()
        // A size change between create and terminal:ready resizes the local
        // emulator only — the resize emit is gated on Connected (the narrow
        // window the create request itself still covers).
        vm.onGridMeasured(100, 30)
        advance()
        assertEquals(emptyList(), gateway.resizes)

        gateway.listener.onEvent(TerminalGatewayEvent.Ready(vm.terminalId))
        advance()
        vm.onGridMeasured(100, 30) // dedupe: same size again
        advance()
        assertEquals(emptyList(), gateway.resizes)
        vm.onGridMeasured(120, 40)
        advance()
        assertEquals(listOf("${vm.terminalId}:120:40"), gateway.resizes)
        assertEquals(120, vm.uiState.value.snapshot.cols)
    }

    // ------------------------------------------------------------- exit path --

    @Test
    fun exitWritesMarkerSetsErrorAndExitInfo() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = connectedViewModel(store)
        gateway.listener.onEvent(TerminalGatewayEvent.Exit(vm.terminalId, code = 0, signal = null))
        advance()
        val status = vm.uiState.value.status
        assertTrue(status is TerminalStatus.Error && status.message == "Terminal exited.")
        assertEquals(TerminalExitInfo(code = 0, signal = null), vm.uiState.value.exitInfo)
        assertTrue(snapshotText(vm).contains("[process exited with code 0]"))
    }

    @Test
    fun exitWithSignalKeepsCodeAndSignal() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = connectedViewModel(store)
        gateway.listener.onEvent(TerminalGatewayEvent.Exit(vm.terminalId, code = 1, signal = "SIGHUP"))
        advance()
        assertEquals(TerminalExitInfo(code = 1, signal = "SIGHUP"), vm.uiState.value.exitInfo)
        assertTrue(snapshotText(vm).contains("[process exited with code 1]"))
    }

    @Test
    fun hubErrorSurfacesMessage() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = connectedViewModel(store)
        gateway.listener.onEvent(TerminalGatewayEvent.TerminalError(vm.terminalId, "session inactive"))
        advance()
        val status = vm.uiState.value.status
        assertTrue(status is TerminalStatus.Error && status.message == "session inactive")
    }

    // -------------------------------------------------------- session gating --

    @Test
    fun inactiveSessionDisconnectsAndReviveReconnects() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = connectedViewModel(store)

        store.setDetail(activeSession(active = false))
        advance()
        assertEquals(1, gateway.disconnectCalls)
        assertEquals(TerminalStatus.Idle, vm.uiState.value.status)

        store.setDetail(activeSession(active = true))
        advance()
        assertEquals(2, gateway.connectCalls)
        assertEquals(listOf("${vm.terminalId}:80:24", "${vm.terminalId}:80:24"), gateway.creates)
    }

    @Test
    fun unsupportedSessionNeverConnects() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession(terminal = false)) }
        val vm = newViewModel(store)
        advance()
        assertFalse(vm.uiState.value.session.supported)
        vm.onGridMeasured(80, 24)
        advance()
        assertEquals(0, gateway.connectCalls)
    }

    @Test
    fun missingCapabilityDefaultsToSupported() = runTest(dispatcher) {
        val store = FakeSessionStore().apply {
            setDetail(activeSession(capabilities = null))
        }
        val vm = newViewModel(store)
        advance()
        assertTrue(vm.uiState.value.session.supported)
    }

    // ----------------------------------------------------------- retry path --

    @Test
    fun retryAfterExitRecreatesWithSameIdAndClearsBuffer() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = connectedViewModel(store)
        gateway.listener.onEvent(TerminalGatewayEvent.Output(vm.terminalId, "old output"))
        advance()
        gateway.listener.onEvent(TerminalGatewayEvent.Exit(vm.terminalId, code = 0, signal = null))
        advance()

        vm.retry()
        advance()
        // Socket still live: re-create directly, same terminalId (hub replays).
        assertTrue(gateway.isConnected)
        assertEquals(2, gateway.creates.size)
        assertTrue(gateway.creates.all { it == "${vm.terminalId}:80:24" })
        // Exit marker cleared by the pre-recreate reset.
        assertFalse(snapshotText(vm).contains("[process exited"))
        assertNull(vm.uiState.value.exitInfo)

        gateway.listener.onEvent(TerminalGatewayEvent.Ready(vm.terminalId))
        advance()
        assertEquals(TerminalStatus.Connected, vm.uiState.value.status)
    }

    @Test
    fun transportDropSurfacesErrorAndRetryClearsThenReplays() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = connectedViewModel(store)
        gateway.listener.onEvent(TerminalGatewayEvent.Output(vm.terminalId, "buffered"))
        advance()

        gateway.connected = false
        gateway.listener.onEvent(TerminalGatewayEvent.Disconnected("ping timeout"))
        advance()
        val status = vm.uiState.value.status
        assertTrue(status is TerminalStatus.Error && status.message == "Disconnected: ping timeout")

        vm.retry()
        advance()
        // connect() reconnects; NamespaceConnected resets the emulator before
        // the hub replays (clear-then-replay — no duplicated scrollback).
        assertEquals(2, gateway.connectCalls)
        assertTrue(snapshotText(vm).isEmpty())
        assertEquals(TerminalStatus.Connecting, vm.uiState.value.status)
    }

    @Test
    fun namespaceAuthFailureSurfacesMessage() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = newViewModel(store)
        vm.onGridMeasured(80, 24)
        advance()
        gateway.listener.onEvent(TerminalGatewayEvent.ConnectError("invalid token"))
        advance()
        val status = vm.uiState.value.status
        assertTrue(status is TerminalStatus.Error && status.message == "invalid token")
    }

    // ------------------------------------------------------------ font ladder --

    @Test
    fun fontStepsPersistAndClampAtLadderEnds() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val prefs = RecordingFontPrefs()
        val vm = newViewModel(store, prefs)
        assertEquals(13, vm.uiState.value.fontSizeSp)

        vm.stepFont(up = true)
        advance()
        assertEquals(15, vm.uiState.value.fontSizeSp)
        assertEquals(15, prefs.saved)

        vm.stepFont(up = true)
        vm.stepFont(up = true)
        advance()
        assertEquals(17, vm.uiState.value.fontSizeSp)

        vm.stepFont(up = true) // past the ladder end: stays
        advance()
        assertEquals(17, vm.uiState.value.fontSizeSp)

        vm.stepFont(up = false)
        vm.stepFont(up = false)
        vm.stepFont(up = false)
        vm.stepFont(up = false) // past the ladder start: stays
        advance()
        assertEquals(9, vm.uiState.value.fontSizeSp)
    }

    @Test
    fun storedFontSizeIsSanitizedToLadder() = runTest(dispatcher) {
        val store = FakeSessionStore().apply { setDetail(activeSession()) }
        val vm = newViewModel(store, RecordingFontPrefs(initial = 14))
        assertEquals(13, vm.uiState.value.fontSizeSp)
    }

    // -------------------------------------------------------------- fixtures --

    private fun advance() {
        dispatcher.scheduler.advanceUntilIdle()
    }

    private fun newViewModel(
        store: FakeSessionStore,
        fontPrefs: TerminalFontPrefs = TerminalFontPrefs.NOOP,
    ): TerminalViewModel {
        val scope = CoroutineScope(SupervisorJob() + dispatcher)
        return TerminalViewModel(
            sessionId = SESSION_ID,
            sessionStore = store,
            gatewayFactory = { listener ->
                FakeTerminalGateway(listener).also { gateway = it }
            },
            fontPrefs = fontPrefs,
            scope = scope,
        )
    }

    /** Detail loaded + connected at 80x24 (the common precondition). */
    private fun connectedViewModel(store: FakeSessionStore): TerminalViewModel {
        val vm = newViewModel(store)
        vm.onGridMeasured(80, 24)
        advance()
        gateway.listener.onEvent(TerminalGatewayEvent.Ready(vm.terminalId))
        advance()
        return vm
    }

    /** Content text only — the cursor's flagged blank cell is UI, not content. */
    private fun snapshotText(vm: TerminalViewModel): String =
        vm.uiState.value.snapshot.lines.joinToString("") { line ->
            line.runs.joinToString("") { if (it.isCursor) "" else it.text }
        }

    private fun activeSession(
        active: Boolean = true,
        terminal: Boolean? = true,
        capabilities: SessionCapabilities? = SessionCapabilities(terminal = terminal),
    ): Session = baseSession(
        active = active,
        metadata = SessionMetadata(path = "/repo", host = "mac", capabilities = capabilities),
    )

    private fun baseSession(active: Boolean, metadata: SessionMetadata?): Session = Session(
        id = SESSION_ID,
        namespace = "default",
        seq = 1,
        createdAt = 1,
        updatedAt = 1,
        active = active,
        metadata = metadata,
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
private class FakeTerminalGateway(val listener: TerminalEventListener) : TerminalGateway {
    val creates = mutableListOf<String>()
    val writes = mutableListOf<String>()
    val resizes = mutableListOf<String>()
    var connectCalls = 0
        private set
    var disconnectCalls = 0
        private set
    var connected = false

    override fun connect() {
        connectCalls += 1
        connected = true
        listener.onEvent(TerminalGatewayEvent.NamespaceConnected)
    }

    override fun disconnect() {
        disconnectCalls += 1
        connected = false
    }

    override val isConnected: Boolean
        get() = connected

    override fun createTerminal(terminalId: String, cols: Int, rows: Int) {
        creates += "$terminalId:$cols:$rows"
    }

    override fun write(terminalId: String, data: String) {
        writes += data
    }

    override fun resize(terminalId: String, cols: Int, rows: Int) {
        resizes += "$terminalId:$cols:$rows"
    }
}

private class RecordingFontPrefs(var initial: Int? = null) : TerminalFontPrefs {
    var saved: Int? = null
        private set

    override fun load(): Int? = initial

    override fun save(sizeSp: Int) {
        saved = sizeSp
        initial = sizeSp
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
