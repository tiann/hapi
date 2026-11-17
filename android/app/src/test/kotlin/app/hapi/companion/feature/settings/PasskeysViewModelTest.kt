@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.feature.settings

import app.hapi.protocol.wire.NativePasskeys
import app.hapi.companion.feature.passkey.boundPasskeyOptions
import app.hapi.companion.feature.passkey.FakePasskeyPlatform
import app.hapi.companion.feature.passkey.PasskeyCeremonyException
import app.hapi.companion.feature.passkey.PasskeyIssue
import app.hapi.data.api.ApiError
import app.hapi.protocol.wire.PasskeySummary
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Settings → Passkeys: list ordering, add ceremony wiring, delete, failures. */
class PasskeysViewModelTest {

    private fun TestScope.newVmScope(): CoroutineScope =
        CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScheduler))

    private class FakeGateway : PasskeysGateway {
        override val hubUrl = "https://hub.example.com"
        var passkeys = mutableListOf<PasskeySummary>()
        var options: () -> String = {
            boundPasskeyOptions(hubUrl, "register")
        }
        var verifyError: Exception? = null
        val verified = mutableListOf<Pair<JsonObject, String?>>()
        val deleted = mutableListOf<String>()

        override suspend fun list(): List<PasskeySummary> = passkeys.toList()
        override suspend fun registerOptions(): String = options()
        override suspend fun registerVerify(response: JsonObject, name: String?) {
            verifyError?.let { throw it }
            verified += response to name
            passkeys += PasskeySummary(id = "new", name = name, rpId = "auth.hapi.run", createdAt = 99)
        }
        override suspend fun delete(id: String) {
            deleted += id
            passkeys.removeAll { it.id == id }
        }
    }

    private fun passkey(id: String, rpId: String = "auth.hapi.run", createdAt: Long = 1, valid: Boolean = true) =
        PasskeySummary(id = id, name = id, rpId = rpId, createdAt = createdAt, valid = valid)

    @Test
    fun `lists app passkeys first, newest first`() = runTest {
        val gateway = FakeGateway().apply {
            passkeys += passkey("web-new", rpId = "hub.example", createdAt = 30)
            passkeys += passkey("app-old", createdAt = 10)
            passkeys += passkey("app-new", createdAt = 20, valid = false)
        }
        val vm = PasskeysViewModel(gateway, newVmScope())

        vm.start()
        advanceUntilIdle()

        val data = vm.state.value as PasskeysUiState.Data
        assertEquals(listOf("app-new", "app-old", "web-new"), data.passkeys.map { it.id })
        assertEquals(listOf(true, true, false), data.passkeys.map { it.isAppPasskey })
    }

    @Test
    fun `add hands the options to the platform and verifies with the trimmed name`() = runTest {
        val gateway = FakeGateway()
        val platform = FakePasskeyPlatform()
        val vm = PasskeysViewModel(gateway, newVmScope())
        vm.start()
        advanceUntilIdle()

        vm.addPasskey("  Pixel 9  ", platform)
        assertEquals(PasskeysBusy.Adding, vm.busy.value)
        advanceUntilIdle()

        assertEquals(listOf(NativePasskeys.ceremonyOptions(gateway.options(), gateway.hubUrl, "register")), platform.createRequests)
        val (response, name) = gateway.verified.single()
        assertEquals("Pixel 9", name)
        assertEquals("public-key", response["type"]?.jsonPrimitive?.content)
        assertTrue("authenticatorAttachment" !in response.keys, "null members are stripped")
        assertEquals(PasskeysNotice.Added, vm.notice.value)
        assertNull(vm.busy.value)
        assertEquals(listOf("new"), (vm.state.value as PasskeysUiState.Data).passkeys.map { it.id })
    }

    @Test
    fun `add refuses options for a foreign relying party`() = runTest {
        val gateway = FakeGateway().apply {
            options = { """{"rp":{"id":"evil.example"},"challenge":"Y2g"}""" }
        }
        val platform = FakePasskeyPlatform()
        val vm = PasskeysViewModel(gateway, newVmScope())

        vm.addPasskey("x", platform)
        advanceUntilIdle()

        assertTrue(platform.createRequests.isEmpty())
        assertTrue(gateway.verified.isEmpty())
        assertEquals(PasskeysNotice.Failed(PasskeyIssue.RpMismatch("evil.example")), vm.notice.value)
    }

    @Test
    fun `cancelled ceremony is silent`() = runTest {
        val gateway = FakeGateway()
        val platform = FakePasskeyPlatform().apply {
            createResult = { throw PasskeyCeremonyException.Cancelled() }
        }
        val vm = PasskeysViewModel(gateway, newVmScope())

        vm.addPasskey("x", platform)
        advanceUntilIdle()

        assertNull(vm.notice.value)
        assertNull(vm.busy.value)
        assertTrue(gateway.verified.isEmpty())
    }

    @Test
    fun `duplicate registration surfaces AlreadyRegistered`() = runTest {
        val gateway = FakeGateway().apply {
            verifyError = ApiError.from(409, """{"error":"Passkey already registered"}""")
        }
        val vm = PasskeysViewModel(gateway, newVmScope())

        vm.addPasskey("x", FakePasskeyPlatform())
        advanceUntilIdle()

        assertEquals(PasskeysNotice.Failed(PasskeyIssue.AlreadyRegistered), vm.notice.value)
    }

    @Test
    fun `delete removes the passkey and reloads`() = runTest {
        val gateway = FakeGateway().apply { passkeys += passkey("a"); passkeys += passkey("b") }
        val vm = PasskeysViewModel(gateway, newVmScope())
        vm.start()
        advanceUntilIdle()

        vm.deletePasskey("a")
        assertEquals(PasskeysBusy.Deleting("a"), vm.busy.value)
        advanceUntilIdle()

        assertEquals(listOf("a"), gateway.deleted)
        assertEquals(PasskeysNotice.Deleted, vm.notice.value)
        assertEquals(listOf("b"), (vm.state.value as PasskeysUiState.Data).passkeys.map { it.id })
    }

    @Test
    fun `default name is the device model clamped to the hub limit`() {
        assertEquals("Pixel 9", defaultPasskeyName(" Pixel 9 "))
        assertEquals(64, defaultPasskeyName("x".repeat(100)).length)
        assertEquals("", defaultPasskeyName(null))
    }
}
