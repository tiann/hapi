package app.hapi.data.api

import app.hapi.data.HubSession
import app.hapi.data.auth.HubCredentials
import app.hapi.data.auth.InMemoryCredentialStore
import app.hapi.data.fakeJwt
import app.hapi.protocol.wire.PiImportSessionsRequest
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
 * Wire shapes of the pi-import endpoints (slice C):
 * `GET /api/pi/sessions` + `POST /api/pi/import-sessions`.
 */
class HapiApiPiImportTest {

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

    // ------------------------------------------------------ GET /pi/sessions --

    @Test
    fun `list sessions trims and forwards cwd and machineId`() {
        server.enqueue(
            ok(
                """
                {"success":true,"sessions":[{
                  "id":"pi-1","title":"Refactor","lastUserMessage":"continue",
                  "cwd":" /repo ","file":"/pi/pi-1.jsonl","modifiedAt":1700000000000,
                  "model":"pi-model","thinkingLevel":"high","leafEntryId":"leaf-9",
                  "messageCount":12,"hapiSessionId":"hapi-1","importState":"diverged"
                }],"machineId":"m-echo"}
                """.trimIndent(),
            ),
        )

        val response = runBlocking { session.api.getPiSessions(cwd = "  /repo  ", machineId = " m1 ") }

        val request = server.takeRequest()
        val url = request.requestUrl!!
        assertEquals("GET", request.method)
        assertEquals("/api/pi/sessions", url.encodedPath)
        assertEquals("/repo", url.queryParameter("cwd"), "cwd trimmed")
        assertEquals("m1", url.queryParameter("machineId"), "machineId trimmed")
        assertTrue(response.success)
        assertEquals("m-echo", response.machineId)
        val listed = response.sessions.single()
        assertEquals("pi-1", listed.id)
        assertEquals("Refactor", listed.title)
        assertEquals("continue", listed.lastUserMessage)
        assertEquals("/pi/pi-1.jsonl", listed.file)
        assertEquals(1700000000000L, listed.modifiedAt)
        assertEquals("pi-model", listed.model)
        assertEquals("high", listed.thinkingLevel)
        assertEquals("leaf-9", listed.leafEntryId)
        assertEquals(12L, listed.messageCount)
        assertEquals("hapi-1", listed.hapiSessionId)
        assertEquals("diverged", listed.importState)
    }

    @Test
    fun `blank list params are omitted entirely`() {
        server.enqueue(ok("""{"success":true,"sessions":[]}"""))

        val response = runBlocking { session.api.getPiSessions(cwd = "   ", machineId = "") }

        val request = server.takeRequest()
        assertEquals("/api/pi/sessions", request.requestUrl!!.encodedPath)
        assertEquals(0, request.requestUrl!!.querySize, "blank params are not sent")
        assertTrue(response.sessions.isEmpty())
        assertNull(response.machineId, "machineId is only echoed when requested")
    }

    @Test
    fun `soft failure decodes as success false with empty sessions`() {
        server.enqueue(ok("""{"success":false,"sessions":[],"error":"pi_not_installed"}"""))

        val response = runBlocking { session.api.getPiSessions() }

        assertEquals(false, response.success)
        assertTrue(response.sessions.isEmpty())
        assertEquals("pi_not_installed", response.error)
    }

    // ----------------------------------------------- POST /pi/import-sessions --

    @Test
    fun `import posts the full batch payload`() {
        server.enqueue(
            ok(
                """
                {"success":true,"results":[
                  {"piSessionId":"pi-1","hapiSessionId":"hapi-1","action":"created","appended":5},
                  {"piSessionId":"pi-2","hapiSessionId":"hapi-2","action":"unchanged"},
                  {"piSessionId":"pi-3","hapiSessionId":null,
                   "error":{"code":"session_active","message":"busy"}}
                ],"machineId":"m1"}
                """.trimIndent(),
            ),
        )

        val response = runBlocking {
            session.api.importPiSessions(
                PiImportSessionsRequest(
                    sessionIds = listOf("pi-1", "pi-2", "pi-3"),
                    cwd = "/repo",
                    machineId = "m1",
                ),
            )
        }

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/pi/import-sessions", request.requestUrl!!.encodedPath)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(
            listOf("pi-1", "pi-2", "pi-3"),
            body["sessionIds"]!!.jsonArray.map { it.jsonPrimitive.content },
        )
        assertEquals("/repo", body["cwd"]!!.jsonPrimitive.content)
        assertEquals("m1", body["machineId"]!!.jsonPrimitive.content)

        assertTrue(response.success)
        assertEquals("m1", response.machineId)
        val results = response.results
        assertEquals(3, results.size)
        assertEquals("hapi-1", results[0].hapiSessionId)
        assertEquals("created", results[0].action)
        assertEquals(5L, results[0].appended)
        assertNull(results[0].error)
        assertEquals("unchanged", results[1].action)
        assertEquals("hapi-2", results[1].hapiSessionId)
        assertNull(results[2].hapiSessionId)
        assertEquals("pi-3", results[2].piSessionId)
        assertEquals("session_active", results[2].error?.code)
        assertEquals("busy", results[2].error?.message)
    }

    @Test
    fun `import omits null cwd and machineId from the body`() {
        server.enqueue(ok("""{"success":true,"results":[]}"""))

        val response = runBlocking {
            session.api.importPiSessions(PiImportSessionsRequest(sessionIds = listOf("pi-1")))
        }

        val body = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertTrue("cwd" !in body, "null cwd is omitted like the web's undefined")
        assertTrue("machineId" !in body, "null machineId is omitted")
        assertTrue(response.success)
        assertTrue(response.results.isEmpty())
    }

    @Test
    fun `import envelope failure decodes with per-item results intact`() {
        server.enqueue(
            ok("""{"success":false,"results":[],"error":"machine offline"}"""),
        )

        val response = runBlocking {
            session.api.importPiSessions(PiImportSessionsRequest(sessionIds = listOf("pi-1")))
        }

        assertEquals(false, response.success)
        assertTrue(response.results.isEmpty())
        assertEquals("machine offline", response.error)
    }
}
