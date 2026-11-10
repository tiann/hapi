@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.chat.composer

import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okio.ByteString

// ------------------------------------------------------------------ fakes --

private class FakeSocket : ProviderSocket {
    lateinit var listener: ProviderSocketListener
    var open = false
    val textSends = mutableListOf<String>()
    val byteSends = mutableListOf<Int>()
    var closeCalls = 0

    override val isOpen: Boolean get() = open
    override fun send(text: String) { textSends += text }
    override fun send(bytes: ByteArray) { byteSends += bytes.size }
    override fun close() {
        closeCalls += 1
        open = false
    }

    fun fireOpen() {
        open = true
        listener.onOpen()
    }

    fun fireMessage(json: String) = listener.onMessage(json)

    fun fireClosed() {
        open = false
        listener.onClosed()
    }

    fun fireFailure(error: Throwable) {
        open = false
        listener.onFailure(error)
    }
}

private class FakeSocketFactory : ProviderSocketFactory {
    val sockets = mutableListOf<FakeSocket>()
    val urls = mutableListOf<String>()
    val tokens = mutableListOf<String>()

    override fun open(url: String, bearerToken: String, listener: ProviderSocketListener): ProviderSocket {
        val socket = FakeSocket()
        socket.listener = listener
        sockets += socket
        urls += url
        tokens += bearerToken
        return socket
    }
}

private class FakeAudioSource : StreamingAudioSource {
    var started = 0
    var stopped = 0
    var released = 0
    private var emit: ((ByteArray) -> Unit)? = null

    override fun startCapture(onChunk: (ByteArray) -> Unit) {
        started += 1
        emit = onChunk
    }

    override fun stopCapture() {
        stopped += 1
    }

    override fun release() {
        released += 1
    }

    fun push(bytes: ByteArray) = emit!!.invoke(bytes)
}

private class RecordingCallbacks : RealtimeTranscriptionCallbacks {
    var connected = 0
    val partials = mutableListOf<String>()
    var finalText: String? = null
    var error: Throwable? = null

    override fun onConnected() {
        connected += 1
    }

    override fun onPartial(text: String) {
        partials += text
    }

    override fun onFinal(text: String) {
        finalText = text
    }

    override fun onError(error: Throwable) {
        this.error = error
    }
}

private class Rig {
    val sockets = FakeSocketFactory()
    val audio = FakeAudioSource()
    val callbacks = RecordingCallbacks()
    val dictation = DeepgramRealtimeDictation(sockets, audio)

    val socket: FakeSocket get() = sockets.sockets.single()

    fun startIn(scope: TestScope, language: String? = null) =
        scope.backgroundScope.async {
            // runCatching: an escaped connect failure would fail the whole test
            // via backgroundScope's uncaught-exception hook before the test
            // body can assert on it.
            runCatching {
                dictation.start(getToken = { "dg-token" }, language = language, callbacks = callbacks)
            }
        }
}

/** Connect flow helper: runs start up to the connect await, then opens the socket. */
private suspend fun TestScope.connectSession(rig: Rig, language: String? = null): RealtimeTranscriptionSession {
    val deferred = rig.startIn(this, language)
    runCurrent() // start runs: token → socket → select suspension
    rig.socket.fireOpen()
    return deferred.await().getOrThrow()
}

private fun results(transcript: String, isFinal: Boolean, fromFinalize: Boolean = false) =
    """{"type":"Results","is_final":$isFinal,"from_finalize":$fromFinalize,""" +
        """"channel":{"alternatives":[{"transcript":"$transcript"}]}}"""

// ------------------------------------------------------------------ tests --

class DeepgramRealtimeDictationTest {

    @Test
    fun `listen url pins nova-3 linear16 mono and optional language`() {
        val url = DeepgramRealtimeDictation.buildListenUrl("zh-CN")
        assertTrue(url.startsWith("wss://api.deepgram.com/v1/listen?"), url)
        assertTrue(url.contains("model=nova-3"), url)
        assertTrue(url.contains("smart_format=true"), url)
        assertTrue(url.contains("interim_results=true"), url)
        assertTrue(url.contains("endpointing=false"), url)
        assertTrue(url.contains("encoding=linear16"), url)
        assertTrue(url.contains("sample_rate=16000"), url)
        assertTrue(url.contains("channels=1"), url)
        assertTrue(url.contains("language=zh-CN"), url)
        assertNull(Regex("language=").find(DeepgramRealtimeDictation.buildListenUrl(null)))
    }

    @Test
    fun `connect passes the bearer token starts capture and forwards audio chunks`() = runTest {
        val rig = Rig()
        val session = connectSession(rig)

        assertEquals(listOf("dg-token"), rig.sockets.tokens)
        assertEquals(1, rig.callbacks.connected)
        assertEquals(1, rig.audio.started)
        assertNull(rig.callbacks.error)

        rig.audio.push(byteArrayOf(1, 2, 3, 4))
        assertEquals(listOf(4), rig.socket.byteSends)

        session.cancel()
    }

    @Test
    fun `interim then final results join into running previews`() = runTest {
        val rig = Rig()
        val session = connectSession(rig)

        rig.socket.fireMessage(results("hel", isFinal = false))
        assertEquals(listOf("hel"), rig.callbacks.partials)
        rig.socket.fireMessage(results("hello", isFinal = true))
        assertEquals(listOf("hel", "hello"), rig.callbacks.partials)
        rig.socket.fireMessage(results("wor", isFinal = false))
        assertEquals("hello wor", rig.callbacks.partials.last())

        session.cancel()
    }

    @Test
    fun `stop sends Finalize after capture stops and completes on the from_finalize result`() = runTest {
        val rig = Rig()
        val session = connectSession(rig)
        rig.socket.fireMessage(results("hello", isFinal = true))

        val stopping = backgroundScope.async { session.stop() }
        runCurrent()
        assertEquals(listOf("""{"type":"Finalize"}"""), rig.socket.textSends)
        assertEquals(1, rig.audio.stopped)

        // A close while stopping must not fail the session (web parity).
        rig.socket.fireClosed()
        assertNull(rig.callbacks.error)

        rig.socket.fireMessage(results("world", isFinal = true, fromFinalize = true))
        assertEquals("hello world", rig.callbacks.finalText)
        stopping.await()
    }

    @Test
    fun `stop times out after 2,5s and finalizes the joined partial`() = runTest {
        val rig = Rig()
        val session = connectSession(rig)
        rig.socket.fireMessage(results("hel", isFinal = true))
        rig.socket.fireMessage(results("wor", isFinal = false))

        val stopping = backgroundScope.async { session.stop() }
        runCurrent()
        advanceTimeBy(DeepgramRealtimeDictation.STOP_TIMEOUT_MS)
        runCurrent()

        assertEquals("hel wor", rig.callbacks.finalText)
        stopping.await()
        assertEquals(1, rig.audio.released)
    }

    @Test
    fun `provider error event fails the session`() = runTest {
        val rig = Rig()
        connectSession(rig)

        rig.socket.fireMessage("""{"type":"Error","description":"bad token"}""")

        val error = rig.callbacks.error
        assertIs<RuntimeException>(error)
        assertEquals("bad token", error.message)
        assertEquals(1, rig.audio.released)
        assertTrue(rig.socket.textSends.contains("""{"type":"CloseStream"}"""))
        assertEquals(1, rig.socket.closeCalls)
        assertNull(rig.callbacks.finalText)
    }

    @Test
    fun `pre-open transport failure makes start throw without callbacks`() = runTest {
        val rig = Rig()
        val deferred = rig.startIn(this)
        runCurrent()

        rig.socket.fireFailure(IOException("boom"))

        val failure = assertFailsWith<IOException> { deferred.await().getOrThrow() }
        assertEquals("boom", failure.message)
        assertEquals(0, rig.callbacks.connected)
        assertNull(rig.callbacks.error)
        assertEquals(1, rig.audio.released)
        assertEquals(1, rig.socket.closeCalls)
    }

    @Test
    fun `connect timeout after ten seconds throws`() = runTest {
        val rig = Rig()
        val deferred = rig.startIn(this)
        runCurrent()

        advanceTimeBy(DeepgramRealtimeDictation.CONNECT_TIMEOUT_MS)
        runCurrent()

        val failure = assertFailsWith<IOException> { deferred.await().getOrThrow() }
        assertEquals("Deepgram realtime connection timed out", failure.message)
        assertEquals(1, rig.audio.released)
        assertEquals(1, rig.socket.closeCalls)
    }

    @Test
    fun `cancel abandons without a final transcript and a later stop is a no-op`() = runTest {
        val rig = Rig()
        val session = connectSession(rig)
        rig.socket.fireMessage(results("hel", isFinal = false))

        session.cancel()

        assertNull(rig.callbacks.finalText)
        assertNull(rig.callbacks.error)
        assertEquals(1, rig.audio.released)
        assertEquals(1, rig.socket.closeCalls)

        val stopping = backgroundScope.async { session.stop() }
        advanceTimeBy(DeepgramRealtimeDictation.STOP_TIMEOUT_MS + 1_000)
        runCurrent()
        stopping.await()
        // Already done: stop is a no-op — the only send ever made was the
        // CloseStream from cancel's cleanup, never a Finalize.
        assertEquals(listOf("""{"type":"CloseStream"}"""), rig.socket.textSends)
        assertNull(rig.callbacks.finalText)
    }

    @Test
    fun `unexpected close mid-session fails with disconnect`() = runTest {
        val rig = Rig()
        connectSession(rig)

        rig.socket.fireClosed()

        val error = rig.callbacks.error
        assertIs<IOException>(error)
        assertEquals("Deepgram realtime transcription disconnected", error.message)
        assertEquals(1, rig.audio.released)
    }

    // ------------------------------- maintainer blockers (mic lifecycle) --

    @Test
    fun `late open after cancel during the handshake never starts capture`() = runTest {
        val rig = Rig()
        val deferred = rig.startIn(this)
        runCurrent() // start(): token → socket → suspended in the connect select

        deferred.cancel() // owning scope cancelled while the handshake is in flight
        runCurrent()

        // cancel() aborted the session: socket closed, mic never started.
        assertEquals(1, rig.socket.closeCalls)
        assertEquals(0, rig.audio.started)
        assertEquals(1, rig.audio.released)

        // The provider delivers the late open anyway: it must be rejected —
        // no capture start, no connected/final/error callbacks.
        rig.socket.fireOpen()
        assertEquals(0, rig.audio.started)
        assertEquals(0, rig.callbacks.connected)
        assertNull(rig.callbacks.finalText)
        assertNull(rig.callbacks.error)
    }

    @Test
    fun `cancelling stop mid-finalization abandons resources and rethrows`() = runTest {
        val rig = Rig()
        val session = connectSession(rig)
        rig.socket.fireMessage(results("hel", isFinal = true))

        val stopping = backgroundScope.async { session.stop() }
        runCurrent()
        assertEquals(listOf("""{"type":"Finalize"}"""), rig.socket.textSends)
        assertEquals(1, rig.audio.stopped)

        // The server never answers the Finalize; the owner cancels
        // mid-finalization (navigated away).
        stopping.cancel()
        runCurrent()

        assertTrue(stopping.isCancelled) // cancellation rethrown, not swallowed
        assertEquals(1, rig.audio.released) // AudioRecord released
        assertTrue(rig.socket.textSends.contains("""{"type":"CloseStream"}""")) // finalization abandoned
        assertEquals(1, rig.socket.closeCalls) // socket closed
        assertNull(rig.callbacks.finalText) // no transcript surfaced
        assertNull(rig.callbacks.error) // a cancel is not an error
    }

    @Test
    fun `provider close during recording settles the session despite the echoed close handshake`() = runTest {
        val rig = Rig()
        connectSession(rig)

        // Provider-initiated close arrives twice in production: once from
        // the OkHttp adapter's onClosing (immediate terminal notification)
        // and once from its onClosed (handshake completion).
        rig.socket.fireClosed()
        rig.socket.fireClosed()

        val error = rig.callbacks.error
        assertIs<IOException>(error)
        assertEquals("Deepgram realtime transcription disconnected", error.message)
        assertEquals(1, rig.audio.released) // capture released exactly once
        assertEquals(1, rig.socket.closeCalls)
    }

    @Test
    fun `malformed and non-results messages are ignored`() = runTest {
        val rig = Rig()
        val session = connectSession(rig)

        rig.socket.fireMessage("not json")
        rig.socket.fireMessage("""{"type":"Metadata"}""")

        assertTrue(rig.callbacks.partials.isEmpty())
        assertNull(rig.callbacks.error)

        session.cancel()
    }
}

class JoinTranscriptPartsTest {

    @Test
    fun `trims parts drops empties and joins with single spaces`() {
        assertEquals("a b", joinTranscriptParts(" a ", "", "b"))
        assertEquals("", joinTranscriptParts("  ", ""))
        assertEquals("hello", joinTranscriptParts("hello"))
    }
}

// --------------------------- production OkHttp adapter (mic lifecycle) --

private class FakeOkHttpWebSocket : WebSocket {
    var closeCode: Int? = null
    var closeReason: String? = null
    var cancelled = false

    override fun request(): Request = throw UnsupportedOperationException()
    override fun queueSize(): Long = 0L
    override fun send(text: String): Boolean = true
    override fun send(bytes: ByteString): Boolean = true
    override fun close(code: Int, reason: String?): Boolean {
        closeCode = code
        closeReason = reason
        return true
    }

    override fun cancel() {
        cancelled = true
    }
}

private class RecordingSocketListener : ProviderSocketListener {
    val events = mutableListOf<String>()

    override fun onOpen() {
        events += "open"
    }

    override fun onMessage(text: String) {
        events += "message"
    }

    override fun onClosed() {
        events += "closed"
    }

    override fun onFailure(error: Throwable) {
        events += "failure"
    }
}

private fun switchProtocolsResponse(): Response = Response.Builder()
    .request(Request.Builder().url("https://api.deepgram.com/v1/listen").build())
    .protocol(Protocol.HTTP_1_1)
    .code(101)
    .message("Switching Protocols")
    .build()

/** The production OkHttp adapter's provider-initiated-close contract. */
class DeepgramOkHttpSocketBridgeTest {

    @Test
    fun `provider-initiated close is acknowledged marked unavailable and delivered as terminal`() {
        val socket = OkHttpProviderSocket()
        val listener = RecordingSocketListener()
        val bridge = ProviderWebSocketBridge(socket, listener)
        val webSocket = FakeOkHttpWebSocket()

        bridge.onOpen(webSocket, switchProtocolsResponse())
        assertTrue(socket.isOpen)
        assertEquals(listOf("open"), listener.events)

        bridge.onClosing(webSocket, 1000, "provider shutting down")

        // Acknowledged back to the provider (close frame, no echoed
        // reason), marked unavailable, terminal notification delivered
        // synchronously so capture is released and the UI settles.
        assertEquals(1000, webSocket.closeCode)
        assertNull(webSocket.closeReason)
        assertFalse(socket.isOpen)
        assertEquals(listOf("open", "closed"), listener.events)
    }

    @Test
    fun `handshake-completed close after the provider close is still forwarded once more`() {
        val socket = OkHttpProviderSocket()
        val listener = RecordingSocketListener()
        val bridge = ProviderWebSocketBridge(socket, listener)
        val webSocket = FakeOkHttpWebSocket()
        bridge.onOpen(webSocket, switchProtocolsResponse())

        bridge.onClosing(webSocket, 1000, "")
        bridge.onClosed(webSocket, 1000, "") // OkHttp follow-up

        // The bridge forwards both; the session's done-guard dedups.
        assertEquals(listOf("open", "closed", "closed"), listener.events)
        assertFalse(socket.isOpen)
    }

    @Test
    fun `closing a socket whose handshake never completed aborts the in-flight connect`() {
        val socket = OkHttpProviderSocket()
        val webSocket = FakeOkHttpWebSocket()
        socket.attach(webSocket)

        socket.close() // cancel() racing the handshake

        assertTrue(webSocket.cancelled) // connect aborted outright...
        assertNull(webSocket.closeCode) // ...not a queued graceful close
    }

    @Test
    fun `closing a socket that was live is a graceful close`() {
        val socket = OkHttpProviderSocket()
        val webSocket = FakeOkHttpWebSocket()
        socket.attach(webSocket)
        socket.markOpen()

        socket.close()

        assertFalse(webSocket.cancelled)
        assertEquals(1000, webSocket.closeCode)
        assertFalse(socket.isOpen)
    }
}
