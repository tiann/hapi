package app.hapi.data.api

import app.hapi.data.HubSession
import app.hapi.data.auth.HubCredentials
import app.hapi.data.auth.InMemoryCredentialStore
import app.hapi.data.fakeJwt
import app.hapi.protocol.wire.CodexDesktopScriptResponse
import app.hapi.protocol.wire.CodexDesktopSyncRequest
import app.hapi.protocol.wire.CodexLocalSessionsResponse
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

/**
 * Wire shapes of the codex-import endpoints (slice A):
 * `GET /api/codex/sessions` + `POST /api/codex/sync-session`.
 */
class HapiApiCodexImportTest {

    private lateinit var server: MockWebServer
    private lateinit var session: HubSession
    private val jwt = fakeJwt(expSeconds = 4_000_000_000)

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

    // ----------------------------------------------------- GET /codex/sessions --

    @Test
    fun `list sessions trims and forwards cwd and machineId`() {
        server.enqueue(
            ok("""{"success":true,"sessions":[{"id":"a","title":"Fix","file":"/f.json","modifiedAt":1700000000000}],"machineId":"m-echo"}"""),
        )

        val response = runBlocking { session.api.getCodexSessions(cwd = "  /repo  ", machineId = " m1 ") }

        val request = server.takeRequest()
        val url = request.requestUrl!!
        assertEquals("GET", request.method)
        assertEquals("/api/codex/sessions", url.encodedPath)
        assertEquals("/repo", url.queryParameter("cwd"), "cwd trimmed")
        assertEquals("m1", url.queryParameter("machineId"), "machineId trimmed")
        assertTrue(response.success)
        assertEquals("m-echo", response.machineId)
        val listed = response.sessions.single()
        assertEquals("a", listed.id)
        assertEquals("Fix", listed.title)
        assertNull(listed.cwd)
    }

    @Test
    fun `blank params are omitted entirely`() {
        server.enqueue(ok("""{"success":true,"sessions":[]}"""))

        val response = runBlocking { session.api.getCodexSessions(cwd = "   ", machineId = "") }

        val request = server.takeRequest()
        assertEquals("/api/codex/sessions", request.requestUrl!!.encodedPath)
        assertEquals(0, request.requestUrl!!.querySize, "blank params are not sent")
        assertTrue(response.sessions.isEmpty())
    }

    @Test
    fun `soft failure decodes as success false with empty sessions`() {
        server.enqueue(ok("""{"success":false,"sessions":[],"error":"rpc_target_missing"}"""))

        val response = runBlocking { session.api.getCodexSessions() }

        assertEquals(false, response.success)
        assertTrue(response.sessions.isEmpty())
        assertEquals("rpc_target_missing", response.error)
    }

    // -------------------------------------------------- POST /codex/sync-session --

    @Test
    fun `sync posts the full payload to the sync endpoint`() {
        server.enqueue(
            ok(
                """
                {"success":true,"message":"synced","pid":4242,"syncedCount":2,
                 "sessionIds":["a","b"],"hapiSessionIds":["h1","h2"],
                 "codexDesktopRunning":true,"codexClientAvailable":true}
                """.trimIndent(),
            ),
        )

        val response = runBlocking {
            session.api.syncCodexSession(
                CodexDesktopSyncRequest(
                    sessionIds = listOf("a", "b"),
                    cwd = "/repo",
                    machineId = "m1",
                    model = "gpt-5.2-codex",
                    modelReasoningEffort = "high",
                    collaborationMode = "default",
                    yolo = false,
                ),
            )
        }

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/codex/sync-session", request.requestUrl!!.encodedPath)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(
            listOf("a", "b"),
            body["sessionIds"]!!.jsonArray.map { it.jsonPrimitive.content },
        )
        assertEquals("/repo", body["cwd"]!!.jsonPrimitive.content)
        assertEquals("m1", body["machineId"]!!.jsonPrimitive.content)
        assertEquals("gpt-5.2-codex", body["model"]!!.jsonPrimitive.content)
        assertEquals("high", body["modelReasoningEffort"]!!.jsonPrimitive.content)
        assertEquals("default", body["collaborationMode"]!!.jsonPrimitive.content)
        assertEquals("false", body["yolo"]!!.jsonPrimitive.content, "yolo is sent even when false")
        assertTrue("serviceTier" !in body, "unset fields are omitted")

        assertTrue(response.success)
        assertEquals(4242L, response.pid)
        assertEquals(2, response.syncedCount)
        assertEquals(listOf("a", "b"), response.sessionIds)
        assertEquals(listOf("h1", "h2"), response.hapiSessionIds)
        assertEquals(true, response.codexDesktopRunning)
        assertEquals(true, response.codexClientAvailable)
    }

    @Test
    fun `sync failure arrives as http 200 with success false`() {
        server.enqueue(ok("""{"success":false,"error":"boom"}"""))

        val response = runBlocking {
            session.api.syncCodexSession(CodexDesktopSyncRequest(sessionIds = listOf("a")))
        }

        assertEquals(false, response.success)
        assertEquals("boom", response.error)
        assertNull(response.hapiSessionIds)
    }
}
