package app.hapi.companion.feature.terminal

import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.WebSocket
import okhttp3.Response

/**
 * Frame-layer tests for the minimal socket.io v5 client: pure codec cases
 * plus real WebSocket round-trips against MockWebServer (same style as the
 * :core:data SSE transport tests — real IO inside runBlocking/withTimeout).
 */
class SocketIoClientTest {

    private lateinit var server: MockWebServer
    private lateinit var scope: CoroutineScope

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    }

    @AfterTest
    fun tearDown() {
        scope.cancel()
        runCatching { server.shutdown() }
    }

    // --------------------------------------------------------------- codec --

    @Test
    fun `websocket url builds engine io v4 websocket-only request`() {
        assertEquals(
            "wss://hub.example.com/socket.io/?EIO=4&transport=websocket",
            SocketIoFrames.websocketUrl("https://hub.example.com"),
        )
        assertEquals(
            "ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket",
            SocketIoFrames.websocketUrl("http://127.0.0.1:3000/"),
        )
        assertEquals(
            "wss://hub.example.com/socket.io/?EIO=4&transport=websocket",
            SocketIoFrames.websocketUrl("hub.example.com"),
        )
        // A path in the base is preserved, like the JS client would join it.
        assertEquals(
            "wss://hub.example.com/legacy/prefix/socket.io/?EIO=4&transport=websocket",
            SocketIoFrames.websocketUrl("https://hub.example.com/legacy/prefix"),
        )
    }

    @Test
    fun `connect frame carries namespace and token auth`() {
        assertEquals(
            "40/terminal,{\"token\":\"jwt\"}",
            SocketIoFrames.encodeConnect("/terminal", "jwt"),
        )
        assertEquals("40/terminal", SocketIoFrames.encodeConnect("/terminal", null))
        assertEquals("40", SocketIoFrames.encodeConnect("", null))
    }

    @Test
    fun `event frames encode with and without payload`() {
        val payload = buildJsonObject { put("terminalId", "t-1") }
        assertEquals(
            "42/terminal,[\"terminal:write\",{\"terminalId\":\"t-1\"}]",
            SocketIoFrames.encodeEvent("/terminal", "terminal:write", payload),
        )
        assertEquals(
            "42/terminal,[\"terminal:close\"]",
            SocketIoFrames.encodeEvent("/terminal", "terminal:close", null),
        )
    }

    @Test
    fun `open frame parses as engine packet`() {
        assertTrue(SocketIoFrames.encodeOpen().startsWith("0{"))
    }

    // ---------------------------------------------------------- round-trip --

    /** Server-side socket recording everything the client sends. */
    private class ServerSocket : okhttp3.WebSocketListener() {
        val sentToClient = ConcurrentLinkedQueue<String>()
        val received = ConcurrentLinkedQueue<String>()
        val sockets = ConcurrentLinkedQueue<WebSocket>()

        override fun onOpen(webSocket: WebSocket, response: Response) {
            sockets.add(webSocket)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            received.add(text)
        }
    }

    /** Listener recording callbacks in arrival order. */
    private class RecordingListener : SocketIoListener {
        val events = ConcurrentLinkedQueue<String>()
        override fun onEngineOpen() {
            events.add("engine-open")
        }

        override fun onNamespaceConnected(namespace: String) {
            events.add("connected:$namespace")
        }

        override fun onNamespaceConnectError(namespace: String, message: String) {
            events.add("connect-error:$message")
        }

        override fun onEvent(namespace: String, event: String, args: kotlinx.serialization.json.JsonObject?) {
            events.add("event:$event:${args?.get("terminalId")}")
        }

        override fun onDisconnected(reason: String) {
            events.add("disconnected")
        }
    }

    private suspend fun awaitUntil(label: String = "", timeoutMs: Long = 5_000, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            delay(20)
        }
        fail("[$label] condition not met within ${timeoutMs}ms")
    }

    private fun upgrade(socket: ServerSocket): MockResponse =
        MockResponse().withWebSocketUpgrade(socket)

    @Test
    fun `handshake connects namespace and echoes events both ways`() {
        val serverSocket = ServerSocket()
        server.enqueue(upgrade(serverSocket))
        server.enqueue(upgrade(ServerSocket())) // (unused; keeps queue non-empty on shutdown)

        val listener = RecordingListener()
        val client = SocketIoClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            namespace = "/terminal",
            tokenProvider = { "jwt-1" },
            listener = listener,
            scope = scope,
        )

        runBlocking {
            withTimeout(10_000) {
                val job = launch { client.connect() }
                awaitUntil("serverSocket sockets isNotEmpty") { serverSocket.sockets.isNotEmpty() }
                // Server: engine OPEN, then the namespace CONNECT ack.
                serverSocket.sockets.first().send(SocketIoFrames.encodeOpen())
                awaitUntil("serverSocket received any it startsWith ") { serverSocket.received.any { it.startsWith("40") } }
                serverSocket.sockets.first().send(SocketIoFrames.decodeConnectAck("/terminal"))
                awaitUntil("listener events contains connected termi") { listener.events.contains("connected:/terminal") }

                // Server → client event.
                serverSocket.sockets.first().send(
                    SocketIoFrames.encodeServerEvent(
                        "/terminal",
                        "terminal:output",
                        buildJsonObject { put("terminalId", "term-1") },
                    ),
                )
                awaitUntil("listener events contains event terminal ") { listener.events.contains("event:terminal:output:\"term-1\"") }

                // Client → server event.
                client.emit("terminal:write", buildJsonObject { put("terminalId", "term-1"); put("data", "ls\n") })
                awaitUntil("serverSocket received any it startsWith ") { serverSocket.received.any { it.startsWith("42/terminal") && it.contains("terminal:write") } }
                client.disconnect()
                job.cancel()
            }
        }

        // The handshake request carried the engine.io v4 websocket transport.
        val request = server.takeRequest()
        assertTrue(request.path!!.contains("EIO=4"))
        assertTrue(request.path!!.contains("transport=websocket"))
        assertTrue(request.path!!.startsWith("/socket.io/"))
    }

    @Test
    fun `server pings are answered with pongs`() {
        val serverSocket = ServerSocket()
        server.enqueue(upgrade(serverSocket))
        val listener = RecordingListener()
        val client = SocketIoClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            namespace = "/terminal",
            tokenProvider = { "jwt" },
            listener = listener,
            scope = scope,
        )
        runBlocking {
            withTimeout(10_000) {
                client.connect()
                awaitUntil("serverSocket sockets isNotEmpty") { serverSocket.sockets.isNotEmpty() }
                serverSocket.sockets.first().send(SocketIoFrames.encodeOpen())
                awaitUntil("serverSocket received any it startsWith ") { serverSocket.received.any { it.startsWith("40") } }
                serverSocket.sockets.first().send("2")
                awaitUntil("serverSocket received contains 3") { serverSocket.received.contains("3") }
                client.disconnect()
            }
        }
    }

    @Test
    fun `connect error with no retries gives up and reports the reason`() {
        val serverSocket = ServerSocket()
        server.enqueue(upgrade(serverSocket))
        val listener = RecordingListener()
        val client = SocketIoClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            namespace = "/terminal",
            tokenProvider = { "expired-token" },
            listener = listener,
            scope = scope,
            maxAuthRetries = 0,
        )
        runBlocking {
            withTimeout(10_000) {
                client.connect()
                awaitUntil("serverSocket sockets isNotEmpty") { serverSocket.sockets.isNotEmpty() }
                serverSocket.sockets.first().send(SocketIoFrames.encodeOpen())
                awaitUntil("serverSocket received any it startsWith ") { serverSocket.received.any { it.startsWith("40") } }
                serverSocket.sockets.first().send(
                    SocketIoFrames.encodeConnectError("/terminal", "Invalid token"),
                )
                awaitUntil("listener events contains connect error I") { listener.events.contains("connect-error:Invalid token") }
                awaitUntil("listener events contains disconnected") { listener.events.contains("disconnected") }
                client.disconnect()
            }
        }
        // Gave up: exactly one handshake request, no reconnect.
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `transport close triggers reconnect with a fresh token`() {
        val firstSocket = ServerSocket()
        val secondSocket = ServerSocket()
        server.enqueue(upgrade(firstSocket))
        server.enqueue(upgrade(secondSocket))
        var tokenFetches = 0
        val listener = RecordingListener()
        val client = SocketIoClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            namespace = "/terminal",
            tokenProvider = { tokenFetches++; "jwt-$tokenFetches" },
            listener = listener,
            scope = scope,
            backoffFirstMs = 50,
            backoffMaxMs = 50,
        )
        runBlocking {
            withTimeout(10_000) {
                client.connect()
                awaitUntil("firstSocket sockets isNotEmpty") { firstSocket.sockets.isNotEmpty() }
                firstSocket.sockets.first().send(SocketIoFrames.encodeOpen())
                awaitUntil("firstSocket received any it startsWith 4") { firstSocket.received.any { it.startsWith("40") } }
                firstSocket.sockets.first().send(SocketIoFrames.decodeConnectAck("/terminal"))
                awaitUntil("listener events contains connected termi") { listener.events.contains("connected:/terminal") }

                // Server drops the transport.
                firstSocket.sockets.first().close(1001, "server going away")
                awaitUntil("listener events contains disconnected") { listener.events.contains("disconnected") }

                // Client reconnects on its own with a re-fetched token.
                awaitUntil("secondSocket sockets isNotEmpty") { secondSocket.sockets.isNotEmpty() }
                secondSocket.sockets.first().send(SocketIoFrames.encodeOpen())
                awaitUntil("secondSocket received any it contains jw") { secondSocket.received.any { it.contains("jwt-2") } }
                client.disconnect()
            }
        }
        assertTrue(tokenFetches >= 2, "expected token re-fetch per attempt, got $tokenFetches")
    }

    @Test
    fun `consecutive connect phase failures keep retrying until a socket upgrades`() {
        // Two plain HTTP failures (no WebSocket upgrade → engine OPEN never
        // fires), then a healthy socket: the retry loop must not stall after
        // the first failed attempt.
        server.enqueue(MockResponse().setResponseCode(502))
        server.enqueue(MockResponse().setResponseCode(503))
        val serverSocket = ServerSocket()
        server.enqueue(upgrade(serverSocket))
        val listener = RecordingListener()
        val client = SocketIoClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            namespace = "/terminal",
            tokenProvider = { "jwt" },
            listener = listener,
            scope = scope,
            backoffFirstMs = 50,
            backoffMaxMs = 50,
        )
        runBlocking {
            withTimeout(10_000) {
                client.connect()
                awaitUntil("serverSocket sockets isNotEmpty") { serverSocket.sockets.isNotEmpty() }
                serverSocket.sockets.first().send(SocketIoFrames.encodeOpen())
                awaitUntil("serverSocket received any it startsWith ") { serverSocket.received.any { it.startsWith("40") } }
                serverSocket.sockets.first().send(SocketIoFrames.decodeConnectAck("/terminal"))
                awaitUntil("listener events contains connected termi") { listener.events.contains("connected:/terminal") }
                client.disconnect()
            }
        }
        assertTrue(server.requestCount >= 3, "expected retries past both failures, got ${server.requestCount}")
    }

    @Test
    fun `emit while disconnected is dropped silently`() {
        val serverSocket = ServerSocket()
        server.enqueue(upgrade(serverSocket))
        val listener = RecordingListener()
        val client = SocketIoClient(
            baseUrl = server.url("/").toString().removeSuffix("/"),
            namespace = "/terminal",
            tokenProvider = { "jwt" },
            listener = listener,
            scope = scope,
        )
        runBlocking {
            withTimeout(10_000) {
                // Not connected yet: the emit must be a no-op (no throw).
                client.emit("terminal:write", buildJsonObject { put("data", "x") })
                client.connect()
                awaitUntil("serverSocket sockets isNotEmpty") { serverSocket.sockets.isNotEmpty() }
                serverSocket.sockets.first().send(SocketIoFrames.encodeOpen())
                awaitUntil("serverSocket received any it startsWith ") { serverSocket.received.any { it.startsWith("40") } }
                serverSocket.sockets.first().send(SocketIoFrames.decodeConnectAck("/terminal"))
                awaitUntil("listener events contains connected termi") { listener.events.contains("connected:/terminal") }
                assertTrue(serverSocket.received.none { it.contains("terminal:write") })
                client.disconnect()
            }
        }
    }
}
