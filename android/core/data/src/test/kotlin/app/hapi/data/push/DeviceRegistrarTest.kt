@file:OptIn(ExperimentalCoroutinesApi::class)

package app.hapi.data.push

import app.hapi.data.api.ApiError
import app.hapi.data.auth.HubRegistry
import app.hapi.data.auth.InMemoryHubRegistryStorage
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

/**
 * Registrar behavior with fake seams: multi-hub fan-out, retry scheduling on
 * transient failures only, and the clean no-op when push is unavailable
 * (`PushBinding.isAvailable == false` → null token).
 */
class DeviceRegistrarTest {

    private class FakeGateway : PushDeviceGateway {
        data class Registration(val hubUrl: String, val token: String, val deviceId: String)

        val registrations = mutableListOf<Registration>()
        val unregistrations = mutableListOf<Pair<String, String>>()
        val failures = mutableMapOf<String, Exception>()

        override suspend fun register(hubUrl: String, token: String, deviceId: String) {
            failures[hubUrl]?.let { throw it }
            registrations += Registration(hubUrl, token, deviceId)
        }

        override suspend fun unregister(hubUrl: String, token: String) {
            failures[hubUrl]?.let { throw it }
            unregistrations += hubUrl to token
        }
    }

    private class RecordingRetries : RegistrationRetryScheduler {
        val retries = mutableListOf<String>()
        override fun scheduleRetry(hubUrl: String) {
            retries += hubUrl
        }
    }

    /**
     * Test harness: real [HubRegistry] over in-memory storage, plus a scope
     * on the test scheduler that the test cancels at the end (the registrar's
     * roster collect is infinite by design).
     */
    private class Harness(testScope: TestScope, token: String?) {
        val registry = HubRegistry(InMemoryHubRegistryStorage())
        val gateway = FakeGateway()
        val retries = RecordingRetries()
        val scope = CoroutineScope(StandardTestDispatcher(testScope.testScheduler))
        val registrar = DeviceRegistrar(
            registry = registry,
            gateway = gateway,
            tokenSource = { token },
            deviceIds = { "device-uuid" },
            retryScheduler = retries,
            scope = scope,
        )
    }

    private fun test(token: String? = "fcm-token-1", body: suspend TestScope.(Harness) -> Unit) = runTest {
        val harness = Harness(this, token)
        harness.registry.load()
        try {
            body(harness)
        } finally {
            harness.scope.cancel()
        }
    }

    private val hubA = "https://hub-a.example"
    private val hubB = "https://hub-b.example"

    @Test
    fun `start fans the token out to every persisted hub`() = test { h ->
        h.registry.addHub(hubA)
        h.registry.addHub(hubB, makeActive = false)

        h.registrar.start()
        advanceUntilIdle()

        assertEquals(
            listOf(
                FakeGateway.Registration(hubA, "fcm-token-1", "device-uuid"),
                FakeGateway.Registration(hubB, "fcm-token-1", "device-uuid"),
            ),
            h.gateway.registrations,
        )
        assertTrue(h.retries.retries.isEmpty())
    }

    @Test
    fun `a hub paired after start registers exactly once more`() = test { h ->
        h.registry.addHub(hubA)
        h.registrar.start()
        advanceUntilIdle()
        h.gateway.registrations.clear()

        h.registry.addHub(hubB)
        advanceUntilIdle()

        assertEquals(listOf(hubB), h.gateway.registrations.map { it.hubUrl })
    }

    @Test
    fun `removing a hub does not trigger any registration`() = test { h ->
        h.registry.addHub(hubA)
        h.registry.addHub(hubB, makeActive = false)
        h.registrar.start()
        advanceUntilIdle()
        h.gateway.registrations.clear()

        h.registry.removeHub(hubB)
        advanceUntilIdle()

        assertTrue(h.gateway.registrations.isEmpty())
    }

    @Test
    fun `transient failure on one hub schedules a retry and spares the rest`() = test { h ->
        h.registry.addHub(hubA)
        h.registry.addHub(hubB, makeActive = false)
        h.gateway.failures[hubA] = IOException("hub offline")

        h.registrar.start()
        advanceUntilIdle()

        assertEquals(listOf(hubA), h.retries.retries)
        assertEquals(listOf(hubB), h.gateway.registrations.map { it.hubUrl })
    }

    @Test
    fun `5xx schedules a retry, 400 does not`() = test { h ->
        h.registry.addHub(hubA)
        h.registry.addHub(hubB, makeActive = false)
        h.gateway.failures[hubA] = ApiError(status = 503, body = "overloaded")
        h.gateway.failures[hubB] = ApiError(status = 400, body = """{"error":"Invalid body"}""")

        h.registrar.start()
        advanceUntilIdle()

        assertEquals(listOf(hubA), h.retries.retries)
    }

    @Test
    fun `onNewToken re-registers the rotated token everywhere`() = test { h ->
        h.registry.addHub(hubA)
        h.registry.addHub(hubB, makeActive = false)

        h.registrar.onNewToken("fcm-token-2")
        advanceUntilIdle()

        assertEquals(
            listOf(hubA to "fcm-token-2", hubB to "fcm-token-2"),
            h.gateway.registrations.map { it.hubUrl to it.token },
        )
    }

    @Test
    fun `null token (push unavailable) no-ops the start, retry and unregister paths`() = test(token = null) { h ->
        h.registry.addHub(hubA)

        h.registrar.start()
        advanceUntilIdle()
        h.registrar.registerHubOnce(hubA)
        h.registrar.unregisterHub(hubA)

        assertTrue(h.gateway.registrations.isEmpty())
        assertTrue(h.gateway.unregistrations.isEmpty())
        assertTrue(h.retries.retries.isEmpty())

        // onNewToken is the exception by design: the token arrives straight
        // from FCM (Firebase is evidently configured), so it registers even
        // though the pull-based source still answers null.
        h.registrar.onNewToken("rotated")
        advanceUntilIdle()
        assertEquals(listOf(hubA to "rotated"), h.gateway.registrations.map { it.hubUrl to it.token })
    }

    @Test
    fun `unregister sends the token and swallows failures`() = test { h ->
        h.registry.addHub(hubA)
        h.registry.addHub(hubB, makeActive = false)
        h.gateway.failures[hubB] = IOException("gone")

        h.registrar.unregisterHub(hubA)
        h.registrar.unregisterHub(hubB) // must not throw

        assertEquals(listOf(hubA to "fcm-token-1"), h.gateway.unregistrations)
        assertTrue(h.retries.retries.isEmpty()) // sign-out never schedules retries
    }

    @Test
    fun `deviceId is threaded stably into every registration`() = test { h ->
        h.registry.addHub(hubA)

        h.registrar.registerHubOnce(hubA)
        h.registrar.onNewToken("fcm-token-3")
        advanceUntilIdle()

        assertEquals(setOf("device-uuid"), h.gateway.registrations.map { it.deviceId }.toSet())
        assertEquals(2, h.gateway.registrations.size)
    }
}
