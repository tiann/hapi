package app.hapi.companion.feature.agentterminal

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import app.hapi.companion.feature.terminal.SocketIoFrames
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.data.sse.SseSubscriptionKey
import app.hapi.data.store.SessionDetailStore
import app.hapi.protocol.wire.ReopenSessionResponse
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionCapabilities
import app.hapi.protocol.wire.SessionMetadata
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SyncEvent
import java.util.concurrent.ConcurrentLinkedQueue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/**
 * Device-level proof of the agent PTY panel (maintainer ask on PR #2188: "a
 * Compose/device test should type into the PTY and confirm a TUI selection"):
 * the REAL socket.io client, agent-terminal gateway, ViewModel, emulator and
 * Compose panel run on an emulator against a scripted fake hub — a loopback
 * MockWebServer speaking engine.io v4 / socket.io v5 frames, with a tiny TUI
 * menu (a line discipline over `agent-terminal:input`) that moves its
 * selection marker when the submitted line matches an entry.
 *
 * Same strategy as TerminalLoopbackDeviceTest (#2187), on the agent-terminal
 * event family: subscribe paints the menu, typed text + hardware Backspace +
 * hardware Enter cross the wire as bytes (IME delta, DEL 0x7F, CR), and the
 * repaint with the moved marker must render in the grid.
 */
@OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)
class AgentTerminalLoopbackDeviceTest {

    @get:Rule val compose = createComposeRule()

    private lateinit var server: MockWebServer
    private lateinit var vmScope: CoroutineScope
    private lateinit var wireScope: CoroutineScope

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        vmScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        wireScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }

    @After
    fun tearDown() {
        vmScope.cancel()
        wireScope.cancel()
        runCatching { server.shutdown() }
    }

    // ---------------------------------------------------------- fake hub --

    /**
     * Scriptable server side of one socket.io /terminal connection carrying
     * the agent-terminal event family, plus the TUI being driven: a two-entry
     * menu whose `> ` selection marker starts on "red" and moves to "blue"
     * when the submitted line is exactly "blue".
     */
    private class ScriptedAgentHub : okhttp3.WebSocketListener() {
        val received = ConcurrentLinkedQueue<String>()
        val sockets = ConcurrentLinkedQueue<WebSocket>()
        var onConnect: (WebSocket, token: String?) -> Unit = { _, _ -> }
        private val line = StringBuilder()

        override fun onOpen(webSocket: WebSocket, response: Response) {
            sockets.add(webSocket)
            webSocket.send(SocketIoFrames.encodeOpen())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            received.add(text)
            when {
                text.startsWith("40") -> onConnect(webSocket, tokenOf(text))
                text.startsWith("42") -> {
                    when (eventOf(text)) {
                        "agent-terminal:subscribe" ->
                            webSocket.send(paintMenu(selected = RED))
                        "agent-terminal:input" -> lineDiscipline(dataOf(text), webSocket)
                    }
                }
            }
        }

        /** PTY-side line editor: printable append, DEL erases, CR submits. */
        private fun lineDiscipline(data: String, socket: WebSocket) {
            data.forEach { ch ->
                when (ch) {
                    '\r' -> {
                        val submitted = line.toString()
                        line.setLength(0)
                        if (submitted == BLUE) socket.send(paintMenu(selected = BLUE))
                    }
                    '\u007F' -> if (line.isNotEmpty()) line.setLength(line.length - 1)
                    else -> line.append(ch)
                }
            }
        }

        fun paintMenu(selected: String): String = SocketIoFrames.encodeServerEvent(
            "/terminal",
            "agent-terminal:output",
            buildJsonObject {
                put("terminalId", "agent")
                put("data", "\u001b[H\u001b[JCHOOSE:\r\n" + row("red", selected) + "\r\n" + row("blue", selected))
            },
        )

        private fun row(entry: String, selected: String): String =
            if (entry == selected) "> $entry" else "  $entry"

        /** Every `agent-terminal:input` data field concatenated in arrival order. */
        fun typedData(): String {
            val json = Json { ignoreUnknownKeys = true }
            val builder = StringBuilder()
            received.forEach { frame ->
                if (!frame.startsWith("42") || !frame.contains("agent-terminal:input")) return@forEach
                runCatching { builder.append(dataOf(frame, json)) }
            }
            return builder.toString()
        }

        private fun tokenOf(connectFrame: String): String? =
            Regex("\"token\":\"([^\"]+)\"").find(connectFrame)?.groupValues?.get(1)

        private fun eventOf(frame: String): String? =
            Regex("\\[\"([^\"]+)\"").find(frame)?.groupValues?.get(1)

        private fun dataOf(frame: String, json: Json = Json { ignoreUnknownKeys = true }): String {
            val payload = frame.substringAfter(",[", "").substringBefore("]")
            val args = json.parseToJsonElement("[$payload]").jsonArray
            return args.getOrNull(1)?.jsonObject?.get("data")?.jsonPrimitive?.content
                ?: error("no data in frame: $frame")
        }

        private companion object {
            const val RED = "red"
            const val BLUE = "blue"
        }
    }

    private fun awaitTextDisplayed(text: String, timeout: Long = 10_000) {
        compose.waitUntil(timeoutMillis = timeout) {
            compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
        }
    }

    // ------------------------------------------------------------- tests --

    @Test
    fun typingIntoThePanelSelectsATuiEntryOnDevice() {
        val hub = ScriptedAgentHub()
        server.enqueue(MockResponse().withWebSocketUpgrade(hub))
        hub.onConnect = { socket, _ -> socket.send(SocketIoFrames.decodeConnectAck("/terminal")) }

        val viewModel = AgentTerminalViewModel(
            sessionId = SESSION_ID,
            sessionStore = FakeAgentDeviceSessionStore().apply { setDetail(ptySession()) },
            gatewayFactory = { listener ->
                SocketIoAgentTerminalGateway(
                    baseUrl = server.url("/").toString(),
                    sessionId = SESSION_ID,
                    tokenProvider = { "jwt" },
                    listener = listener,
                    scope = wireScope,
                )
            },
            scope = vmScope,
        )
        compose.setContent { HapiTheme { AgentTerminalPanel(viewModel, onHide = {}) } }

        // Subscribe painted the TUI with the selection on "red".
        awaitTextDisplayed("CHOOSE:")
        awaitTextDisplayed("> red")

        // The IME/hardware-key target: type, hardware Backspace (DEL byte),
        // retype, hardware Enter (CR) — raw keystrokes into the agent PTY.
        val inputTarget = compose.onNodeWithText("Type here — keys go straight to the terminal")
        inputTarget.performClick()
        inputTarget.performTextInput("blu")
        inputTarget.performKeyInput { pressKey(Key.Backspace) }
        inputTarget.performTextInput("ue")
        inputTarget.performKeyInput { pressKey(Key.Enter) }

        // Wire proof: typed delta + DEL (0x7F, the Backspace) + trailing CR.
        compose.waitUntil(10_000) { hub.typedData().contains("blu\u007Fue\r") }

        // TUI proof: the hub moved the selection marker to "blue" and the
        // panel renders the repainted menu — "> red" is gone.
        awaitTextDisplayed("> blue")
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("> red", substring = true).fetchSemanticsNodes().isEmpty()
        }
        assertTrue(
            "expected typed bytes on the wire, got ${hub.typedData().map { it.code }}",
            hub.typedData().contains("blu\u007Fue\r"),
        )
    }

    // ------------------------------------------------------------ fixtures --

    private fun ptySession(): Session = Session(
        id = SESSION_ID,
        namespace = "default",
        seq = 1,
        createdAt = 1,
        updatedAt = 1,
        active = true,
        metadata = SessionMetadata(
            path = "/repo",
            host = "device",
            capabilities = SessionCapabilities(terminal = true),
            startingMode = "pty",
        ),
        metadataVersion = 1,
        agentStateVersion = 1,
        thinking = false,
        thinkingAt = 0,
    )

    private companion object {
        const val SESSION_ID = "sess-agent-device"
    }
}

/** Same fake as the JVM ViewModel tests, duplicated for the device classpath. */
private class FakeAgentDeviceSessionStore : SessionDetailStore {
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
    override suspend fun reopenSession(sessionId: String): ReopenSessionResponse =
        ReopenSessionResponse(sessionId = sessionId, resumed = true)
}
