package app.hapi.data.sse

import app.hapi.protocol.wire.SyncEvent
import app.hapi.protocol.wire.SyncEvents
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPOutputStream
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer

/**
 * Integration tests: a real SSE body streamed by MockWebServer through the
 * real okhttp transport, proving the end-to-end parse into `SyncEvent`s —
 * including the hub's flush-per-event gzip framing (`sse.md#gzip`).
 */
class OkHttpSseTransportTest {

    private lateinit var server: MockWebServer

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        try {
            server.shutdown()
        } catch (_: IOException) {
            // The gzip test leaves a throttled response writer parked for 30s;
            // MockWebServer may give up joining it within its 5s grace. All
            // sockets are closed regardless and the writer thread is a daemon.
        }
    }

    private fun eventsUrl(): String = server.url("/api/events").toString()

    @Test
    fun `streams frames with sticky ids through okhttp and SyncEvents parse end to end`() {
        val body =
            "data: {\"type\":\"connection-changed\",\"data\":{\"status\":\"connected\",\"subscriptionId\":\"sub-9\",\"resume\":\"ok\"}}\n\n" +
                "id: 018f3c2a:41:9b1f00aa\n" +
                "data: {\"type\":\"session-removed\",\"sessionId\":\"s-1\"}\n\n" +
                "data: {\"type\":\"heartbeat\",\"data\":{\"timestamp\":1755000000000}}\n\n"
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(body),
        )

        val received = runBlocking {
            withTimeout(10_000) { OkHttpSseTransport().open(eventsUrl(), null).toList() }
        }

        assertEquals(TransportEvent.Connected, received.first())
        val frames = received.filterIsInstance<TransportEvent.Event>().map { it.event }
        assertEquals(3, frames.size)

        assertNull(frames[0].id, "handshake precedes any id-bearing frame")
        val handshake = assertIs<SyncEvent.ConnectionChanged>(SyncEvents.parse(frames[0].data))
        assertEquals("connected", handshake.data?.status)
        assertEquals("ok", handshake.data?.resume)

        assertEquals("018f3c2a:41:9b1f00aa", frames[1].id)
        assertEquals("s-1", assertIs<SyncEvent.SessionRemoved>(SyncEvents.parse(frames[1].data)).sessionId)

        // SSE ids are sticky: okhttp repeats the previous id on an id-less
        // frame, so the engine's "last non-null id" cursor rule never blanks.
        assertEquals("018f3c2a:41:9b1f00aa", frames[2].id)
        assertIs<SyncEvent.Heartbeat>(SyncEvents.parse(frames[2].data))
    }

    @Test
    fun `sends the Last-Event-ID header and cursor query on resume`() {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody("data: {\"type\":\"heartbeat\"}\n\n"),
        )
        val url = buildEventsUrl(
            baseUrl = server.url("/").toString(),
            token = "jwt-1",
            subscription = SseSubscriptionKey.Session("s-1"),
            visibility = "visible",
            lastEventId = "cur:1:aa",
        )

        runBlocking {
            withTimeout(10_000) { OkHttpSseTransport().open(url, "cur:1:aa").toList() }
        }

        val request = server.takeRequest()
        assertEquals("cur:1:aa", request.getHeader("Last-Event-ID"))
        val path = requireNotNull(request.path)
        assertTrue(path.contains("lastEventId=cur%3A1%3Aaa"), path)
        assertTrue(path.contains("sessionId=s-1"), path)
        assertTrue(path.contains("token=jwt-1"), path)
    }

    @Test
    fun `non-2xx responses surface as a Failure carrying the http code`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"Invalid token"}"""))

        val received = runBlocking {
            withTimeout(10_000) { OkHttpSseTransport().open(eventsUrl(), null).toList() }
        }

        assertEquals(listOf<TransportEvent>(TransportEvent.Failure(401)), received)
    }

    @Test
    fun `accept-encoding identity fallback flag disables transparent gzip`() {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody("data: {\"type\":\"heartbeat\"}\n\n"),
        )

        runBlocking {
            withTimeout(10_000) {
                OkHttpSseTransport(acceptEncodingIdentity = true).open(eventsUrl(), null).toList()
            }
        }

        assertEquals("identity", server.takeRequest().getHeader("Accept-Encoding"))
    }

    @Test
    fun `gzip frames surface incrementally instead of buffering to end of stream`() {
        // Mirror the hub (hub/src/web/sseCompression.ts): one gzip stream with
        // a sync flush after every event. The bytes after the third event
        // (padding + gzip trailer) are withheld by the throttle for 30s — far
        // beyond the 10s test timeout — so the events below can only be
        // observed if okhttp's transparent gzip inflates incrementally rather
        // than waiting for the body to complete.
        val raw = ByteArrayOutputStream()
        val gzip = GZIPOutputStream(raw, true) // syncFlush = true
        fun frame(text: String) {
            gzip.write(text.toByteArray())
            gzip.flush()
        }
        frame("data: {\"type\":\"connection-changed\",\"data\":{\"status\":\"connected\",\"resume\":\"ok\"}}\n\n")
        frame("id: e:1:aa\ndata: {\"type\":\"session-removed\",\"sessionId\":\"s-1\"}\n\n")
        frame("id: e:2:aa\ndata: {\"type\":\"heartbeat\"}\n\n")
        val flushedPrefix = raw.size()
        gzip.write(": padding withheld behind the throttle\n".repeat(8).toByteArray())
        gzip.close()

        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setHeader("Content-Encoding", "gzip")
                .setBody(Buffer().write(raw.toByteArray()))
                .throttleBody(flushedPrefix.toLong(), 30, TimeUnit.SECONDS),
        )

        val received = runBlocking {
            withTimeout(10_000) {
                OkHttpSseTransport().open(eventsUrl(), null).take(4).toList()
            }
        }

        assertEquals(TransportEvent.Connected, received.first())
        val frames = received.filterIsInstance<TransportEvent.Event>().map { it.event }
        assertEquals(3, frames.size)
        assertIs<SyncEvent.ConnectionChanged>(SyncEvents.parse(frames[0].data))
        assertEquals("e:1:aa", frames[1].id)
        assertIs<SyncEvent.SessionRemoved>(SyncEvents.parse(frames[1].data))
        assertEquals("e:2:aa", frames[2].id)
        assertIs<SyncEvent.Heartbeat>(SyncEvents.parse(frames[2].data))
    }
}
