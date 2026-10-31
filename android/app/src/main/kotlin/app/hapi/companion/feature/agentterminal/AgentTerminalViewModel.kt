package app.hapi.companion.feature.agentterminal

import app.hapi.companion.feature.terminal.TerminalEmulator
import app.hapi.companion.feature.terminal.TerminalSnapshot
import app.hapi.companion.feature.terminal.TerminalStatus
import app.hapi.data.store.SessionDetailStore
import app.hapi.protocol.wire.Session
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Why the agent-terminal panel is (or is not) available for this session
 * (web `canViewAgentTerminal`, plus the reason states the web gets for free by
 * unmounting the view — Android keeps the panel composed so the reason is
 * shown instead of the panel silently vanishing).
 */
enum class AgentTerminalGate {
    /** Detail not loaded yet — neither connect nor refuse. */
    LOADING,

    /** `metadata.startingMode !== 'pty'` — remote/SDK sessions have no agent PTY. */
    NOT_PTY,

    /** Archived/finished session — no live PTY and no buffer to replay. */
    INACTIVE,

    /** startingMode 'pty' + active: subscribing is authorized (namespace aside). */
    OK,
}

/** What [AgentTerminalPanel] renders. */
data class AgentTerminalUiState(
    val status: TerminalStatus = TerminalStatus.Idle,
    /**
     * Whether THIS viewer currently wants the stream (web `subscribedRef`).
     * Distinct from [status]: the socket may stay connected across hide/show
     * toggles while subscription (and the CLI's streaming) is off — the status
     * strip renders that combination as its idle indication.
     */
    val subscribed: Boolean = false,
    val gate: AgentTerminalGate = AgentTerminalGate.LOADING,
    val snapshot: TerminalSnapshot,
)

/**
 * Agent PTY panel state machine, the Android twin of
 * `useAgentTerminalSocket` + `AgentTerminalView`:
 *
 * - Gating mirrors web `canViewAgentTerminal` = `startingMode === 'pty' &&
 *   active`. A gate failure while the panel is open UNSUBSCRIBES and shows the
 *   reason (web unmounts the view; the hub itself refuses silently to avoid
 *   leaking session existence — see `isAuthorizedSession` in the hub handler).
 * - Connecting is lazy: the socket opens when the panel is first shown, not
 *   when the chat opens. Web mounts the view hidden for every PTY session and
 *   connects at mount; Android skips that idle per-chat websocket (declared
 *   deviation — subscribe/unsubscribe semantics are unchanged).
 * - `visible=true` ⇒ subscribe (+ resize so the TUI repaints at the viewer's
 *   size); `visible=false` ⇒ unsubscribe only, socket stays for instant
 *   resubscribe (web parity). Last viewer out makes the hub idle the CLI.
 * - Reconnects re-subscribe only while the viewer still wants the stream, and
 *   CLEAR the emulator first (clear-then-replay): the CLI's refresh replays
 *   its whole local buffer, which the still-alive web xterm shows duplicated —
 *   a web quirk deliberately not replicated (same stance as the slice-B user
 *   terminal).
 * - Resize follows the panel layout and is emitted only while connected AND
 *   visible (a hidden container never measures — web note: fit on
 *   display:none must not emit).
 */
class AgentTerminalViewModel(
    val sessionId: String,
    sessionStore: SessionDetailStore,
    gatewayFactory: (AgentTerminalEventListener) -> AgentTerminalGateway,
    private val scope: CoroutineScope,
) {
    private val gateway = gatewayFactory { event -> events.trySend(VmEvent.FromGateway(event)) }

    /** Web AgentTerminalView hardcodes fontSize 13 (deviation-free parity). */
    internal val fontSizeSp = AGENT_FONT_SP

    private val emulator = TerminalEmulator(
        initialCols = TerminalEmulator.DEFAULT_COLS,
        initialRows = AGENT_INITIAL_ROWS,
    )

    private sealed interface VmEvent {
        data class FromGateway(val event: AgentTerminalGatewayEvent) : VmEvent
        data class VisibleChanged(val visible: Boolean) : VmEvent
        data class GridMeasured(val cols: Int, val rows: Int) : VmEvent
        data class InputRequested(val data: String) : VmEvent
        data object RetryRequested : VmEvent
        data class DetailChanged(val session: Session?) : VmEvent
    }

    private val events = Channel<VmEvent>(Channel.UNLIMITED)

    private val state = MutableStateFlow(AgentTerminalUiState(snapshot = emulator.snapshot()))
    val uiState: StateFlow<AgentTerminalUiState> = state.asStateFlow()

    /** Web `subscribedRef`: the viewer wants the stream right now. */
    private var subscribedWanted = false

    /** True once any output landed — gates the pre-replay emulator reset. */
    private var receivedOutput = false

    /** Socket has been opened at least once (lazy connect, reset by gate stop). */
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
            sessionStore.sessionDetail(sessionId).collect { detail ->
                events.trySend(VmEvent.DetailChanged(detail))
            }
        }
        // The chat screen under this panel loads the detail anyway; fetch only
        // when nothing is cached (panel opened cold, e.g. process-death restore).
        if (sessionStore.currentDetail(sessionId) == null) {
            scope.launch {
                try {
                    sessionStore.loadSessionDetail(sessionId)
                } catch (expected: Exception) {
                    if (expected is CancellationException) throw expected
                    // Offline: the gate stays LOADING; retry by re-entering the panel.
                }
            }
        }
    }

    // ------------------------------------------------------------- UI inputs --

    /** Panel composed (true) / left composition (false) — drives subscription. */
    fun setVisible(visible: Boolean) {
        events.trySend(VmEvent.VisibleChanged(visible))
    }

    /** Measured grid (already clamped by the panel's char metrics). */
    fun onGridMeasured(cols: Int, rows: Int) {
        events.trySend(VmEvent.GridMeasured(cols, rows))
    }

    /** Raw keystroke sequence (quick keys, paste) → agent PTY. */
    fun sendInput(data: String) {
        events.trySend(VmEvent.InputRequested(data))
    }

    /** Error recovery after the socket client gave up (auth budget spent). */
    fun retry() {
        events.trySend(VmEvent.RetryRequested)
    }

    /**
     * Screen destroyed / session left for good: best-effort unsubscribe (the
     * socket-level disconnect also idles the stream server-side) then stop the
     * client. Synchronous on purpose — the holder cancels its scope right
     * after, which would strand a buffered channel event.
     */
    fun close() {
        closingByUser = true
        if (subscribedWanted) gateway.unsubscribe()
        subscribedWanted = false
        gateway.disconnect()
        closingByUser = false
        state.update { it.copy(status = TerminalStatus.Idle, subscribed = false) }
    }

    // --------------------------------------------------------------- session --

    private fun handleDetail(session: Session?) {
        val gate = when {
            session == null -> AgentTerminalGate.LOADING
            session.metadata?.startingMode != STARTING_MODE_PTY -> AgentTerminalGate.NOT_PTY
            !session.active -> AgentTerminalGate.INACTIVE
            else -> AgentTerminalGate.OK
        }
        state.update { it.copy(gate = gate) }
        when (gate) {
            AgentTerminalGate.OK ->
                // (Re)armed: connect if the viewer is waiting with the panel open.
                if (subscribedWanted && !connectStarted) beginConnect()
            else -> {
                // Web unmounts AgentTerminalView (→ unsubscribe + disconnect).
                // Android keeps the panel and shows the reason instead.
                if (connectStarted) stopForGate()
            }
        }
    }

    // ---------------------------------------------------------------- events --

    private fun handle(event: VmEvent) {
        when (event) {
            is VmEvent.FromGateway -> handleGateway(event.event)
            is VmEvent.VisibleChanged -> handleVisible(event.visible)
            is VmEvent.GridMeasured -> handleGridMeasured(event.cols, event.rows)
            is VmEvent.InputRequested -> handleInput(event.data)
            VmEvent.RetryRequested -> handleRetry()
            is VmEvent.DetailChanged -> handleDetail(event.session)
        }
    }

    private fun handleGateway(event: AgentTerminalGatewayEvent) {
        when (event) {
            AgentTerminalGatewayEvent.NamespaceConnected -> {
                if (closingByUser) return
                // Clear-then-replay: subscribe triggers a CLI repaint (or hub
                // buffer replay) of the WHOLE screen; resetting first avoids
                // duplicated content (known web quirk, not replicated).
                if (receivedOutput) {
                    emulator.reset()
                    receivedOutput = false
                    publishSnapshot()
                }
                state.update { it.copy(status = TerminalStatus.Connected) }
                if (subscribedWanted) {
                    gateway.subscribe()
                    state.update { it.copy(subscribed = true) }
                    // Repaint at the viewer's size right after (re)attaching —
                    // web sends this from its visible-effect rAF; the connected
                    // path covers the lazy first connect, where the visible
                    // effect fired while emits still dropped.
                    lastCols?.let { cols -> gateway.resize(cols, lastRows ?: AGENT_INITIAL_ROWS) }
                }
            }
            is AgentTerminalGatewayEvent.Output -> {
                // Web hook writes whatever 'agent' output arrives while the
                // socket is open — no subscribed check (post-unsubscribe
                // leftovers are a non-event: the hub already left us the room).
                receivedOutput = true
                emulator.write(event.data)
                publishSnapshot()
            }
            is AgentTerminalGatewayEvent.ConnectError ->
                state.update { it.copy(status = TerminalStatus.Error(event.message)) }
            is AgentTerminalGatewayEvent.Disconnected ->
                state.update {
                    it.copy(
                        status = if (closingByUser) {
                            TerminalStatus.Idle
                        } else {
                            TerminalStatus.Error("Disconnected: ${event.reason}")
                        },
                    )
                }
        }
    }

    private fun handleVisible(visible: Boolean) {
        if (visible == subscribedWanted) return
        subscribedWanted = visible
        val gate = state.value.gate
        if (visible) {
            // subscribed mirrors subscribedWanted in every visible branch —
            // including the connecting one, so the strip never flashes "idle"
            // between opening the panel and the namespace handshake.
            state.update { it.copy(subscribed = true) }
            when {
                gate != AgentTerminalGate.OK -> Unit // gate banner explains; no socket
                !connectStarted -> beginConnect()
                gateway.isConnected -> {
                    // Socket kept across hide/show: reset before the refresh
                    // replay (clear-then-replay), then rejoin the room.
                    if (receivedOutput) {
                        emulator.reset()
                        receivedOutput = false
                        publishSnapshot()
                    }
                    gateway.subscribe()
                    lastCols?.let { cols -> gateway.resize(cols, lastRows ?: AGENT_INITIAL_ROWS) }
                }
                else -> Unit // connecting; NamespaceConnected subscribes
            }
        } else {
            state.update { it.copy(subscribed = false) }
            if (gateway.isConnected) gateway.unsubscribe()
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
        // Emit only while live AND viewing: a hidden container must not push
        // resize (web note: fit on a display:none container emits nothing),
        // and the hub gates resize on session authorization, not subscription.
        if (gateway.isConnected && subscribedWanted) {
            gateway.resize(safeCols, safeRows)
        }
    }

    private fun handleInput(data: String) {
        // Web sendInput gates on socket.connected; the panel being hidden adds
        // the effective web gate (a display:none xterm has no focused input
        // surface, so nothing can send while unsubscribed).
        if (data.isEmpty() || !gateway.isConnected || !subscribedWanted) return
        if (state.value.gate != AgentTerminalGate.OK) return
        gateway.sendInput(data)
    }

    private fun handleRetry() {
        if (!subscribedWanted || state.value.gate != AgentTerminalGate.OK) return
        beginConnect()
    }

    // -------------------------------------------------------------- helpers --

    private fun beginConnect() {
        connectStarted = true
        state.update { it.copy(status = TerminalStatus.Connecting) }
        gateway.connect()
    }

    /** Gate dropped below OK mid-flight: mirror the web unmount cleanup. */
    private fun stopForGate() {
        closingByUser = true
        if (subscribedWanted && gateway.isConnected) gateway.unsubscribe()
        gateway.disconnect()
        closingByUser = false
        connectStarted = false
        receivedOutput = false
        emulator.reset()
        state.update {
            it.copy(status = TerminalStatus.Idle, subscribed = false, snapshot = emulator.snapshot())
        }
    }

    private fun publishSnapshot() {
        state.update { it.copy(snapshot = emulator.snapshot()) }
    }

    private companion object {
        /** Web `new Terminal({ cols: 80, rows: 12 })` initial geometry. */
        const val AGENT_INITIAL_ROWS = 12
        const val AGENT_FONT_SP = 13
        const val STARTING_MODE_PTY = "pty"
    }
}
