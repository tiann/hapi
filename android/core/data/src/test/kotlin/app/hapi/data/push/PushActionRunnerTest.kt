package app.hapi.data.push

import app.hapi.data.HubSession
import app.hapi.data.auth.HubCredentials
import app.hapi.data.auth.HubRegistry
import app.hapi.data.auth.InMemoryCredentialStore
import app.hapi.data.auth.InMemoryHubRegistryStorage
import app.hapi.data.fakeJwt
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

/**
 * Notification-action delivery through a **real** `HubSession` (constructed
 * on demand from stored credentials, as the workers do) against two
 * MockWebServer "hubs": wire bodies, auth header, and the multi-hub
 * resolution order (active hub first, fall through on 404 session-miss).
 */
class PushActionRunnerTest {

    private lateinit var serverA: MockWebServer
    private lateinit var serverB: MockWebServer
    private lateinit var hubA: String
    private lateinit var hubB: String
    private lateinit var registry: HubRegistry
    private lateinit var runner: PushActionRunner

    private val jwt = fakeJwt(expSeconds = 4_000_000_000)

    @BeforeTest
    fun setUp() {
        serverA = MockWebServer().also { it.start() }
        serverB = MockWebServer().also { it.start() }
        hubA = "https://hub-a.example"
        hubB = "https://hub-b.example"

        val credentials = InMemoryCredentialStore().apply {
            set(
                HubCredentials(
                    hubUrl = serverA.url("/").toString().removeSuffix("/"),
                    accessToken = "token-a",
                    jwt = jwt,
                )
            )
            set(
                HubCredentials(
                    hubUrl = serverB.url("/").toString().removeSuffix("/"),
                    accessToken = "token-b",
                    jwt = jwt,
                )
            )
        }
        registry = HubRegistry(InMemoryHubRegistryStorage())
        runBlocking {
            registry.load()
            registry.addHub(hubA) // active
            registry.addHub(hubB, makeActive = false)
        }
        val serverUrls = mapOf(hubA to serverA.url("/"), hubB to serverB.url("/"))
        runner = PushActionRunner(
            PushHubAccess(registry) { hubUrl ->
                HubSession(checkNotNull(serverUrls[hubUrl]), credentials)
            }
        )
    }

    @AfterTest
    fun tearDown() {
        serverA.shutdown()
        serverB.shutdown()
    }

    private fun ok() = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody("""{"ok":true}""")

    private fun sessionNotFound() = MockResponse().setResponseCode(404)
        .setBody("""{"error":"Session not found"}""")

    // ------------------------------------------------------------ wire shape --

    @Test
    fun `approve posts an empty JSON object body with the JWT attached`() {
        serverA.enqueue(ok())

        val outcome = runBlocking { runner.approve("s1", "r1") }

        assertEquals(PushActionOutcome.Success(hubA), outcome)
        val request = serverA.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/sessions/s1/permissions/r1/approve", request.path)
        assertEquals("{}", request.body.readUtf8())
        assertEquals("Bearer $jwt", request.getHeader("Authorization"))
        assertEquals(0, serverB.requestCount) // active hub answered — B untouched
    }

    @Test
    fun `deny posts an empty JSON object body`() {
        serverA.enqueue(ok())

        val outcome = runBlocking { runner.deny("s1", "r1") }

        assertEquals(PushActionOutcome.Success(hubA), outcome)
        val request = serverA.takeRequest()
        assertEquals("/api/sessions/s1/permissions/r1/deny", request.path)
        assertEquals("{}", request.body.readUtf8())
    }

    @Test
    fun `reply posts text and localId only`() {
        serverA.enqueue(ok())

        val outcome = runBlocking { runner.sendMessage("s1", "looks good, ship it", "local-42") }

        assertEquals(PushActionOutcome.Success(hubA), outcome)
        val request = serverA.takeRequest()
        assertEquals("/api/sessions/s1/messages", request.path)
        assertEquals("""{"text":"looks good, ship it","localId":"local-42"}""", request.body.readUtf8())
    }

    // ------------------------------------------------------ hub resolution --

    @Test
    fun `session-miss on the active hub falls through to the next paired hub`() {
        serverA.enqueue(sessionNotFound())
        serverB.enqueue(ok())

        val outcome = runBlocking { runner.approve("s1", "r1") }

        assertEquals(PushActionOutcome.Success(hubB), outcome)
        assertEquals("/api/sessions/s1/permissions/r1/approve", serverA.takeRequest().path)
        assertEquals("/api/sessions/s1/permissions/r1/approve", serverB.takeRequest().path)
    }

    @Test
    fun `the active hub is always tried first`() {
        runBlocking { registry.setActiveHub(hubB) }
        serverB.enqueue(ok())

        val outcome = runBlocking { runner.approve("s1", "r1") }

        assertEquals(PushActionOutcome.Success(hubB), outcome)
        assertEquals(0, serverA.requestCount)
    }

    @Test
    fun `request-gone on a hub that knows the session is authoritative`() {
        serverA.enqueue(MockResponse().setResponseCode(404).setBody("""{"error":"Request not found"}"""))

        val outcome = runBlocking { runner.approve("s1", "r1") }

        assertEquals(PushActionOutcome.AlreadyHandled(hubA), outcome)
        assertEquals(0, serverB.requestCount) // resolution stops at the owning hub
    }

    @Test
    fun `inactive session on the owning hub stops resolution`() {
        serverA.enqueue(
            MockResponse().setResponseCode(409)
                .setBody("""{"error":"Session is inactive","code":"session_inactive"}""")
        )

        val outcome = runBlocking { runner.sendMessage("s1", "hi", "l1") }

        assertEquals(PushActionOutcome.SessionInactive(hubA), outcome)
        assertEquals(0, serverB.requestCount)
    }

    @Test
    fun `session unknown everywhere is a permanent miss`() {
        serverA.enqueue(sessionNotFound())
        serverB.enqueue(sessionNotFound())

        val outcome = runBlocking { runner.approve("s1", "r1") }

        assertEquals(PushActionOutcome.SessionNotFound, outcome)
    }

    @Test
    fun `a transiently failing hub keeps the outcome retryable`() {
        serverA.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"Not connected"}"""))
        serverB.enqueue(sessionNotFound())

        val outcome = runBlocking { runner.approve("s1", "r1") }

        // Hub A might own the session and answer after its CLI reconnects —
        // the worker must retry, not conclude "session not found".
        assertEquals(PushActionOutcome.Transient, outcome)
    }

    @Test
    fun `an unreachable hub falls through to one that answers`() {
        val deadPort = serverA.port
        serverA.shutdown() // connection refused from now on
        serverB.enqueue(ok())

        val outcome = runBlocking { runner.approve("s1", "r1") }

        assertEquals(PushActionOutcome.Success(hubB), outcome)
        assertTrue(deadPort > 0)
    }

    @Test
    fun `no paired hubs is a permanent miss`() {
        runBlocking {
            registry.removeHub(hubA)
            registry.removeHub(hubB)
        }

        val outcome = runBlocking { runner.approve("s1", "r1") }

        assertEquals(PushActionOutcome.SessionNotFound, outcome)
    }
}
