package app.hapi.companion.feature.terminal

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * Events surfaced by [SocketIoClient], in callback order. All callbacks run on
 * the client's reader coroutine (single sequential context), so a listener can
 * reason about ordering without its own locking.
 */
interface SocketIoListener {
    /** engine.io handshake completed (not yet namespace-connected). */
    fun onEngineOpen() {}

    /** The namespace CONNECT handshake succeeded (socket.io "connect"). */
    fun onNamespaceConnected(namespace: String) {}

    /** Namespace handshake rejected — [message] comes from the hub middleware. */
    fun onNamespaceConnectError(namespace: String, message: String) {}

    /** A socket.io event arrived on [namespace]. */
    fun onEvent(namespace: String, event: String, args: JsonObject?) {}

    /** Transport dropped after having been open; [reason] is diagnostic text. */
    fun onDisconnected(reason: String) {}
}

/**
 * Minimal socket.io v5 client over engine.io v4, WebSocket-only direct
 * connect (no HTTP long-polling / upgrade dance), built on the OkHttp client
 * already shipped by :core:data — zero new dependencies. It speaks exactly
 * what the hub's `@socket.io/bun-engine` (engine.io protocol 4, `EIO=4`) +
 * socket.io 4.8 server speaks, and nothing more:
 *
 * - URL `{base}/socket.io/?EIO=4&transport=websocket`; the first WebSocket
 *   upgrade carries no `sid` — the server's `0{json}` OPEN packet supplies it.
 * - engine.io packets: `0` open (sid/pingInterval/pingTimeout), `1` close,
 *   `2` ping → answered with `3` pong, `4` message envelope.
 * - socket.io packets inside `4`: `40<ns>,{auth}` CONNECT (client→server,
 *   carrying the JWT in `auth.token` the `/terminal` middleware verifies),
 *   `40<ns>` CONNECT ack (server→client), `44<ns>,{message}` CONNECT_ERROR,
 *   `42<ns>,["event",payload]` EVENT both ways. All terminal traffic is
 *   fire-and-forget — no ACKs (`41`/`45`) exist on this namespace.
 *
 * Reconnect policy: any transport loss (socket closed, IO failure, watchdog
 * timeout without server pings) retries forever with capped exponential
 * backoff; every attempt re-invokes [tokenProvider] so an expired JWT
 * self-heals. Loss bookkeeping is per attempt: [openSocket] re-arms the loss
 * latch and supersedes the previous socket, so failures during the connect
 * phase (refused socket, HTTP error) also schedule the next attempt — engine
 * OPEN never fires there — and late close events from a superseded attempt
 * cannot schedule a rogue one. Namespace CONNECT_ERROR counts against
 * [maxAuthRetries] because auth rejection is deterministic per token: after
 * that many attempts the client stops and reports
 * [SocketIoListener.onDisconnected], letting the UI own the retry. Below that
 * budget the retry is scheduled directly from the CONNECT_ERROR handler — the
 * hub (socket.io v4 middleware-error semantics) keeps the transport open
 * after rejecting auth, so waiting for our own close handshake to complete
 * would tie retry liveness to peer behavior. This mirrors the web hook's
 * behavior (error state + explicit retry) rather than the JS client's silent
 * infinite auth retry loop.
 *
 * Thread model: OkHttp callbacks are funneled through an unbounded channel to
 * the reader coroutine; [connect]/[disconnect]/[emit] are safe from any thread.
 */
class SocketIoClient(
    private val baseUrl: String,
    private val namespace: String,
    private val tokenProvider: suspend () -> String?,
    private val listener: SocketIoListener,
    private val scope: CoroutineScope,
    private val httpClient: OkHttpClient = defaultHttpClient(),
    private val backoffFirstMs: Long = 1_000,
    private val backoffMaxMs: Long = 5_000,
    private val maxAuthRetries: Int = 3,
) {
    private val json = Json { ignoreUnknownKeys = true }

    private sealed interface WireEvent {
        data object Opened : WireEvent
        data class Text(val frame: String) : WireEvent
        data class Closed(val code: Int, val reason: String, val socket: WebSocket) : WireEvent
        data class Failure(val throwable: Throwable, val socket: WebSocket) : WireEvent
    }

    private val wire = Channel<WireEvent>(Channel.UNLIMITED)
    private var readerJob: Job? = null
    private var attemptJob: Job? = null
    private var watchdogJob: Job? = null

    /** Current attempt's socket; [WireEvent]s from any other socket are stale. */
    @Volatile private var webSocket: WebSocket? = null

    private val closedByUser = AtomicBoolean(false)
    private val givenUp = AtomicBoolean(false)
    private val everOpened = AtomicBoolean(false)
    private val transportLostHandled = AtomicBoolean(false)
    @Volatile private var namespaceConnected = false
    @Volatile private var webSocketOpen = false
    private var reconnectAttempt = 0
    private var authFailures = 0

    @Volatile private var lastActivityMs: Long = 0
    @Volatile private var pingWindowMs: Long = DEFAULT_PING_INTERVAL_MS + DEFAULT_PING_TIMEOUT_MS

    /** Starts connecting (idempotent: a running client ignores this). */
    @Synchronized
    fun connect() {
        closedByUser.set(false)
        givenUp.set(false)
        authFailures = 0
        if (readerJob?.isActive == true && attemptJob?.isActive == true) return
        startReaderIfNeeded()
        scheduleAttempt(0)
    }

    /** Stops the client for good: closes the socket and stops all retries. */
    @Synchronized
    fun disconnect() {
        closedByUser.set(true)
        attemptJob?.cancel()
        attemptJob = null
        watchdogJob?.cancel()
        watchdogJob = null
        readerJob?.cancel()
        readerJob = null
        webSocket?.close(NORMAL_CLOSE_CODE, "client disconnect")
        webSocket = null
        namespaceConnected = false
        webSocketOpen = false
    }

    /**
     * Fire-and-forget emit: dropped (not queued) while the namespace is not
     * connected — matching the web client's `if (!socket.connected) return`
     * semantics for terminal writes.
     */
    fun emit(event: String, payload: JsonObject? = null) {
        if (!namespaceConnected) return
        val frame = SocketIoFrames.encodeEvent(namespace, event, payload)
        webSocket?.send(frame)
    }

    /** True while the namespace CONNECT handshake is complete (emit gate). */
    val isNamespaceConnected: Boolean
        get() = namespaceConnected

    // ------------------------------------------------------------ attempts --

    @Synchronized
    private fun scheduleAttempt(delayMs: Long) {
        attemptJob?.cancel()
        attemptJob = scope.launch {
            if (delayMs > 0) delay(delayMs)
            openSocket()
        }
    }

    private suspend fun openSocket() {
        val token = runCatching { tokenProvider() }.getOrNull()
        synchronized(this) {
            if (closedByUser.get() || givenUp.get()) return
            // Per-attempt loss bookkeeping: this attempt re-arms the loss
            // latch and supersedes the previous socket. Resetting only in
            // onOpen left the latch consumed after a connect-phase failure
            // (engine OPEN never fires there), stalling the retry loop after
            // one refused socket / HTTP error.
            transportLostHandled.set(false)
            pendingAuthToken = token
            webSocket = httpClient.newWebSocket(
                Request.Builder().url(SocketIoFrames.websocketUrl(baseUrl)).build(),
                wireListener,
            )
        }
    }

    @Volatile private var pendingAuthToken: String? = null

    private val wireListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            wire.trySend(WireEvent.Opened)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            wire.trySend(WireEvent.Text(text))
        }

        /**
         * Server-initiated close: OkHttp hands us the close frame and waits
         * for the app to complete the handshake — without [WebSocket.close]
         * here, [onClosed] would only arrive after the linger timeout.
         */
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(NORMAL_CLOSE_CODE, null)
            wire.trySend(WireEvent.Closed(code, reason, webSocket))
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            wire.trySend(WireEvent.Closed(code, reason, webSocket))
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            wire.trySend(WireEvent.Failure(t, webSocket))
        }
    }

    private fun startReaderIfNeeded() {
        if (readerJob?.isActive == true) return
        readerJob = scope.launch {
            for (event in wire) {
                runCatching { handleWireEvent(event) }
            }
        }
    }

    // ----------------------------------------------------------- protocol --

    private fun handleWireEvent(event: WireEvent) {
        when (event) {
            WireEvent.Opened -> {
                if (closedByUser.get() || givenUp.get()) return
                everOpened.set(true)
                webSocketOpen = true
                lastActivityMs = nowMs()
                listener.onEngineOpen()
                val token = pendingAuthToken
                webSocket?.send(SocketIoFrames.encodeConnect(namespace, token))
            }
            is WireEvent.Text -> {
                lastActivityMs = nowMs()
                handleEnginePacket(event.frame)
            }
            is WireEvent.Closed -> handleTransportLost("closed (${event.code} ${event.reason})", event.socket)
            is WireEvent.Failure -> handleTransportLost("error (${event.throwable.message ?: "io"})", event.socket)
        }
    }

    private fun handleEnginePacket(frame: String) {
        when (frame.firstOrNull()) {
            '0' -> handleOpenPacket(frame)
            '1' -> webSocket?.let { handleTransportLost("server closed", it) }
            '2' -> webSocket?.send(SocketIoFrames.PONG)
            '4' -> handleSocketIoPacket(frame.substring(1))
            else -> Unit // Unknown engine packet type: ignore.
        }
    }

    private fun handleOpenPacket(frame: String) {
        val payload = runCatching { json.parseToJsonElement(frame.substring(1)).jsonObject }.getOrNull() ?: return
        val interval = payload["pingInterval"]?.jsonPrimitive?.content?.toLongOrNull()
        val timeout = payload["pingTimeout"]?.jsonPrimitive?.content?.toLongOrNull()
        pingWindowMs = ((interval ?: DEFAULT_PING_INTERVAL_MS) + (timeout ?: DEFAULT_PING_TIMEOUT_MS))
            .coerceAtLeast(MIN_PING_WINDOW_MS)
        startWatchdog()
    }

    private fun startWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = scope.launch {
            while (true) {
                delay(pingWindowMs)
                val idle = nowMs() - lastActivityMs
                if (idle > pingWindowMs) {
                    // Server stopped pinging: treat as a dead transport and let
                    // the reconnect path take over.
                    webSocket?.close(NORMAL_CLOSE_CODE, "ping timeout")
                    return@launch
                }
            }
        }
    }

    /**
     * socket.io packet with the engine.io `4` envelope already stripped: the
     * first char is the packet type (0 CONNECT, 2 EVENT, 4 CONNECT_ERROR),
     * followed by the namespace, then an optional `,payload`.
     */
    private fun handleSocketIoPacket(sio: String) {
        val type = sio.firstOrNull() ?: return
        val rest = sio.substring(1)
        when (type) {
            '0' -> {
                // CONNECT ack for our namespace.
                val nsPart = if (rest.startsWith(namespace)) rest.substring(namespace.length) else rest
                if (nsPart.isEmpty() || nsPart.startsWith(",")) {
                    namespaceConnected = true
                    reconnectAttempt = 0
                    listener.onNamespaceConnected(namespace)
                }
            }
            '4' -> {
                // CONNECT_ERROR: `4` + `4` on the wire, `44<ns>,{message}` total.
                val nsPart = if (rest.startsWith(namespace)) rest.substring(namespace.length) else rest
                val message = if (nsPart.startsWith(",")) {
                    runCatching {
                        json.parseToJsonElement(nsPart.substring(1)).jsonObject["message"]
                            ?.jsonPrimitive?.content
                    }.getOrNull()
                } else {
                    null
                } ?: "Connection error"
                namespaceConnected = false
                listener.onNamespaceConnectError(namespace, message)
                authFailures++
                if (authFailures > maxAuthRetries) {
                    // Auth rejection is deterministic per token: stop retrying
                    // and leave the retry decision to the UI.
                    givenUp.set(true)
                    stopRetries()
                    watchdogJob?.cancel()
                    webSocket?.close(NORMAL_CLOSE_CODE, "connect_error")
                    listener.onDisconnected("connect_error: $message")
                } else {
                    // Retry with a freshly provided token. The retry is
                    // scheduled here rather than via this socket's transport
                    // -close event: the hub keeps the transport open after a
                    // middleware rejection (socket.io v4 semantics), so
                    // waiting for our own close handshake would tie retry
                    // liveness to peer behavior. The armed loss latch plus
                    // the stale-socket guard make the late close events
                    // no-ops.
                    namespaceConnected = false
                    webSocketOpen = false
                    watchdogJob?.cancel()
                    transportLostHandled.set(true)
                    scheduleAttempt(nextBackoff())
                    webSocket?.close(NORMAL_CLOSE_CODE, "connect_error")
                }
            }
            '2' -> {
                // EVENT: `2` + `<ns>,["event",payload]`.
                if (!rest.startsWith(namespace)) return
                val argsJson = rest.substring(namespace.length)
                if (!argsJson.startsWith(",")) return
                val array = runCatching { json.parseToJsonElement(argsJson.substring(1)).jsonArray }.getOrNull() ?: return
                val event = array.firstOrNull()?.jsonPrimitive?.content ?: return
                val args = array.getOrNull(1) as? JsonObject
                listener.onEvent(namespace, event, args)
            }
            else -> Unit // ACKs and other packet types never occur on this namespace.
        }
    }

    private fun handleTransportLost(reason: String, socket: WebSocket) {
        if (closedByUser.get() || givenUp.get()) return
        // Events from a superseded attempt's socket must not be mistaken for
        // the current attempt dying (that would schedule a rogue attempt
        // while the current one is still connecting).
        if (socket !== webSocket) return
        // onClosing and the completed-close onClosed can both fire for one
        // loss; only the first schedules the reconnect.
        if (!transportLostHandled.compareAndSet(false, true)) return
        val wasOpen = webSocketOpen || namespaceConnected
        webSocketOpen = false
        namespaceConnected = false
        watchdogJob?.cancel()
        if (everOpened.get() && wasOpen) listener.onDisconnected(reason)
        scheduleAttempt(nextBackoff())
    }

    /** Caps exponential backoff at [backoffMaxMs]; caller retries forever. */
    private fun nextBackoff(): Long {
        val backoff = (backoffFirstMs shl reconnectAttempt.coerceAtMost(10)).coerceAtMost(backoffMaxMs)
        reconnectAttempt++
        return backoff
    }

    @Synchronized
    private fun stopRetries() {
        attemptJob?.cancel()
        attemptJob = null
    }

    /** Injectable for tests; wall clock is right for watchdog math. */
    internal var nowMs: () -> Long = { System.currentTimeMillis() }

    private companion object {
        const val NORMAL_CLOSE_CODE = 1000
        const val DEFAULT_PING_INTERVAL_MS = 25_000L
        const val DEFAULT_PING_TIMEOUT_MS = 20_000L
        const val MIN_PING_WINDOW_MS = 1_000L
    }
}

/**
 * engine.io v4 / socket.io v5 wire codec. Kept as pure functions so the frame
 * layer is unit-testable without any socket (the client tests below add
 * MockWebServer coverage for the real round-trip).
 */
internal object SocketIoFrames {
    const val PONG = "3"

    /** `https?://host[:port]` → `wss?://host[:port]/socket.io/?EIO=4&transport=websocket`. */
    fun websocketUrl(baseUrl: String): String {
        val trimmed = baseUrl.trimEnd('/')
        val wsScheme = when {
            trimmed.startsWith("https://", ignoreCase = true) -> "wss://" + trimmed.substring("https://".length)
            trimmed.startsWith("http://", ignoreCase = true) -> "ws://" + trimmed.substring("http://".length)
            trimmed.startsWith("wss://", ignoreCase = true) -> trimmed
            trimmed.startsWith("ws://", ignoreCase = true) -> trimmed
            else -> "wss://$trimmed"
        }
        return "$wsScheme/socket.io/?EIO=4&transport=websocket"
    }

    /** socket.io CONNECT: `40<ns>,{"token":…}` (no auth object without a token). */
    fun encodeConnect(namespace: String, token: String?): String {
        val ns = if (namespace.isEmpty()) "" else namespace
        if (token == null) return "40$ns"
        val auth = buildJsonObject { put("token", token) }.toString()
        return "40$ns,$auth"
    }

    /** socket.io EVENT: `42<ns>,["<event>"{,<payload>}]`. */
    fun encodeEvent(namespace: String, event: String, payload: JsonObject?): String {
        val args = if (payload == null) "\"$event\"" else "\"$event\",$payload"
        return "42$namespace,[$args]"
    }

    /** server CONNECT ack: `40` or `40<ns>[,…]`. */
    fun decodeConnectAck(namespace: String): String = if (namespace.isEmpty()) "40" else "40$namespace"

    /** server CONNECT_ERROR: `44<ns>,{"message":…}`. */
    fun encodeConnectError(namespace: String, message: String): String {
        val payload = buildJsonObject { put("message", message) }.toString()
        val ns = if (namespace.isEmpty()) "" else namespace
        return "44$ns,$payload"
    }

    /** server EVENT frame helper for tests. */
    fun encodeServerEvent(namespace: String, event: String, payload: JsonObject?): String =
        encodeEvent(namespace, event, payload)

    /** engine.io OPEN packet with the handshake fields the client reads. */
    fun encodeOpen(sid: String = "test-sid", pingIntervalMs: Long = 25_000, pingTimeoutMs: Long = 20_000): String {
        val payload = buildJsonObject {
            put("sid", sid)
            put("upgrades", kotlinx.serialization.json.JsonArray(emptyList()))
            put("pingInterval", pingIntervalMs)
            put("pingTimeout", pingTimeoutMs)
            put("maxPayload", 1_000_000)
        }
        return "0$payload"
    }
}

/** Read timeouts must not apply to a WebSocket; only the connect phase. */
private fun defaultHttpClient(): OkHttpClient =
    OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .pingInterval(0, TimeUnit.MILLISECONDS)
        .build()
