// Dispatchers.setMain + advanceUntilIdle are still experimental in coroutines-test.
@file:OptIn(ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.pairing

import app.hapi.data.api.ApiError
import app.hapi.data.auth.HubRegistry
import app.hapi.data.auth.InMemoryCredentialStore
import app.hapi.data.auth.InMemoryHubRegistryStorage
import app.hapi.protocol.pairing.BindLink
import app.hapi.protocol.wire.AuthResponse
import app.hapi.protocol.wire.AuthUser
import app.hapi.protocol.wire.HubHealthResponse
import app.hapi.protocol.wire.SUPPORTED_PROTOCOL_VERSION
import java.io.IOException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before

private const val HUB = "https://localhost:3006"

/** Programmable [PairingClient]: default = healthy v1 hub + accepted token. */
private class FakePairingClient : PairingClient {
    var healthResult: () -> HubHealthResponse =
        { HubHealthResponse(status = "ok", protocolVersion = SUPPORTED_PROTOCOL_VERSION) }
    var authResult: (String) -> AuthResponse =
        { AuthResponse(token = "jwt-1", user = AuthUser(id = 1)) }

    val authCalls = mutableListOf<String>()

    override suspend fun health(): HubHealthResponse = healthResult()

    override suspend fun authenticate(accessToken: String): AuthResponse {
        authCalls += accessToken
        return authResult(accessToken)
    }
}

class PairingViewModelTest {

    private val dispatcher = StandardTestDispatcher()
    private val client = FakePairingClient()
    private val requestedUrls = mutableListOf<String>()
    private val credentialStore = InMemoryCredentialStore()
    private val registry = HubRegistry(InMemoryHubRegistryStorage())

    private fun viewModel() = PairingViewModel(
        clientFactory = PairingClientFactory { hubUrl ->
            requestedUrls += hubUrl
            client
        },
        credentialStore = credentialStore,
        registry = registry,
        ioDispatcher = dispatcher,
        nowMs = { 1_234L },
    )

    @Before
    fun setUp() {
        kotlinx.coroutines.Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        kotlinx.coroutines.Dispatchers.resetMain()
    }

    private fun runVmTest(block: suspend TestScope.() -> Unit) = runTest(dispatcher, testBody = block)

    @Test
    fun `success path stores credentials then registers and activates the hub`() = runVmTest {
        val vm = viewModel()

        // Sloppy spelling + padded token: normalized origin, trimmed (never split) token.
        vm.pair("HTTPS://LocalHost:3006/some/path", "  tok_9f8:team  ")
        assertEquals(PairingUiState.Validating, vm.state.value)

        advanceUntilIdle()

        assertEquals(PairingUiState.Success(HUB), vm.state.value)
        assertEquals(listOf(HUB), requestedUrls)
        assertEquals(listOf("tok_9f8:team"), client.authCalls)

        val credentials = credentialStore.get(HUB)
        assertEquals("tok_9f8:team", credentials?.accessToken)
        assertEquals("jwt-1", credentials?.jwt)
        assertEquals(1_234L, credentials?.jwtObtainedAtMs)

        assertEquals(listOf(HUB), registry.state.value.hubs)
        assertEquals(HUB, registry.activeHubUrl)
    }

    @Test
    fun `unreachable hub surfaces a reachability error and touches nothing`() = runVmTest {
        client.healthResult = { throw IOException("connection refused") }
        val vm = viewModel()

        vm.pair(HUB, "tok")
        advanceUntilIdle()

        assertEquals(PairingUiState.Error(PairingError.Unreachable(HUB)), vm.state.value)
        assertTrue(client.authCalls.isEmpty())
        assertNull(credentialStore.get(HUB))
        assertNull(registry.activeHubUrl)
    }

    @Test
    fun `rejected access token maps 401 to the re-pair message`() = runVmTest {
        client.authResult = { throw ApiError(status = 401, code = "Invalid access token") }
        val vm = viewModel()

        vm.pair(HUB, "rotated-token")
        advanceUntilIdle()

        assertEquals(PairingUiState.Error(PairingError.TokenRejected), vm.state.value)
        assertNull(credentialStore.get(HUB))
        assertNull(registry.activeHubUrl)
    }

    @Test
    fun `non-https or malformed url errors immediately without any network call`() = runVmTest {
        val vm = viewModel()

        vm.pair("not a url", "tok")

        assertEquals(PairingUiState.Error(PairingError.InvalidUrl), vm.state.value)
        vm.dismissError()
        assertEquals(PairingUiState.Idle, vm.state.value)

        vm.pair("ftp://hub.example", "tok")
        assertEquals(PairingUiState.Error(PairingError.InvalidUrl), vm.state.value)

        vm.pair("http://hub.example", "tok")
        assertEquals(PairingUiState.Error(PairingError.InvalidUrl), vm.state.value)

        advanceUntilIdle()
        assertTrue(requestedUrls.isEmpty())
    }

    @Test
    fun `protocol mismatch is rejected before the token exchange`() = runVmTest {
        client.healthResult = { HubHealthResponse(status = "ok", protocolVersion = 99) }
        val vm = viewModel()

        vm.pair(HUB, "tok")
        advanceUntilIdle()

        assertEquals(
            PairingUiState.Error(PairingError.ProtocolMismatch(99, SUPPORTED_PROTOCOL_VERSION)),
            vm.state.value,
        )
        assertTrue(client.authCalls.isEmpty())
    }

    @Test
    fun `hub that answers garbage maps to the not-a-hub message`() = runVmTest {
        client.healthResult = { throw ApiError(status = 404, code = null, body = "<html>") }
        val vm = viewModel()

        vm.pair(HUB, "tok")
        advanceUntilIdle()

        assertEquals(PairingUiState.Error(PairingError.NotAHub(HUB)), vm.state.value)
    }

    @Test
    fun `deep link prefill normalizes and flags an already-paired hub`() = runVmTest {
        registry.addHub("https://hub.example")
        val vm = viewModel()

        vm.prefillFromLink(BindLink(hubUrl = "https://Hub.Example/", accessToken = "code1"))
        assertEquals(
            BindPrefill(hubUrl = "https://hub.example", accessToken = "code1", alreadyPaired = true),
            vm.prefill.value,
        )

        vm.prefillFromLink(BindLink(hubUrl = "https://other.example:8443", accessToken = "code2"))
        assertEquals(
            BindPrefill(hubUrl = "https://other.example:8443", accessToken = "code2", alreadyPaired = false),
            vm.prefill.value,
        )
    }

    @Test
    fun `switch choice re-activates the existing pairing without re-exchanging`() = runVmTest {
        registry.addHub("https://a.example")
        registry.addHub("https://b.example") // active
        val vm = viewModel()

        vm.prefillFromLink(BindLink(hubUrl = "https://a.example", accessToken = "code"))
        vm.switchToPrefilledHub()
        advanceUntilIdle()

        assertEquals(PairingUiState.Success("https://a.example"), vm.state.value)
        assertEquals("https://a.example", registry.activeHubUrl)
        assertTrue(requestedUrls.isEmpty())
        assertTrue(client.authCalls.isEmpty())
    }

    @Test
    fun `re-pairing an existing hub overwrites its credentials`() = runVmTest {
        val vm = viewModel()
        vm.pair(HUB, "old-token")
        advanceUntilIdle()
        assertIs<PairingUiState.Success>(vm.state.value)

        client.authResult = { AuthResponse(token = "jwt-2", user = AuthUser(id = 1)) }
        vm.pair(HUB, "new-token")
        advanceUntilIdle()

        val credentials = credentialStore.get(HUB)
        assertEquals("new-token", credentials?.accessToken)
        assertEquals("jwt-2", credentials?.jwt)
        assertEquals(listOf(HUB), registry.state.value.hubs)
    }
}
