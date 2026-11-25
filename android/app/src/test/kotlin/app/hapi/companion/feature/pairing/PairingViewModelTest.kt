// Dispatchers.setMain + advanceUntilIdle are still experimental in coroutines-test.
@file:OptIn(ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.pairing

import app.hapi.companion.feature.passkey.FakePasskeyPlatform
import app.hapi.companion.feature.passkey.PasskeyCeremonyException
import app.hapi.companion.feature.passkey.PasskeyIssue
import app.hapi.companion.feature.passkey.opaquePasskeyUserHandle
import app.hapi.companion.feature.passkey.passkeyAssertion
import app.hapi.companion.feature.passkey.passkeyUserHandle
import app.hapi.data.api.ApiError
import app.hapi.data.auth.HubRegistry
import app.hapi.data.auth.InMemoryCredentialStore
import app.hapi.data.auth.InMemoryHubRegistryStorage
import app.hapi.protocol.pairing.BindLink
import app.hapi.protocol.wire.AuthResponse
import app.hapi.protocol.wire.AuthUser
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.HubHealthResponse
import app.hapi.protocol.wire.PasskeyLoginResponse
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
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
    var healthCalls = 0

    override suspend fun health(): HubHealthResponse {
        healthCalls++
        return healthResult()
    }

    override suspend fun authenticate(accessToken: String): AuthResponse {
        authCalls += accessToken
        return authResult(accessToken)
    }

    var loginVerifyResult: (JsonObject) -> PasskeyLoginResponse = {
        PasskeyLoginResponse(token = "jwt-passkey", user = AuthUser(id = 1), passkeySession = "ps-1")
    }
    val verifyBodies = mutableListOf<JsonObject>()

    override suspend fun passkeyLoginVerify(response: JsonObject): PasskeyLoginResponse {
        verifyBodies += response
        return loginVerifyResult(response)
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

    // ------------------------------------------------------------ passkeys --

    /** A platform whose selected credential names [hub] in its user handle. */
    private fun platformFor(hub: String = HUB) = FakePasskeyPlatform().apply {
        getResult = { passkeyAssertion(passkeyUserHandle(hub)) }
    }

    @Test
    fun `one ceremony locates the Hub from the passkey then probes and verifies`() = runVmTest {
        val platform = platformFor()
        val vm = viewModel()

        vm.signInWithPasskey(null, platform)
        assertEquals(PairingUiState.Validating, vm.state.value)
        advanceUntilIdle()

        assertEquals(PairingUiState.Success(HUB), vm.state.value)
        assertEquals(1, platform.getRequests.size, "a single system sheet")
        val options = HapiJson.parseToJsonElement(platform.getRequests.single()).jsonObject
        assertEquals(setOf("challenge", "rpId", "userVerification", "timeout"), options.keys)
        val challenge = HapiJson.parseToJsonElement(
            String(java.util.Base64.getUrlDecoder().decode(options.getValue("challenge").jsonPrimitive.content)),
        ).jsonObject
        assertEquals(1_234L, challenge.getValue("iat").jsonPrimitive.long, "iat comes from the injected clock")

        // Only health + verify reach the Hub; there is no options request.
        assertEquals(listOf(HUB), requestedUrls)
        assertEquals(1, client.healthCalls)
        assertTrue(client.authCalls.isEmpty(), "no access-token exchange on the passkey path")
        val verified = client.verifyBodies.single()
        assertEquals("Y3JlZA", verified["rawId"]?.jsonPrimitive?.content)

        val credentials = credentialStore.get(HUB)
        assertNull(credentials?.accessToken)
        assertEquals("ps-1", credentials?.passkeySession)
        assertEquals("jwt-passkey", credentials?.jwt)
        assertEquals(1_234L, credentials?.jwtObtainedAtMs)
        assertEquals(HUB, registry.activeHubUrl)
    }

    @Test
    fun `passkey sign-in replaces an earlier access-token pairing`() = runVmTest {
        val vm = viewModel()
        vm.pair(HUB, "tok")
        advanceUntilIdle()

        vm.signInWithPasskey(null, platformFor())
        advanceUntilIdle()

        val credentials = credentialStore.get(HUB)
        assertNull(credentials?.accessToken)
        assertEquals("ps-1", credentials?.passkeySession)
    }

    @Test
    fun `located Hub that is unreachable fails before verify`() = runVmTest {
        client.healthResult = { throw IOException("connection refused") }
        val vm = viewModel()

        vm.signInWithPasskey(null, platformFor())
        advanceUntilIdle()

        assertEquals(PairingUiState.Error(PairingError.Unreachable(HUB)), vm.state.value)
        assertTrue(client.verifyBodies.isEmpty())
        assertNull(credentialStore.get(HUB))
    }

    @Test
    fun `passkey without a readable Hub asks for the address without any network`() = runVmTest {
        for (handle in listOf(opaquePasskeyUserHandle(HUB), null)) {
            val platform = FakePasskeyPlatform().apply { getResult = { passkeyAssertion(handle) } }
            val vm = viewModel()

            vm.signInWithPasskey(null, platform)
            advanceUntilIdle()

            assertEquals(PairingUiState.Error(PairingError.Passkey(PasskeyIssue.HubAddressRequired)), vm.state.value)
            assertEquals(1, platform.getRequests.size)
        }
        assertTrue(requestedUrls.isEmpty())
        assertEquals(0, client.healthCalls)
        assertTrue(client.verifyBodies.isEmpty())
    }

    @Test
    fun `entered Hub is probed before the ceremony and accepts its long-address passkey`() = runVmTest {
        val platform = FakePasskeyPlatform().apply { getResult = { passkeyAssertion(opaquePasskeyUserHandle(HUB)) } }
        val vm = viewModel()

        vm.signInWithPasskey("https://LocalHost:3006/", platform)
        advanceUntilIdle()

        assertEquals(PairingUiState.Success(HUB), vm.state.value)
        assertEquals(1, client.healthCalls)
        assertEquals(1, platform.getRequests.size)
        assertEquals(1, client.verifyBodies.size)
        assertEquals("ps-1", credentialStore.get(HUB)?.passkeySession)
    }

    @Test
    fun `unreachable entered Hub never opens the system sheet`() = runVmTest {
        client.healthResult = { throw IOException("connection refused") }
        val platform = platformFor()
        val vm = viewModel()

        vm.signInWithPasskey(HUB, platform)
        advanceUntilIdle()

        assertEquals(PairingUiState.Error(PairingError.Unreachable(HUB)), vm.state.value)
        assertTrue(platform.getRequests.isEmpty())
    }

    @Test
    fun `passkey for another Hub is refused for an entered Hub without verify`() = runVmTest {
        val vm = viewModel()

        vm.signInWithPasskey(HUB, platformFor("https://other.example"))
        advanceUntilIdle()

        assertEquals(PairingUiState.Error(PairingError.Passkey(PasskeyIssue.WrongHub)), vm.state.value)
        assertTrue(client.verifyBodies.isEmpty())
        assertNull(credentialStore.get(HUB))
        assertNull(credentialStore.get("https://other.example"))
        assertTrue(registry.state.value.hubs.isEmpty())
    }

    @Test
    fun `malformed entered Hub errors without a ceremony`() = runVmTest {
        val platform = platformFor()
        val vm = viewModel()

        vm.signInWithPasskey("http://hub.example", platform)

        assertEquals(PairingUiState.Error(PairingError.InvalidUrl), vm.state.value)
        advanceUntilIdle()
        assertTrue(platform.getRequests.isEmpty())
        assertTrue(requestedUrls.isEmpty())
    }

    @Test
    fun `dismissed system sheet returns to idle silently`() = runVmTest {
        for (hub in listOf(null, HUB)) {
            val platform = FakePasskeyPlatform().apply {
                getResult = { throw PasskeyCeremonyException.Cancelled() }
            }
            val vm = viewModel()

            vm.signInWithPasskey(hub, platform)
            advanceUntilIdle()

            assertEquals(PairingUiState.Idle, vm.state.value)
        }
        assertTrue(client.verifyBodies.isEmpty())
        assertNull(credentialStore.get(HUB))
    }

    @Test
    fun `no passkey on the device gets a friendly error`() = runVmTest {
        val platform = FakePasskeyPlatform().apply {
            getResult = { throw PasskeyCeremonyException.NoCredential() }
        }
        val vm = viewModel()

        vm.signInWithPasskey(null, platform)
        advanceUntilIdle()

        assertEquals(
            PairingUiState.Error(PairingError.Passkey(PasskeyIssue.NoCredentialOnDevice)),
            vm.state.value,
        )
    }

    @Test
    fun `revoked passkey is distinguished from a failed verification`() = runVmTest {
        client.loginVerifyResult = { throw ApiError.from(401, """{"error":"passkey_revoked"}""") }
        val vm = viewModel()
        vm.signInWithPasskey(null, platformFor())
        advanceUntilIdle()
        assertEquals(PairingUiState.Error(PairingError.Passkey(PasskeyIssue.Revoked)), vm.state.value)

        for (reason in listOf("Passkey challenge expired", "Unknown passkey", "Passkey verification failed")) {
            client.loginVerifyResult = { throw ApiError.from(401, """{"error":"$reason"}""") }
            vm.dismissError()
            vm.signInWithPasskey(null, platformFor())
            advanceUntilIdle()
            assertEquals(
                PairingUiState.Error(PairingError.Passkey(PasskeyIssue.VerificationFailed)),
                vm.state.value,
                reason,
            )
        }
        assertNull(credentialStore.get(HUB))
    }

}
