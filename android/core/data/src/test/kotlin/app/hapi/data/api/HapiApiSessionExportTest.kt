package app.hapi.data.api

import app.hapi.data.HubSession
import app.hapi.data.auth.HubCredentials
import app.hapi.data.auth.InMemoryCredentialStore
import app.hapi.data.fakeJwt
import app.hapi.protocol.wire.SESSION_EXPORT_TOO_LARGE_CODE
import app.hapi.protocol.wire.SessionExportResponse
import app.hapi.protocol.wire.SessionExportTooLarge
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

/**
 * `GET /api/sessions/:id/export` against MockWebServer — path/force query,
 * the 200 payload-vs-warning discrimination, the 413 coded error, and the
 * schema-version guard.
 */
class HapiApiSessionExportTest {

    private lateinit var server: MockWebServer
    private lateinit var session: HubSession
    private val jwt = fakeJwt(expSeconds = 4_000_000_000)

    private val payloadBody = """
        {
          "schemaVersion": 2,
          "exportedAt": 1700000000123,
          "session": {
            "id": "s1", "namespace": "test", "seq": 1,
            "createdAt": 1700000000000, "updatedAt": 1700000000000, "active": false,
            "metadataVersion": 1, "agentStateVersion": 1,
            "thinking": false, "thinkingAt": 0,
            "metadata": { "path": "/p", "host": "h", "name": "Sweep" }
          },
          "messages": [
            { "id": "m1", "createdAt": 1700000000000, "content": { "role": "user", "content": { "type": "text", "text": "hi" } } }
          ],
          "scratchlist": []
        }
    """.trimIndent()

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        val hubUrl = server.url("/").toString().removeSuffix("/")
        val store = InMemoryCredentialStore()
        store.set(HubCredentials(hubUrl = hubUrl, accessToken = "token", jwt = jwt))
        session = HubSession(server.url("/"), store)
    }

    @AfterTest
    fun tearDown() {
        session.close()
        server.shutdown()
    }

    private fun ok(body: String) = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    @Test
    fun `payload decodes as Full with path and no force query`() = runBlocking {
        server.enqueue(ok(payloadBody))

        val response = session.api.getSessionExport("s1")

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/sessions/s1/export", request.path)
        assertEquals("Bearer $jwt", request.getHeader("Authorization"))

        val full = assertIs<SessionExportResponse.Full>(response)
        assertEquals("s1", full.export.session.id)
        assertEquals(1, full.export.messages.size)
        assertEquals("Sweep", full.export.session.metadata?.name)
    }

    @Test
    fun `force=true travels as the single query parameter`() = runBlocking {
        server.enqueue(ok(payloadBody))

        session.api.getSessionExport("s1", force = true)

        assertEquals("/api/sessions/s1/export?force=true", server.takeRequest().path)
    }

    @Test
    fun `warning body decodes as Warning`() = runBlocking {
        server.enqueue(ok("""{"type":"warning","count":21000,"limit":20000,"estimatedBytes":999}"""))

        val response = session.api.getSessionExport("s1")

        val warning = assertIs<SessionExportResponse.Warning>(response)
        assertEquals(21_000, warning.warning.count)
        assertEquals(20_000, warning.warning.limit)
        assertEquals(999L, warning.warning.estimatedBytes)
    }

    @Test
    fun `413 surfaces as coded ApiError whose body parses as too-large`() = runBlocking {
        val body = """{"type":"too-large","error":"Session export too large","code":"$SESSION_EXPORT_TOO_LARGE_CODE","count":30000,"estimatedBytes":123456789,"maxBytes":104857600}"""
        server.enqueue(MockResponse().setResponseCode(413).setBody(body))

        val error = assertFailsWith<ApiError> { session.api.getSessionExport("s1") }
        assertEquals(413, error.status)
        assertEquals(SESSION_EXPORT_TOO_LARGE_CODE, error.code)
        assertEquals(
            SessionExportTooLarge(count = 30_000, estimatedBytes = 123_456_789L, maxBytes = 104_857_600L),
            SessionExportTooLarge.fromBody(error.body),
        )
    }

    @Test
    fun `future schema versions are rejected loudly`() = runBlocking {
        val bumped = payloadBody.replace("\"schemaVersion\": 2", "\"schemaVersion\": 3")
        server.enqueue(ok(bumped))

        val error = assertFailsWith<SerializationException> { session.api.getSessionExport("s1") }
        assertEquals("Unsupported session export schema version 3", error.message)
    }
}
