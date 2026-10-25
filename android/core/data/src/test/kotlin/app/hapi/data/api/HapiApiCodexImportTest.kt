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
 * `GET /api/codex/sessions` + `POST /api/codex/sync-session`;
 * slice B adds archive/status/dedupe/restart.
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

    // ------------------------------------------ POST /codex/archive-session (B) --

    @Test
    fun `archive posts sessionId and omits machineId when null`() {
        server.enqueue(ok("""{"success":true,"archivedPath":"/arc/a.jsonl"}"""))

        val response = runBlocking { session.api.archiveCodexSession("a") }

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/codex/archive-session", request.requestUrl!!.encodedPath)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("a", body["sessionId"]!!.jsonPrimitive.content)
        assertTrue("machineId" !in body, "null machineId is omitted like the web's undefined")
        assertTrue(response.success)
        assertEquals("/arc/a.jsonl", response.archivedPath)
        assertNull(response.machineId)
    }

    @Test
    fun `archive sends machineId when provided`() {
        server.enqueue(ok("""{"success":true,"archivedPath":"/arc/b.jsonl","machineId":"m1"}"""))

        val response = runBlocking { session.api.archiveCodexSession("b", machineId = "m1") }

        val body = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("m1", body["machineId"]!!.jsonPrimitive.content)
        assertEquals("m1", response.machineId)
    }

    @Test
    fun `archive soft failure decodes success false with error`() {
        server.enqueue(ok("""{"success":false,"error":"not found","machineId":"m1"}"""))

        val response = runBlocking { session.api.archiveCodexSession("gone") }

        assertEquals(false, response.success)
        assertEquals("not found", response.error)
        assertEquals("m1", response.machineId)
        assertNull(response.archivedPath)
    }

    // --------------------------------------------------- GET /codex/status (B) --

    @Test
    fun `status probes codex client liveness`() {
        server.enqueue(
            ok("""{"success":true,"codexDesktopRunning":false,"codexClientAvailable":true}"""),
        )

        val response = runBlocking { session.api.getCodexDesktopStatus() }

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/codex/status", request.requestUrl!!.encodedPath)
        assertTrue(response.success)
        assertEquals(true, response.codexClientAvailable)
        assertEquals(false, response.codexDesktopRunning)
    }

    // ---------------------------------------- POST /codex/duplicate-sessions (B) --

    @Test
    fun `duplicate detection posts only the batch sessionIds`() {
        server.enqueue(
            ok(
                """
                {"success":true,"duplicates":[
                  {"codexSessionId":"a","hapiSessionIds":["h1","h2"],
                   "canonicalSessionId":"h1","removedSessionIds":["h2"]}
                ]}
                """.trimIndent(),
            ),
        )

        val response = runBlocking {
            session.api.getCodexDuplicateSessions(CodexDesktopSyncRequest(sessionIds = listOf("a", "b")))
        }

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/codex/duplicate-sessions", request.requestUrl!!.encodedPath)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(
            listOf("a", "b"),
            body["sessionIds"]!!.jsonArray.map { it.jsonPrimitive.content },
        )
        assertTrue(body.keys == setOf("sessionIds"), "only the batch sessionIds are sent")

        assertTrue(response.success)
        val group = response.duplicates.single()
        assertEquals("a", group.codexSessionId)
        assertEquals(listOf("h1", "h2"), group.hapiSessionIds)
        assertEquals("h1", group.canonicalSessionId)
        assertEquals(listOf("h2"), group.removedSessionIds)
    }

    @Test
    fun `duplicate detection failure arrives as success false`() {
        server.enqueue(ok("""{"success":false,"duplicates":[],"error":"script failed"}"""))

        val response = runBlocking {
            session.api.getCodexDuplicateSessions(CodexDesktopSyncRequest(sessionIds = listOf("a")))
        }

        assertEquals(false, response.success)
        assertTrue(response.duplicates.isEmpty())
        assertEquals("script failed", response.error)
    }

    // --------------------------------- POST /codex/merge-duplicate-sessions (B) --

    @Test
    fun `merge posts the same batch shape as detection`() {
        server.enqueue(
            ok(
                """
                {"success":true,"merged":[
                  {"codexSessionId":"a","hapiSessionIds":["h1","h2"],"canonicalSessionId":"h1"}
                ],"mergedCount":1}
                """.trimIndent(),
            ),
        )

        val response = runBlocking {
            session.api.mergeCodexDuplicateSessions(CodexDesktopSyncRequest(sessionIds = listOf("a")))
        }

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/codex/merge-duplicate-sessions", request.requestUrl!!.encodedPath)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(
            listOf("a"),
            body["sessionIds"]!!.jsonArray.map { it.jsonPrimitive.content },
        )

        assertTrue(response.success)
        assertEquals(1, response.mergedCount)
        assertEquals("h1", response.merged.single().canonicalSessionId)
    }

    // ------------------------------------------ POST /codex/restart-desktop (B) --

    @Test
    fun `restart posts an empty body to the restart endpoint`() {
        server.enqueue(ok("""{"success":true,"message":"restarted"}"""))

        val response = runBlocking { session.api.restartCodexDesktop() }

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/codex/restart-desktop", request.requestUrl!!.encodedPath)
        assertEquals("{}", request.body.readUtf8(), "no-body POST convention sends an empty object")
        assertTrue(response.success)
        assertEquals("restarted", response.message)
    }
}
