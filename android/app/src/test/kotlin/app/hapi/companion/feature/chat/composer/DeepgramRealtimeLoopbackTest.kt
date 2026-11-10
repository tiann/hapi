package app.hapi.companion.feature.chat.composer

import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Before

// ------------------------------------------------------------------ rig --

/**
 * Delegates to the PRODUCTION [OkHttpProviderSocketFactory]; only the
 * destination is rewritten onto the loopback server (the engine pins
 * `wss://api.deepgram.com`). Everything on the wire — the request build,
 * the `bearer, <token>` subprotocol header, [ProviderWebSocketBridge],
 * [OkHttpProviderSocket] — is stock production code; no scripted socket is
 * involved on the client side.
 */
private class LoopbackSocketFactory(
    private val server: MockWebServer,
    private val client: OkHttpClient,
) : ProviderSocketFactory {
    val requestedUrls = CopyOnWriteArrayList<String>()

    override fun open(url: String, bearerToken: String, listener: ProviderSocketListener): ProviderSocket {
        requestedUrls += url
        val loopback = server.url(url.removePrefix("wss://api.deepgram.com"))
        return OkHttpProviderSocketFactory(client).open(loopback.toString(), bearerToken, listener)
    }
}

/**
 * Server side of the provider websocket (the "peer"): records what the
 * production client puts on the wire and lets each test script the
 * handshake, the responses, and any provider-initiated close. Every close
 * the peer sees is acked so the close handshake always completes and the
 * server can shut down cleanly.
 */
private class ScriptedProvider : WebSocketListener() {
    val clientTexts = CopyOnWriteArrayList<String>()

    @Volatile private var socket: WebSocket? = null

    /** Close code seen when the client acked a provider-initiated close. */
    @Volatile var clientCloseAckCode: Int? = null

    /** Client's own graceful close completed the handshake (cancel/abandon). */
    @Volatile var clientCloseCode: Int? = null

    override fun onOpen(webSocket: WebSocket, response: Response) {
        socket = webSocket
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        clientTexts += text
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        clientCloseAckCode = code
        webSocket.close(code, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        clientCloseCode = code
    }

    fun send(text: String) {
        socket!!.send(text)
    }

    fun initiateClose(code: Int, reason: String) {
        socket!!.close(code, reason)
    }
}

/**
 * The audio seam stays scripted (the JVM has no microphone; the socket is
 * the production half under test) with atomics so the OkHttp reader threads
 * and the test thread agree on the lifecycle counts.
 */
private class CountingAudioSource : StreamingAudioSource {
    val started = AtomicInteger(0)
    val stopped = AtomicInteger(0)
    val released = AtomicInteger(0)

    override fun startCapture(onChunk: (ByteArray) -> Unit) {
        started.incrementAndGet()
    }

    override fun stopCapture() {
        stopped.incrementAndGet()
    }

    override fun release() {
        released.incrementAndGet()
    }
}

private class LoopbackCallbacks : RealtimeTranscriptionCallbacks {
    val connected = AtomicInteger(0)

    @Volatile var finalText: String? = null

    @Volatile var error: Throwable? = null

    override fun onConnected() {
        connected.incrementAndGet()
    }

    override fun onPartial(text: String) = Unit

    override fun onFinal(text: String) {
        finalText = text
    }

    override fun onError(error: Throwable) {
        this.error = error
    }
}

private class LoopbackRig(server: MockWebServer, client: OkHttpClient) {
    val audio = CountingAudioSource()
    val callbacks = LoopbackCallbacks()
    val sockets = LoopbackSocketFactory(server, client)
    val dictation = DeepgramRealtimeDictation(sockets, audio)

    fun startIn(scope: CoroutineScope) =
        scope.async {
            // runCatching: an escaped failure would fail the whole test via
            // the uncaught-exception hook before the test body can assert
            // on it.
            runCatching {
                dictation.start(getToken = { "dg-token" }, language = null, callbacks = callbacks)
            }
        }
}

private fun loopbackResults(transcript: String, isFinal: Boolean, fromFinalize: Boolean = false) =
    """{"type":"Results","is_final":$isFinal,"from_finalize":$fromFinalize,""" +
        """"channel":{"alternatives":[{"transcript":"$transcript"}]}}"""

/** Waits in real time for a loopback (thread-driven) condition to hold. */
private suspend fun awaitTrue(message: String, timeoutMs: Long = 5_000, condition: () -> Boolean) {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    while (!condition()) {
        assertTrue(System.nanoTime() < deadline, message)
        delay(20)
    }
}

// ---------------------------------------------------------------- tests --

/**
 * Maintainer review (PR #2182): "Please add cancel-before-open,
 * navigate-away-during-finalize and peer-close tests using the production
 * socket adapter." The scripted-socket tests in [DeepgramRealtimeDictationTest]
 * pin the engine's state machine; these drive the real OkHttp adapter
 * (`OkHttpProviderSocketFactory` + `ProviderWebSocketBridge` +
 * `OkHttpProviderSocket`) over a loopback MockWebServer websocket, so the
 * wire behavior — the bearer header, the abort of an in-flight handshake,
 * the Finalize/CloseStream frames, the close-ack handshake — is what the
 * tests assert against.
 *
 * Real sockets need real time (a virtual-time scheduler would fast-forward
 * past the engine's connect timeout before the loopback handshake
 * completes), so these run under [runBlocking] instead of `runTest`.
 */
class DeepgramRealtimeLoopbackTest {

    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        client = OkHttpClient()
    }

    @After fun tearDown() {
        server.shutdown()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    @Test
    fun `cancel before the handshake completes aborts the connect and never starts capture`() = runBlocking {
        // The 101 upgrade never arrives: the handshake is still in flight
        // when the owner walks away.
        server.enqueue(MockResponse().apply { socketPolicy = SocketPolicy.NO_RESPONSE })
        val rig = LoopbackRig(server, client)
        val start = rig.startIn(this)

        awaitTrue("the upgrade request reaches the loopback server") { server.requestCount >= 1 }

        // The engine asked for the production deepgram URL; the production
        // adapter carried the bearer as the raw subprotocol header.
        assertTrue(rig.sockets.requestedUrls.single().startsWith("wss://api.deepgram.com/v1/listen?"))
        val upgrade = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertTrue(upgrade.path!!.startsWith("/v1/listen?"), upgrade.path)
        assertTrue(upgrade.path!!.contains("model=nova-3"), upgrade.path)
        assertTrue(upgrade.path!!.contains("encoding=linear16"), upgrade.path)
        assertEquals("bearer, dg-token", upgrade.getHeader("Sec-WebSocket-Protocol"))

        // cancel() while the handshake is still connecting: the owning job
        // is cancelled, and the session must not have started the capture.
        start.cancelAndJoin()
        assertEquals(0, rig.audio.started.get()) // no capture start
        assertEquals(1, rig.audio.released.get()) // resources released
        assertEquals(0, rig.callbacks.connected.get()) // no callbacks fired
        assertNull(rig.callbacks.finalText)
        assertNull(rig.callbacks.error)
    }

    @Test
    fun `navigating away during finalization abandons the take over the wire and propagates`() = runBlocking {
        val provider = ScriptedProvider()
        server.enqueue(MockResponse().withWebSocketUpgrade(provider))
        val rig = LoopbackRig(server, client)
        val start = rig.startIn(this)

        awaitTrue("the production adapter completes the real websocket handshake") {
            rig.callbacks.connected.get() == 1
        }
        val session = start.await().getOrThrow()
        assertEquals(1, rig.audio.started.get()) // capture is live
        provider.send(loopbackResults("hello", isFinal = true))

        // Second press: stop() flushes capture, sends Finalize over the
        // production socket, and waits for the finalized result.
        val stopping = async { session.stop() }
        awaitTrue("""{"type":"Finalize"} reaches the server""") {
            provider.clientTexts.contains("""{"type":"Finalize"}""")
        }
        assertEquals(1, rig.audio.stopped.get())

        // The server never answers; the owner navigates away
        // mid-finalization (chat closed under the flush).
        stopping.cancelAndJoin()

        assertTrue(stopping.isCancelled) // cancellation propagates, not swallowed
        awaitTrue("the abandoned session sends CloseStream and completes the close handshake") {
            provider.clientTexts.contains("""{"type":"CloseStream"}""") && provider.clientCloseCode != null
        }
        assertEquals(1, rig.audio.released.get()) // microphone released
        assertNull(rig.callbacks.finalText) // session abandoned: no transcript surfaced
        assertNull(rig.callbacks.error) // a cancel is not an error
    }

    @Test
    fun `peer close during recording is acknowledged and settles as a disconnect`() = runBlocking {
        val provider = ScriptedProvider()
        server.enqueue(MockResponse().withWebSocketUpgrade(provider))
        val rig = LoopbackRig(server, client)
        val start = rig.startIn(this)

        awaitTrue("the production adapter completes the real websocket handshake") {
            rig.callbacks.connected.get() == 1
        }
        start.await().getOrThrow()
        assertEquals(1, rig.audio.started.get()) // recording is live
        provider.send(loopbackResults("hel", isFinal = false))

        // The provider initiates a graceful shutdown mid-take.
        provider.initiateClose(1000, "provider shutting down")

        awaitTrue("the terminal error is delivered") { rig.callbacks.error != null }
        val error = rig.callbacks.error
        assertIs<IOException>(error)
        assertEquals("Deepgram realtime transcription disconnected", error.message)
        awaitTrue("the adapter acked the close with the provider's code") {
            provider.clientCloseAckCode == 1000
        }
        assertEquals(1, rig.audio.started.get()) // capture started exactly once
        assertEquals(1, rig.audio.released.get()) // ... and released exactly once
        assertNull(rig.callbacks.finalText) // a disconnect is never a transcript
    }
}
