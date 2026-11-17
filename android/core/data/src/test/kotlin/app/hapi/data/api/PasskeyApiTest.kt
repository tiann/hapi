package app.hapi.data.api

import app.hapi.data.HubSession
import app.hapi.data.auth.HubCredentials
import app.hapi.data.auth.InMemoryCredentialStore
import app.hapi.data.fakeJwt
import app.hapi.protocol.wire.NativePasskeys
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

/**
 * Native passkey endpoints of [HapiApi] (`docs/api/client-contract/auth.md`
 * §Native passkeys) against MockWebServer, wired through [HubSession].
 */
class PasskeyApiTest {

    private lateinit var server: MockWebServer
    private lateinit var session: HubSession
    private val jwt = fakeJwt(expSeconds = 4_000_000_000)

    private val creationOptions =
        """{"rp":{"id":"auth.hapi.run","name":"HAPI"},"user":{"id":"dXNlcg","name":"hapi@hub"},"challenge":"Y2g"}"""
    private val assertion =
        """{"id":"Y3JlZA","rawId":"Y3JlZA","type":"public-key","response":{"clientDataJSON":"e30"}}"""

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
    fun `register options posts client native with the jwt and returns the json verbatim`() {
        server.enqueue(ok(creationOptions))

        val options = runBlocking { session.api.passkeyRegisterOptions() }

        assertEquals(creationOptions, options)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/passkey/register/options", request.path)
        assertEquals("Bearer $jwt", request.getHeader("Authorization"))
        assertEquals("""{"client":"native"}""", request.body.readUtf8())
    }

    @Test
    fun `register verify posts the response object and name`() {
        server.enqueue(ok("""{"ok":true,"id":"Y3JlZA"}"""))

        runBlocking {
            session.api.passkeyRegisterVerify(NativePasskeys.credentialResponse(assertion), "Pixel 9")
        }

        val request = server.takeRequest()
        assertEquals("/api/passkey/register/verify", request.path)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("Pixel 9", body.getValue("name").jsonPrimitive.content)
        assertEquals("public-key", body.getValue("response").jsonObject.getValue("type").jsonPrimitive.content)
    }

    @Test
    fun `login options and verify go out without a bearer header`() {
        server.enqueue(ok("""{"challenge":"Y2g","rpId":"auth.hapi.run","allowCredentials":[]}"""))
        server.enqueue(
            ok("""{"token":"jwt-2","user":{"id":1,"firstName":"Web User"},"passkeySession":"ps-1"}"""),
        )

        val options = runBlocking { session.api.passkeyLoginOptions() }
        val login = runBlocking { session.api.passkeyLoginVerify(NativePasskeys.credentialResponse(assertion)) }

        assertEquals("auth.hapi.run", NativePasskeys.requestRpId(options))
        assertEquals("ps-1", login.passkeySession)
        assertEquals("jwt-2", login.token)

        val optionsRequest = server.takeRequest()
        assertEquals("/api/passkey/login/options", optionsRequest.path)
        assertNull(optionsRequest.getHeader("Authorization"))
        assertEquals("""{"client":"native"}""", optionsRequest.body.readUtf8())

        val verifyRequest = server.takeRequest()
        assertEquals("/api/passkey/login/verify", verifyRequest.path)
        assertNull(verifyRequest.getHeader("Authorization"))
        val body = Json.parseToJsonElement(verifyRequest.body.readUtf8()).jsonObject
        assertEquals(setOf("response"), body.keys)
    }

    @Test
    fun `no registered passkeys surfaces 404 no_passkeys`() {
        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"no_passkeys"}"""))

        val error = assertFailsWith<ApiError> { runBlocking { session.api.passkeyLoginOptions() } }

        assertEquals(404, error.status)
        assertEquals("no_passkeys", error.code)
    }

    @Test
    fun `list and delete hit the management endpoints`() {
        server.enqueue(
            ok(
                """{"passkeys":[{"id":"a/b","name":null,"rpId":"auth.hapi.run","createdAt":1,"lastUsedAt":null,"valid":true}]}""",
            ),
        )
        server.enqueue(ok("""{"ok":true}"""))

        val list = runBlocking { session.api.getPasskeys() }
        runBlocking { session.api.deletePasskey("a/b") }

        assertEquals(listOf("a/b"), list.passkeys.map { it.id })
        assertEquals("/api/passkeys", server.takeRequest().path)
        val delete = server.takeRequest()
        assertEquals("DELETE", delete.method)
        assertEquals("/api/passkeys/a%2Fb", delete.path, "credential ids are path-encoded")
    }
}
