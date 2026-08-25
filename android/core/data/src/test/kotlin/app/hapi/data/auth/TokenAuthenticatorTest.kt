package app.hapi.data.auth

import app.hapi.data.HubSession
import app.hapi.data.RecordingAuthEvents
import app.hapi.data.api.ApiError
import app.hapi.data.fakeJwt
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

/**
 * Silent re-auth loop against a real OkHttp stack + MockWebServer, wired
 * exactly as production wires it (via [HubSession]).
 */
class TokenAuthenticatorTest {

    private lateinit var server: MockWebServer
    private lateinit var store: InMemoryCredentialStore
    private lateinit var events: RecordingAuthEvents
    private var session: HubSession? = null

    private val jwt1 = fakeJwt(expSeconds = 4_000_000_000)
    private val jwt2 = fakeJwt(expSeconds = 4_100_000_000)
    private val accessToken = "base-token:default"

    private lateinit var hubUrl: String

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        hubUrl = server.url("/").toString().removeSuffix("/")
        store = InMemoryCredentialStore()
        events = RecordingAuthEvents()
    }

    @AfterTest
    fun tearDown() {
        session?.close()
        server.shutdown()
    }

    private fun startSession(jwt: String? = jwt1): HubSession {
        store.set(HubCredentials(hubUrl = hubUrl, accessToken = accessToken, jwt = jwt))
        return HubSession(server.url("/"), store, events).also { session = it }
    }

    private fun authOk(token: String) = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody("""{"token":"$token","user":{"id":1,"firstName":"Web User"}}""")

    private fun sessionsOk() = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody("""{"sessions":[]}""")

    private fun unauthorized(message: String = "Invalid token") = MockResponse()
        .setResponseCode(401)
        .setHeader("Content-Type", "application/json")
        .setBody("""{"error":"$message"}""")

    // -------------------------------------------------- 401 → refresh → retry --

    @Test
    fun `401 refreshes once and retries with the new jwt`() {
        val hub = startSession()
        server.enqueue(unauthorized())
        server.enqueue(authOk(jwt2))
        server.enqueue(sessionsOk())

        runBlocking { hub.api.getSessions() }

        assertEquals(3, server.requestCount)
        val first = server.takeRequest()
        assertEquals("/api/sessions", first.path)
        assertEquals("Bearer $jwt1", first.getHeader("Authorization"))

        val auth = server.takeRequest()
        assertEquals("/api/auth", auth.path)
        assertEquals("POST", auth.method)
        assertNull(auth.getHeader("Authorization"), "auth exchange must not carry a bearer header")
        val authBody = Json.parseToJsonElement(auth.body.readUtf8()).jsonObject
        assertEquals(accessToken, authBody.getValue("accessToken").jsonPrimitive.content)

        val retry = server.takeRequest()
        assertEquals("/api/sessions", retry.path)
        assertEquals("Bearer $jwt2", retry.getHeader("Authorization"))

        val stored = store.get(hubUrl)
        assertNotNull(stored)
        assertEquals(jwt2, stored.jwt)
        assertNotNull(stored.jwtObtainedAtMs)
        assertTrue(events.events.isEmpty(), "successful refresh must not emit terminal events")
    }

    @Test
    fun `cold start without a jwt exchanges before succeeding`() {
        val hub = startSession(jwt = null)
        val authCalls = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/auth" -> {
                    authCalls.incrementAndGet()
                    authOk(jwt2)
                }
                request.getHeader("Authorization") == "Bearer $jwt2" -> sessionsOk()
                else -> unauthorized("Missing authorization token")
            }
        }

        runBlocking { hub.api.getSessions() }

        assertEquals(1, authCalls.get())
        assertEquals(jwt2, store.get(hubUrl)?.jwt)
    }

    // ------------------------------------------------------------ single-flight --

    @Test
    fun `concurrent 401s share a single auth exchange`() {
        val parallel = 4
        val hub = startSession()
        val authCalls = AtomicInteger()
        val staleServed = CountDownLatch(parallel)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path == "/api/auth" -> {
                    authCalls.incrementAndGet()
                    // Hold the exchange until every caller has hit its 401 so
                    // all of them are contending on the refresh mutex.
                    staleServed.await(2, TimeUnit.SECONDS)
                    authOk(jwt2)
                }
                request.getHeader("Authorization") == "Bearer $jwt2" -> sessionsOk()
                else -> {
                    staleServed.countDown()
                    unauthorized()
                }
            }
        }

        runBlocking {
            (1..parallel).map {
                async(Dispatchers.IO) { hub.api.getSessions() }
            }.awaitAll()
        }

        assertEquals(1, authCalls.get(), "N parallel 401s must produce exactly one POST /api/auth")
        assertTrue(events.events.isEmpty())
    }

    // ------------------------------------------------------------- terminal --

    @Test
    fun `second 401 after a successful refresh emits RETRY_EXHAUSTED`() {
        val hub = startSession()
        val authCalls = AtomicInteger()
        val sessionCalls = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/api/auth" -> {
                    authCalls.incrementAndGet()
                    authOk(jwt2)
                }
                else -> {
                    sessionCalls.incrementAndGet()
                    unauthorized()
                }
            }
        }

        val error = assertFailsWith<ApiError> { runBlocking { hub.api.getSessions() } }

        assertEquals(401, error.status)
        assertEquals(2, sessionCalls.get(), "exactly one retry")
        assertEquals(1, authCalls.get())
        assertEquals(listOf(AuthTerminalReason.RETRY_EXHAUSTED), events.reasons)
        assertEquals(hubUrl, events.events.single().first)
    }

    @Test
    fun `rejected access token emits ACCESS_TOKEN_REJECTED and stops retrying the exchange`() {
        val hub = startSession()
        val authCalls = AtomicInteger()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/api/auth" -> {
                    authCalls.incrementAndGet()
                    unauthorized("Invalid access token")
                }
                else -> unauthorized()
            }
        }

        val error = assertFailsWith<ApiError> { runBlocking { hub.api.getSessions() } }
        assertEquals(401, error.status)
        assertEquals(listOf(AuthTerminalReason.ACCESS_TOKEN_REJECTED), events.reasons)

        // A later call fails fast on the remembered rejected token: no storm.
        assertFailsWith<ApiError> { runBlocking { hub.api.getSessions() } }
        assertEquals(1, authCalls.get(), "rejected access token must not be re-exchanged")
        assertEquals(1, events.events.size)
    }

    @Test
    fun `transient exchange failure surfaces the 401 without a terminal event`() {
        val hub = startSession()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/api/auth" -> MockResponse().setResponseCode(503)
                    .setBody("""{"error":"Not connected"}""")
                else -> unauthorized()
            }
        }

        val error = assertFailsWith<ApiError> { runBlocking { hub.api.getSessions() } }
        assertEquals(401, error.status)
        assertTrue(events.events.isEmpty(), "5xx exchange failures are transient, not terminal")
    }

    // ------------------------------------------------------- proactive refresh --

    @Test
    fun `ensureFreshToken keeps a token with plenty of lifetime`() {
        val nowMs = 1_000_000_000_000L
        val freshJwt = fakeJwt(expSeconds = (nowMs / 1000) + 4 * 3600)
        store.set(HubCredentials(hubUrl, accessToken, jwt = freshJwt))
        val authenticator = TokenAuthenticator(hubUrl, store, OkHttpClient(), events) { nowMs }

        val token = runBlocking { authenticator.ensureFreshToken() }

        assertEquals(freshJwt, token)
        assertEquals(0, server.requestCount, "fresh token must not hit the network")
    }

    @Test
    fun `ensureFreshToken refreshes inside the 10 minute window`() {
        val nowMs = 1_000_000_000_000L
        val expiringJwt = fakeJwt(expSeconds = (nowMs / 1000) + 5 * 60) // 5 min left
        store.set(HubCredentials(hubUrl, accessToken, jwt = expiringJwt))
        server.enqueue(authOk(jwt2))
        val authenticator = TokenAuthenticator(hubUrl, store, OkHttpClient(), events) { nowMs }

        val token = runBlocking { authenticator.ensureFreshToken() }

        assertEquals(jwt2, token)
        assertEquals(1, server.requestCount)
        assertEquals("/api/auth", server.takeRequest().path)
        assertEquals(jwt2, store.get(hubUrl)?.jwt)
    }

    @Test
    fun `ensureFreshToken treats an undecodable jwt as stale`() {
        store.set(HubCredentials(hubUrl, accessToken, jwt = "garbage"))
        server.enqueue(authOk(jwt2))
        val authenticator = TokenAuthenticator(hubUrl, store, OkHttpClient(), events)

        assertEquals(jwt2, runBlocking { authenticator.ensureFreshToken() })
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `missing credentials emit MISSING_CREDENTIALS`() {
        val authenticator = TokenAuthenticator(hubUrl, store, OkHttpClient(), events)

        assertNull(runBlocking { authenticator.ensureFreshToken() })
        assertEquals(listOf(AuthTerminalReason.MISSING_CREDENTIALS), events.reasons)
        assertEquals(0, server.requestCount)
    }
}
