package app.hapi.companion.feature.terminal

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.withKeysDown
import androidx.compose.ui.input.key.Key
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
 * Device-level proof of the terminal stack (maintainer ask on PR #2187: "JVM
 * protocol tests alone cannot establish that the terminal is usable on
 * Android"): the REAL socket.io client, gateway, ViewModel, emulator and
 * Compose screen run on an emulator against a scripted fake hub — a local
 * loopback MockWebServer speaking engine.io v4 / socket.io v5 frames
 * (ws://127.0.0.1, permitted only by the debug network security config).
 *
 * Covers the three demonstrations requested: typing/Enter/Ctrl in a real TUI,
 * alternate-screen resize, and recovery after consecutive failed upgrades
 * plus token expiry.
 */
@OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)
class TerminalLoopbackDeviceTest {

    @get:Rule val compose = createComposeRule()

    private lateinit var server: MockWebServer
    private lateinit var vmScope: CoroutineScope
    private lateinit var wireScope: CoroutineScope
    private var vm: TerminalViewModel? = null

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        vmScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        wireScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }

    @After
    fun tearDown() {
        runCatching { vm?.close() }
        vmScope.cancel()
        wireScope.cancel()
        runCatching { server.shutdown() }
    }

    // ---------------------------------------------------------- fake hub --

    /** Scriptable server side of one socket.io /terminal connection. */
    private class ScriptedHub : okhttp3.WebSocketListener() {
        val received = ConcurrentLinkedQueue<String>()
        val sockets = ConcurrentLinkedQueue<WebSocket>()
        var onConnect: (WebSocket, token: String?) -> Unit = { _, _ -> }
        var onClientEvent: (event: String, frame: String) -> Unit = { _, _ -> }

        override fun onOpen(webSocket: WebSocket, response: Response) {
            sockets.add(webSocket)
            webSocket.send(SocketIoFrames.encodeOpen())
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            received.add(text)
            when {
                text.startsWith("40") -> onConnect(webSocket, tokenOf(text))
                text.startsWith("42") -> {
                    val event = eventOf(text)
                    if (event != null) onClientEvent(event, text)
                }
            }
        }

        fun current(): WebSocket = sockets.last()

        /** Every `terminal:write` data field concatenated in arrival order. */
        fun writtenData(): String {
            val json = Json { ignoreUnknownKeys = true }
            val builder = StringBuilder()
            received.forEach { frame ->
                if (!frame.startsWith("42") || !frame.contains("terminal:write")) return@forEach
                val payload = frame.substringAfter(",[", "").substringBefore("]")
                runCatching {
                    val args = json.parseToJsonElement("[$payload]").jsonArray
                    val data = args.getOrNull(1)?.jsonObject?.get("data")?.jsonPrimitive?.content
                    if (data != null) builder.append(data)
                }
            }
            return builder.toString()
        }

        private fun tokenOf(connectFrame: String): String? =
            Regex("\"token\":\"([^\"]+)\"").find(connectFrame)?.groupValues?.get(1)

        private fun eventOf(frame: String): String? =
            Regex("\\[\"([^\"]+)\"").find(frame)?.groupValues?.get(1)
    }

    private fun upgrade(hub: ScriptedHub): MockResponse = MockResponse().withWebSocketUpgrade(hub)

    private fun sendOutput(hub: ScriptedHub, terminalId: String, data: String) {
        hub.current().send(
            SocketIoFrames.encodeServerEvent(
                "/terminal",
                "terminal:output",
                kotlinx.serialization.json.buildJsonObject {
                    put("terminalId", terminalId)
                    put("data", data)
                },
            ),
        )
    }

    private fun terminalIdOf(frame: String): String =
        Regex("\"terminalId\":\"([^\"]+)\"").find(frame)?.groupValues?.get(1)
            ?: error("no terminalId in frame: $frame")

    private fun awaitTextDisplayed(text: String, timeout: Long = 10_000) {
        compose.waitUntil(timeoutMillis = timeout) {
            compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty()
        }
    }

    // ------------------------------------------------------------- tests --

    @Test
    fun directModeTypingEnterAndCtrlReachARealTuiOnDevice() {
        val hub = ScriptedHub()
        server.enqueue(upgrade(hub))
        var scriptedTerminalId: String? = null
        hub.onConnect = { socket, _ -> socket.send(SocketIoFrames.decodeConnectAck("/terminal")) }
        hub.onClientEvent = { event, frame ->
            if (event == "terminal:create") {
                val id = terminalIdOf(frame)
                scriptedTerminalId = id
                hub.current().send(
                    SocketIoFrames.encodeServerEvent(
                        "/terminal",
                        "terminal:ready",
                        kotlinx.serialization.json.buildJsonObject { put("terminalId", id) },
                    ),
                )
                // A minimal "TUI" prompt: proves output flows hub → client →
                // emulator → Compose rendering.
                sendOutput(hub, id, "TUI-READY> ")
            }
        }

        val viewModel = terminalViewModel(hubBaseUrl = server.url("/").toString(), tokens = listOf("jwt"))
        compose.setContent { HapiTheme { TerminalScreen(viewModel, onBack = {}) } }

        awaitTextDisplayed("TUI-READY>")

        // Direct mode: real IME target.
        compose.onNodeWithText("Direct").performClick()
        val inputTarget = compose.onNodeWithText("Type here — keys go straight to the terminal")
        inputTarget.performClick()
        inputTarget.performTextInput("diag")
        compose.waitUntil(10_000) { hub.writtenData().contains("diag") }

        // Hardware Enter through the preview-key interception: CR on the wire.
        inputTarget.performKeyInput { pressKey(Key.Enter) }
        compose.waitUntil(10_000) { hub.writtenData().contains("diag\r") }

        // Hardware Ctrl+C: ETX (control code 3) on the wire.
        inputTarget.performKeyInput {
            withKeysDown(listOf(Key.CtrlRight)) { pressKey(Key.C) }
        }
        compose.waitUntil(10_000) { hub.writtenData().contains("diag\r\u0003") }

        assertTrue("terminal:create was never sent", scriptedTerminalId != null)
    }

    @Test
    fun alternateScreenSurvivesFontStepResizeOnDevice() {
        val hub = ScriptedHub()
        server.enqueue(upgrade(hub))
        hub.onConnect = { socket, _ -> socket.send(SocketIoFrames.decodeConnectAck("/terminal")) }
        var createCols: Int? = null
        hub.onClientEvent = { event, frame ->
            if (event == "terminal:create") {
                val id = terminalIdOf(frame)
                createCols = Regex("\"cols\":(\\d+)").find(frame)?.groupValues?.get(1)?.toInt()
                hub.current().send(
                    SocketIoFrames.encodeServerEvent(
                        "/terminal",
                        "terminal:ready",
                        kotlinx.serialization.json.buildJsonObject { put("terminalId", id) },
                    ),
                )
                // Enter the alternate screen (like vim/htop) and paint a mark.
                sendOutput(hub, id, "\u001B[?1049hALT-LIVE-MARK")
            }
        }

        val viewModel = terminalViewModel(hubBaseUrl = server.url("/").toString(), tokens = listOf("jwt"))
        compose.setContent { HapiTheme { TerminalScreen(viewModel, onBack = {}) } }

        awaitTextDisplayed("ALT-LIVE-MARK")

        // A+ grows the cell size: the grid re-derives cols/rows and the real
        // resize emit must cross the wire.
        compose.onNodeWithText("A+").performClick()
        compose.waitUntil(10_000) { hub.received.any { it.contains("terminal:resize") } }

        // Item under test: the alt buffer resized with its content kept (no
        // blank flash / cleared TUI) — the mark stays rendered.
        awaitTextDisplayed("ALT-LIVE-MARK")
        val create = createCols
        val resize = Regex("\"cols\":(\\d+)")
            .find(hub.received.first { it.contains("terminal:resize") })
            ?.groupValues?.get(1)?.toInt()
        assertTrue("create frame never carried cols", create != null)
        assertTrue(
            "resize cols $resize should be smaller than create cols $create (bigger font)",
            resize != null && resize < create!!,
        )
    }

    @Test
    fun recoversAfterFailedUpgradesAndExpiredTokenOnDevice() {
        // Consecutive failed upgrades (plain 502 — no WebSocket at all), then
        // an auth rejection for a stale JWT, then a healthy socket.
        server.enqueue(MockResponse().setResponseCode(502))
        val rejectHub = ScriptedHub()
        server.enqueue(upgrade(rejectHub))
        val okHub = ScriptedHub()
        server.enqueue(upgrade(okHub))

        rejectHub.onConnect = { socket, _ ->
            socket.send(SocketIoFrames.encodeConnectError("/terminal", "Invalid token"))
        }
        okHub.onConnect = { socket, token ->
            if (token == "fresh-jwt") socket.send(SocketIoFrames.decodeConnectAck("/terminal"))
            else socket.send(SocketIoFrames.encodeConnectError("/terminal", "Invalid token"))
        }
        okHub.onClientEvent = { event, frame ->
            if (event == "terminal:create") {
                val id = terminalIdOf(frame)
                okHub.current().send(
                    SocketIoFrames.encodeServerEvent(
                        "/terminal",
                        "terminal:ready",
                        kotlinx.serialization.json.buildJsonObject { put("terminalId", id) },
                    ),
                )
                sendOutput(okHub, id, "RECOVERED> ")
            }
        }

        // Per-attempt tokens: attempt 1 burns one on the 502, attempt 2
        // presents the stale JWT, attempt 3 the fresh one.
        val tokens = ConcurrentLinkedQueue(listOf("burned-on-502", "stale-jwt", "fresh-jwt"))
        val viewModel = terminalViewModel(
            hubBaseUrl = server.url("/").toString(),
            tokens = null,
            tokenProvider = { tokens.poll() ?: "fresh-jwt" },
        )
        compose.setContent { HapiTheme { TerminalScreen(viewModel, onBack = {}) } }

        awaitTextDisplayed("RECOVERED>")

        assertTrue(
            "expected at least 3 transport attempts, got ${server.requestCount}",
            server.requestCount >= 3,
        )
        assertTrue(
            "healthy socket never saw the fresh token",
            okHub.received.any { it.startsWith("40") && it.contains("fresh-jwt") },
        )
    }

    // ------------------------------------------------------------ fixtures --

    private fun terminalViewModel(
        hubBaseUrl: String,
        tokens: List<String>? = null,
        tokenProvider: (suspend () -> String?)? = null,
    ): TerminalViewModel {
        vm = TerminalViewModel(
            sessionId = SESSION_ID,
            sessionStore = FakeDeviceSessionStore().apply { setDetail(activeSession()) },
            gatewayFactory = { listener ->
                SocketIoTerminalGateway(
                    baseUrl = hubBaseUrl,
                    sessionId = SESSION_ID,
                    tokenProvider = tokenProvider ?: { tokens!!.first() },
                    listener = listener,
                    scope = wireScope,
                    backoffFirstMs = 50,
                    backoffMaxMs = 50,
                )
            },
            fontPrefs = TerminalFontPrefs.NOOP,
            scope = vmScope,
        )
        return vm!!
    }

    private fun activeSession(): Session = Session(
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
        ),
        metadataVersion = 1,
        agentStateVersion = 1,
        thinking = false,
        thinkingAt = 0,
    )

    private companion object {
        const val SESSION_ID = "sess-device"
    }
}

/** Same fake as the JVM ViewModel tests, duplicated for the device classpath. */
private class FakeDeviceSessionStore : SessionDetailStore {
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
