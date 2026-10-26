package app.hapi.companion.feature.terminal

import app.hapi.data.store.SessionDetailStore
import app.hapi.protocol.wire.Session
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Connection status of the terminal socket (web `TerminalConnectionState`). */
sealed interface TerminalStatus {
    data object Idle : TerminalStatus
    data object Connecting : TerminalStatus
    data object Connected : TerminalStatus
    data class Error(val message: String) : TerminalStatus
}

/** `terminal:exit` payload surfaced in the exited banner. */
data class TerminalExitInfo(val code: Int?, val signal: String?)

/** Session-side gating for the terminal route (web `useSession` + support check). */
data class TerminalSessionUi(
    /** False while the detail has not loaded — the screen shows no banners yet. */
    val loaded: Boolean = false,
    val active: Boolean = false,
    /** `metadata.capabilities.terminal ?? true` (win32 hosts report false). */
    val supported: Boolean = true,
    /** `metadata.path ?? sessionId` — the top-bar subtitle. */
    val subtitle: String? = null,
)

/** What [TerminalScreen] renders. */
data class TerminalUiState(
    val status: TerminalStatus = TerminalStatus.Idle,
    val exitInfo: TerminalExitInfo? = null,
    val session: TerminalSessionUi = TerminalSessionUi(),
    val snapshot: TerminalSnapshot,
    /** Persisted font size (sp) from [TerminalViewModel.TERMINAL_FONT_SIZES]. */
    val fontSizeSp: Int,
)

/** Font-size persistence (SharedPreferences in production; in-memory in tests). */
interface TerminalFontPrefs {
    fun load(): Int?
    fun save(sizeSp: Int)

    companion object {
        /** No-op persistence: default font size, nothing written back. */
        val NOOP: TerminalFontPrefs = object : TerminalFontPrefs {
            override fun load(): Int? = null
            override fun save(sizeSp: Int) = Unit
        }
    }
}

/**
 * Terminal screen state machine: owns the [TerminalEmulator], one
 * per-viewer [terminalId] (stable across reconnects — the hub replays the
 * buffer for a re-created id), and the socket lifecycle gate.
 *
 * Every public entry point funnels through one channel so ALL emulator and
 * state access happens on a single reader coroutine — gateway callbacks arrive
 * on the client's reader, UI callbacks on the main thread; neither touches the
 * emulator directly.
 *
 * Parity notes vs the web hook (`useTerminalSocket`) — the intentional
 * divergences:
 * - On (re)connect the emulator is RESET before the hub replays its buffer
 *   (web keeps the local xterm and ends up with duplicated scrollback).
 * - Retry is user-owned: transport loss shows an error + Retry button; the
 *   socket client keeps auto-reconnecting underneath (like socket.io-client),
 *   but a fatal auth failure stops after a bounded budget and surfaces the
 *   reason instead of retrying forever.
 * - `terminal:exit` writes the same `[process exited…]` marker into the buffer
 *   but STAYS on the screen (web auto-navigates back after 700 ms).
 */
class TerminalViewModel(
    val sessionId: String,
    sessionStore: SessionDetailStore,
    gatewayFactory: (TerminalEventListener) -> TerminalGateway,
    private val fontPrefs: TerminalFontPrefs = TerminalFontPrefs.NOOP,
    private val scope: CoroutineScope,
) {
    internal val terminalId = "term-$sessionId-" + randomTerminalSuffix()

    private val gateway = gatewayFactory { event -> events.trySend(VmEvent.FromGateway(event)) }

    private val emulator = TerminalEmulator(
        initialCols = TerminalEmulator.DEFAULT_COLS,
        initialRows = TerminalEmulator.DEFAULT_ROWS,
    )

    private sealed interface VmEvent {
        data class FromGateway(val event: TerminalGatewayEvent) : VmEvent
        data class GridMeasured(val cols: Int, val rows: Int) : VmEvent
        data class WriteRequested(val data: String) : VmEvent
        data object RetryRequested : VmEvent
        data class FontStepRequested(val up: Boolean) : VmEvent
    }

    private val events = Channel<VmEvent>(Channel.UNLIMITED)

    private val state = MutableStateFlow(
        TerminalUiState(
            snapshot = emulator.snapshot(),
            fontSizeSp = sanitizeFontSize(fontPrefs.load()),
        ),
    )
    val uiState: StateFlow<TerminalUiState> = state.asStateFlow()

    /** True once the first terminal:output lands — gates clear-then-replay resets. */
    private var receivedOutput = false

    /** Web `connectOnceRef`: the first connect attempt has been made for this size. */
    private var connectStarted = false

    /** Set while WE call disconnect(), so the Disconnected event maps to Idle. */
    private var closingByUser = false

    private var lastCols: Int? = null
    private var lastRows: Int? = null

    init {
        scope.launch {
            for (event in events) {
                runCatching { handle(event) }
            }
        }
        scope.launch {
            sessionStore.sessionDetail(sessionId).collect { detail -> onDetail(detail) }
        }
        // The chat screen below this route usually cached the detail already;
        // fetch only when nothing is cached (terminal opened cold).
        if (sessionStore.currentDetail(sessionId) == null) {
            scope.launch {
                try {
                    sessionStore.loadSessionDetail(sessionId)
                } catch (expected: Exception) {
                    if (expected is CancellationException) throw expected
                    // Offline: the session banner keeps loaded=false; retry by
                    // re-entering the screen. No terminal connects blindly.
                }
            }
        }
    }

    // ------------------------------------------------------------- UI inputs --

    /** Measured grid (already clamped by the screen's char metrics). */
    fun onGridMeasured(cols: Int, rows: Int) {
        events.trySend(VmEvent.GridMeasured(cols, rows))
    }

    /** Raw PTY input (command bytes, quick keys, paste). Drops unless connected. */
    fun write(data: String) {
        events.trySend(VmEvent.WriteRequested(data))
    }

    /** Error/exit recovery: re-create the terminal with the same id (buffer replay). */
    fun retry() {
        events.trySend(VmEvent.RetryRequested)
    }

    /** Steps the font ladder one rung and persists the choice. */
    fun stepFont(up: Boolean) {
        events.trySend(VmEvent.FontStepRequested(up))
    }

    /**
     * Leaves the screen for good: stops the socket (the hub reaps the PTY on
     * disconnect). Synchronous on purpose — the holder cancels its scope right
     * after this, which would strand a buffered channel event (and the socket).
     */
    fun close() {
        disconnectForGood()
    }

    // --------------------------------------------------------------- session --

    private fun onDetail(detail: Session?) {
        val supported = detail?.metadata?.capabilities?.terminal ?: true
        val active = detail?.active ?: false
        state.update {
            it.copy(
                session = TerminalSessionUi(
                    loaded = detail != null,
                    active = active,
                    supported = supported,
                    subtitle = detail?.metadata?.path ?: sessionId,
                ),
            )
        }
        when {
            // Web parity: an inactive (or unsupported) session disconnects and
            // re-arms connectOnce, so a later revive reconnects.
            (!active || !supported) && connectStarted -> {
                connectStarted = false
                disconnectForGood()
            }
            active && supported && lastCols != null && !connectStarted -> beginConnect()
            else -> Unit
        }
    }

    // ---------------------------------------------------------------- events --

    private fun handle(event: VmEvent) {
        when (event) {
            is VmEvent.FromGateway -> handleGateway(event.event)
            is VmEvent.GridMeasured -> handleGridMeasured(event.cols, event.rows)
            is VmEvent.WriteRequested ->
                if (state.value.status == TerminalStatus.Connected) {
                    gateway.write(terminalId, event.data)
                }
            VmEvent.RetryRequested -> handleRetry()
            is VmEvent.FontStepRequested -> handleFontStep(event.up)
        }
    }

    private fun handleGateway(event: TerminalGatewayEvent) {
        when (event) {
            TerminalGatewayEvent.NamespaceConnected -> {
                if (closingByUser) return
                // Clear-then-replay: a fresh create makes the hub replay its
                // buffer; resetting first avoids the duplicated scrollback the
                // web client shows after reconnects.
                if (receivedOutput) {
                    emulator.reset()
                    receivedOutput = false
                    // Publish the cleared grid: the replay refills it, and the
                    // banner-less intermediate frame is what the user sees if
                    // the replay never arrives.
                    publishSnapshot()
                }
                state.update { it.copy(status = TerminalStatus.Connecting, exitInfo = null) }
                gateway.createTerminal(terminalId, lastCols ?: TerminalEmulator.DEFAULT_COLS, lastRows ?: TerminalEmulator.DEFAULT_ROWS)
            }
            is TerminalGatewayEvent.Ready -> {
                if (event.terminalId != terminalId) return
                state.update { it.copy(status = TerminalStatus.Connected, exitInfo = null) }
            }
            is TerminalGatewayEvent.Output -> {
                if (event.terminalId != terminalId) return
                receivedOutput = true
                emulator.write(event.data)
                publishSnapshot()
            }
            is TerminalGatewayEvent.Exit -> {
                if (event.terminalId != terminalId) return
                // Same marker text the web route writes into xterm.
                emulator.write(
                    "\r\n[process exited" +
                        (event.code?.let { " with code $it" } ?: "") +
                        "]",
                )
                publishSnapshot()
                state.update {
                    it.copy(status = TerminalStatus.Error("Terminal exited."), exitInfo = TerminalExitInfo(event.code, event.signal))
                }
            }
            is TerminalGatewayEvent.TerminalError -> {
                if (event.terminalId != terminalId) return
                state.update { it.copy(status = TerminalStatus.Error(event.message)) }
            }
            is TerminalGatewayEvent.ConnectError ->
                state.update { it.copy(status = TerminalStatus.Error(event.message)) }
            is TerminalGatewayEvent.Disconnected -> {
                // closingByUser disconnects map to idle (web: 'io client disconnect').
                if (closingByUser) {
                    state.update { it.copy(status = TerminalStatus.Idle) }
                } else {
                    state.update { it.copy(status = TerminalStatus.Error("Disconnected: ${event.reason}")) }
                }
            }
        }
    }

    private fun handleGridMeasured(cols: Int, rows: Int) {
        val safeCols = cols.coerceIn(TerminalEmulator.MIN_COLS, TerminalEmulator.MAX_COLS)
        val safeRows = rows.coerceIn(TerminalEmulator.MIN_ROWS, TerminalEmulator.MAX_ROWS)
        if (safeCols == lastCols && safeRows == lastRows) return
        lastCols = safeCols
        lastRows = safeRows
        emulator.resize(safeCols, safeRows)
        publishSnapshot()
        val session = state.value.session
        when {
            !connectStarted && session.loaded && session.active && session.supported -> beginConnect()
            state.value.status == TerminalStatus.Connected ->
                gateway.resize(terminalId, safeCols, safeRows)
            else -> Unit
        }
    }

    private fun handleRetry() {
        val session = state.value.session
        if (!session.loaded || !session.active || !session.supported || lastCols == null) return
        state.update { it.copy(status = TerminalStatus.Connecting, exitInfo = null) }
        if (gateway.isConnected) {
            // Socket still live (retry after terminal:exit): re-create directly.
            if (receivedOutput) {
                emulator.reset()
                receivedOutput = false
                publishSnapshot()
            }
            gateway.createTerminal(terminalId, lastCols!!, lastRows!!)
        } else {
            connectStarted = true
            gateway.connect()
        }
    }

    private fun handleFontStep(up: Boolean) {
        val ladder = TERMINAL_FONT_SIZES
        val index = ladder.indexOf(state.value.fontSizeSp).let { if (it < 0) ladder.indexOf(DEFAULT_FONT_SP) else it }
        val next = (index + if (up) 1 else -1)
        if (next !in ladder.indices) return
        val size = ladder[next]
        fontPrefs.save(size)
        state.update { it.copy(fontSizeSp = size) }
    }

    // -------------------------------------------------------------- helpers --

    private fun beginConnect() {
        connectStarted = true
        state.update { it.copy(status = TerminalStatus.Connecting, exitInfo = null) }
        gateway.connect()
    }

    private fun disconnectForGood() {
        closingByUser = true
        gateway.disconnect()
        closingByUser = false
        state.update { it.copy(status = TerminalStatus.Idle) }
    }

    private fun publishSnapshot() {
        state.update { it.copy(snapshot = emulator.snapshot()) }
    }

    private fun sanitizeFontSize(stored: Int?): Int =
        stored?.let { size -> TERMINAL_FONT_SIZES.firstOrNull { it == size } } ?: DEFAULT_FONT_SP

    private companion object {
        /** Web `useTerminalFontSize` ladder, in px there and sp here. */
        val TERMINAL_FONT_SIZES = intArrayOf(9, 11, 13, 15, 17)
        const val DEFAULT_FONT_SP = 13

        fun randomTerminalSuffix(): String =
            UUID.randomUUID().toString().replace("-", "").take(8)
    }
}
