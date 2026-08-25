package app.hapi.data.api

import app.hapi.data.HubSession
import app.hapi.data.auth.HubCredentials
import app.hapi.data.auth.InMemoryCredentialStore
import app.hapi.data.fakeJwt
import app.hapi.protocol.wire.ApprovePermissionRequest
import app.hapi.protocol.wire.SendMessageRequest
import app.hapi.protocol.wire.SpawnSessionRequest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer

/** Request/response shapes of [HapiApi] against MockWebServer. */
class HapiApiTest {

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

    private fun lastRequestBody() = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject

    @Test
    fun `production clients reject cleartext hub urls`() {
        assertFailsWith<IllegalArgumentException> {
            HapiApi("http://hub.example", OkHttpClient())
        }
        assertFailsWith<IllegalArgumentException> {
            HubSession("http://hub.example", InMemoryCredentialStore())
        }
    }

    // ------------------------------------------------------------ ApiError --

    @Test
    fun `409 session_inactive maps to ApiError with code`() {
        server.enqueue(
            MockResponse().setResponseCode(409)
                .setBody("""{"error":"Session is inactive","code":"session_inactive"}""")
        )

        val error = assertFailsWith<ApiError> { runBlocking { session.api.abortSession("s1") } }
        assertEquals(409, error.status)
        assertEquals("session_inactive", error.code)
        assertEquals("""{"error":"Session is inactive","code":"session_inactive"}""", error.body)
    }

    @Test
    fun `503 rpc_target_missing maps to ApiError with code`() {
        server.enqueue(
            MockResponse().setResponseCode(503)
                .setBody("""{"error":"RPC handler unregistered","code":"rpc_target_missing"}""")
        )

        val error = assertFailsWith<ApiError> { runBlocking { session.api.getSlashCommands("s1") } }
        assertEquals(503, error.status)
        assertEquals("rpc_target_missing", error.code)
    }

    @Test
    fun `code falls back to the error string when absent`() {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Session not found"}"""))

        val error = assertFailsWith<ApiError> { runBlocking { session.api.getSession("gone") } }
        assertEquals(404, error.status)
        assertEquals("Session not found", error.code)
    }

    @Test
    fun `non-json error bodies keep a null code`() {
        server.enqueue(MockResponse().setResponseCode(500).setBody("boom"))

        val error = assertFailsWith<ApiError> { runBlocking { session.api.getMachines() } }
        assertEquals(500, error.status)
        assertNull(error.code)
        assertEquals("boom", error.body)
    }

    // ------------------------------------------------------ request shapes --

    @Test
    fun `messages page sends compound cursor and epoch as query params`() {
        server.enqueue(
            ok("""{"messages":[],"page":{"direction":"before","limit":200,"epoch":3,"reset":false,"hasMore":false}}""")
        )

        val response = runBlocking {
            session.api.getMessages("s1", limit = 200, beforeSeq = 120, beforeAt = 1_755_000_000_000, epoch = 3)
        }

        val request = server.takeRequest()
        val url = requireNotNull(request.requestUrl)
        assertEquals("/api/sessions/s1/messages", url.encodedPath)
        assertEquals("1755000000000", url.queryParameter("beforeAt"))
        assertEquals("120", url.queryParameter("beforeSeq"))
        assertEquals("3", url.queryParameter("epoch"))
        assertEquals("200", url.queryParameter("limit"))
        assertNull(url.queryParameter("afterSeq"))
        assertNull(url.queryParameter("untilSeq"))
        assertEquals(3L, response.page.epoch)
        assertEquals(false, response.page.reset)
    }

    @Test
    fun `path params are percent-encoded`() {
        server.enqueue(
            ok("""{"session":{"id":"a/b","namespace":"default","seq":1,"createdAt":1,"updatedAt":1,"active":true,"metadataVersion":0,"agentStateVersion":0,"thinking":false,"thinkingAt":0}}""")
        )

        runBlocking { session.api.getSession("a/b") }
        assertEquals("/api/sessions/a%2Fb", server.takeRequest().path)
    }

    @Test
    fun `send message body carries deliveryMode steer and omits absent fields`() {
        server.enqueue(ok("""{"ok":true}"""))

        runBlocking {
            session.api.sendMessage(
                "s1",
                SendMessageRequest(text = "fix it", localId = "local-1", deliveryMode = "steer"),
            )
        }

        val request = server.takeRequest()
        assertEquals("/api/sessions/s1/messages", request.path)
        assertEquals("POST", request.method)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(
            buildJsonObject {
                put("text", "fix it")
                put("localId", "local-1")
                put("deliveryMode", "steer")
            },
            body,
            "null fields (attachments/scheduledAt) must be omitted, not sent as null",
        )
    }

    @Test
    fun `upload posts json base64 (not multipart) and yields the hub path`() {
        server.enqueue(ok("""{"success":true,"path":"/tmp/uploads/shot.jpg"}"""))

        val response = runBlocking {
            session.api.uploadFile("s1", "shot.jpg", "QUJDRA==", "image/jpeg")
        }

        assertTrue(response.success)
        assertEquals("/tmp/uploads/shot.jpg", response.path)
        val request = server.takeRequest()
        assertEquals("/api/sessions/s1/upload", request.path)
        assertEquals("POST", request.method)
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
        assertEquals(
            buildJsonObject {
                put("filename", "shot.jpg")
                put("content", "QUJDRA==")
                put("mimeType", "image/jpeg")
            },
            Json.parseToJsonElement(request.body.readUtf8()).jsonObject,
        )
    }

    @Test
    fun `delete upload posts the path`() {
        server.enqueue(ok("""{"success":true}"""))

        val response = runBlocking { session.api.deleteUpload("s1", "/tmp/uploads/shot.jpg") }

        assertTrue(response.success)
        val request = server.takeRequest()
        assertEquals("/api/sessions/s1/upload/delete", request.path)
        assertEquals(
            buildJsonObject { put("path", "/tmp/uploads/shot.jpg") },
            Json.parseToJsonElement(request.body.readUtf8()).jsonObject,
        )
    }

    @Test
    fun `approve body supports nested answers`() {
        server.enqueue(ok("""{"ok":true}"""))

        val answers = buildJsonObject {
            put("q1", buildJsonObject { putJsonArray("answers") { add("yes") } })
        }
        runBlocking {
            session.api.approvePermission(
                "s1",
                "req-9",
                ApprovePermissionRequest(decision = "approved", answers = answers),
            )
        }

        val request = server.takeRequest()
        assertEquals("/api/sessions/s1/permissions/req-9/approve", request.path)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("approved", body.getValue("decision").jsonPrimitive.content)
        val nested = body.getValue("answers").jsonObject.getValue("q1").jsonObject
        assertEquals("yes", nested.getValue("answers").jsonArray.single().jsonPrimitive.content)
        assertNull(body["mode"])
        assertNull(body["allowTools"])
    }

    @Test
    fun `deny without a decision sends an empty object`() {
        server.enqueue(ok("""{"ok":true}"""))

        runBlocking { session.api.denyPermission("s1", "req-9") }

        val request = server.takeRequest()
        assertEquals("/api/sessions/s1/permissions/req-9/deny", request.path)
        assertEquals("{}", request.body.readUtf8())
    }

    @Test
    fun `clearing the model sends an explicit json null`() {
        server.enqueue(ok("""{"ok":true}"""))

        runBlocking { session.api.setModel("s1", model = null) }

        assertEquals(JsonNull, lastRequestBody().getValue("model"))
    }

    @Test
    fun `provider model variant sends the object form`() {
        server.enqueue(ok("""{"ok":true}"""))

        runBlocking { session.api.setModel("s1", provider = "anthropic", modelId = "claude-4") }

        val model = lastRequestBody().getValue("model").jsonObject
        assertEquals("anthropic", model.getValue("provider").jsonPrimitive.content)
        assertEquals("claude-4", model.getValue("modelId").jsonPrimitive.content)
    }

    @Test
    fun `spawn posts to the machine and decodes type-discriminated errors`() {
        server.enqueue(ok("""{"type":"error","message":"No such directory"}"""))

        val response = runBlocking {
            session.api.spawnSession("m1", SpawnSessionRequest(directory = "/work", agent = "claude", yolo = false))
        }

        val request = server.takeRequest()
        assertEquals("/api/machines/m1/spawn", request.path)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("/work", body.getValue("directory").jsonPrimitive.content)
        assertEquals("claude", body.getValue("agent").jsonPrimitive.content)
        assertEquals("error", response.type)
        assertEquals("No such directory", response.message)
    }

    @Test
    fun `machine codex models decode and rpc_target_missing surfaces as coded ApiError`() {
        server.enqueue(
            ok(
                """{"success":true,"models":[{"id":"gpt-5.2-codex","displayName":"GPT-5.2 Codex","isDefault":true,"supportedReasoningEfforts":["low","high"],"serviceTiers":["standard","fast"]}]}"""
            )
        )

        val response = runBlocking { session.api.getMachineCodexModels("m1") }
        assertEquals("/api/machines/m1/codex-models", server.takeRequest().path)
        assertTrue(response.success)
        val model = response.models!!.single()
        assertEquals("gpt-5.2-codex", model.id)
        assertTrue(model.isDefault)
        assertContentEquals(listOf("standard", "fast"), model.serviceTiers)

        // Runner without the machine RPC: 503 + code (the create form hides the picker).
        server.enqueue(
            MockResponse()
                .setResponseCode(503)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"success":false,"error":"no rpc","code":"rpc_target_missing"}""")
        )
        val error = assertFailsWith<ApiError> {
            runBlocking { session.api.getMachineCodexModels("m1") }
        }
        assertEquals(503, error.status)
        assertEquals("rpc_target_missing", error.code)
    }

    @Test
    fun `unregister device is a DELETE with a json body`() {
        server.enqueue(ok("""{"ok":true}"""))

        runBlocking { session.api.unregisterDevice("fcm-token") }

        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/api/devices/register", request.path)
        assertEquals("fcm-token", Json.parseToJsonElement(request.body.readUtf8()).jsonObject.getValue("token").jsonPrimitive.content)
    }

    // --------------------------------------------------- health & binaries --

    @Test
    fun `usage summary sends range and timeZone and decodes with auth`() {
        server.enqueue(
            ok(
                """
                {"range":{"from":null,"to":1755600000000},
                 "totals":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":4,"cacheCreationTokens":1,
                           "totalTokens":12,"uncachedTokens":6,"requests":3,"sessions":2},
                 "daily":[],"byAgent":[],"byModel":[],"updatedAt":1755600000000}
                """.trimIndent()
            )
        )

        val summary = runBlocking { session.api.getUsageSummary(range = "all", timeZone = "Asia/Shanghai") }

        val request = server.takeRequest()
        val url = requireNotNull(request.requestUrl)
        assertEquals("/api/usage/summary", url.encodedPath)
        assertEquals("all", url.queryParameter("range"))
        assertEquals("Asia/Shanghai", url.queryParameter("timeZone"))
        assertEquals("Bearer $jwt", request.getHeader("Authorization"))
        assertNull(summary.range.from)
        assertEquals(12L, summary.totals.totalTokens)
    }

    @Test
    fun `sqlite storage usage decodes and a 403 surfaces as coded ApiError`() {
        server.enqueue(
            ok("""{"path":"/x/hapi.db","databaseBytes":100,"walBytes":20,"shmBytes":4,"totalBytes":124}""")
        )
        val storage = runBlocking { session.api.getSqliteStorageUsage() }
        assertEquals("/api/storage/sqlite", server.takeRequest().path)
        assertEquals(124L, storage.totalBytes)

        server.enqueue(
            MockResponse().setResponseCode(403)
                .setBody("""{"error":"Storage usage is only available to the hub owner"}""")
        )
        val error = assertFailsWith<ApiError> { runBlocking { session.api.getSqliteStorageUsage() } }
        assertEquals(403, error.status)
    }

    @Test
    fun `health is fetched without an authorization header`() {
        server.enqueue(ok("""{"status":"ok","protocolVersion":1,"capabilities":{"titleSuggestion":true,"brandNew":true}}"""))

        val health = runBlocking { session.api.health() }

        val request = server.takeRequest()
        assertEquals("/health", request.path)
        assertNull(request.getHeader("Authorization"))
        assertEquals(1, health.protocolVersion)
        assertEquals(true, health.capabilities?.titleSuggestion)
    }

    @Test
    fun `generated images return raw bytes and mime type`() {
        val bytes = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A)
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "image/png")
                .setHeader("ETag", "\"img-1\"")
                .setBody(Buffer().write(bytes))
        )

        val image = runBlocking { session.api.getGeneratedImage("s1", "img-1") }

        assertEquals("/api/sessions/s1/generated-images/img-1", server.takeRequest().path)
        assertContentEquals(bytes, image.bytes)
        assertEquals("image/png", image.mimeType)
    }

    @Test
    fun `transcription providers decode from the discovery endpoint`() {
        server.enqueue(
            ok(
                """{"providers":[
                    {"id":"openai","label":"OpenAI","modes":["standard","realtime"]},
                    {"id":"browser-local","label":"Browser on-device","modes":["realtime"]}
                ]}"""
            )
        )

        val result = runBlocking { session.api.getTranscriptionProviders() }

        assertEquals("/api/voice/transcription/providers", server.takeRequest().path)
        assertEquals(listOf("openai", "browser-local"), result.providers.map { it.id })
        assertEquals(listOf("standard", "realtime"), result.providers.first().modes)
        assertEquals("OpenAI", result.providers.first().label)
    }

    @Test
    fun `transcription helper posts multipart form data`() {
        server.enqueue(ok("""{"text":"hello world","language":"en"}"""))

        val result = runBlocking {
            session.api.transcribeVoice(
                audio = byteArrayOf(1, 2, 3),
                filename = "clip.m4a",
                mimeType = "audio/mp4",
                provider = "openai",
                language = "en-US",
            )
        }

        val request = server.takeRequest()
        assertEquals("/api/voice/transcription", request.path)
        assertTrue(request.getHeader("Content-Type")!!.startsWith("multipart/form-data"))
        val raw = request.body.readUtf8()
        assertTrue("""name="file"; filename="clip.m4a"""" in raw)
        assertTrue("""name="provider"""" in raw && "openai" in raw)
        assertTrue("""name="mode"""" in raw && "standard" in raw)
        assertTrue("""name="language"""" in raw && "en-US" in raw)
        assertEquals("hello world", result.text)
        assertEquals("en", result.language)
    }
}
