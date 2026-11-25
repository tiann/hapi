@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.di

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import app.hapi.companion.feature.pairing.PairingClient
import app.hapi.companion.feature.pairing.PairingUiState
import app.hapi.companion.feature.passkey.FakePasskeyPlatform
import app.hapi.companion.feature.passkey.passkeyAssertion
import app.hapi.companion.feature.passkey.passkeyUserHandle
import app.hapi.data.auth.HubCredentials
import app.hapi.data.auth.InMemoryCredentialStore
import app.hapi.protocol.wire.AuthResponse
import app.hapi.protocol.wire.AuthUser
import app.hapi.protocol.wire.HubHealthResponse
import app.hapi.protocol.wire.PasskeyLoginResponse
import app.hapi.protocol.wire.SUPPORTED_PROTOCOL_VERSION
import java.util.Base64
import kotlin.test.assertEquals
import kotlin.test.assertNotSame
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class AppGraphPairingTest {
    @Test fun `same origin re-pairing switches the skills history before completing`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val hubUrl = "https://skills.example.test"
        val ownerJwt = jwt("owner")
        val guestJwt = jwt("guest")
        val creds = InMemoryCredentialStore().apply { set(HubCredentials(hubUrl, accessToken = "owner", jwt = ownerJwt)) }
        val app = AppGraph(context, creds)
        Dispatchers.setMain(UnconfinedTestDispatcher())
        try {
            withTimeout(10_000) {
                app.setForeground(false)
                app.hubRegistry.addHub(hubUrl)
                app.start()
                val owner = app.activeHubGraph.filterNotNull().first()
                assertEquals(ownerJwt, owner.session.authenticator.currentJwt())
                requireNotNull(owner.recentSkills).record("owner-only")

                val pairing = app.newPairingViewModel {
                    object : PairingClient {
                        override suspend fun health() = HubHealthResponse(status = "ok", protocolVersion = SUPPORTED_PROTOCOL_VERSION)
                        override suspend fun authenticate(accessToken: String) = AuthResponse(token = guestJwt, user = AuthUser(id = 1))
                        override suspend fun passkeyLoginVerify(response: JsonObject) =
                            PasskeyLoginResponse(token = ownerJwt, user = AuthUser(id = 1), passkeySession = "owner-passkey")
                    }
                }
                pairing.pair(hubUrl, "guest")
                assertEquals(PairingUiState.Success(hubUrl), pairing.state.first { it != PairingUiState.Validating })

                val guest = requireNotNull(app.activeHubGraph.value)
                assertNotSame(owner, guest)
                assertEquals(guestJwt, guest.session.authenticator.currentJwt())
                val guestHistory = requireNotNull(guest.recentSkills)
                assertEquals(emptyList(), guestHistory.names.first())
                guestHistory.record("guest-only")

                val platform = FakePasskeyPlatform().apply { getResult = { passkeyAssertion(passkeyUserHandle(hubUrl)) } }
                pairing.signInWithPasskey(hubUrl, platform)
                assertEquals(PairingUiState.Success(hubUrl), pairing.state.first { it != PairingUiState.Validating })

                val ownerAgain = requireNotNull(app.activeHubGraph.value)
                assertNotSame(guest, ownerAgain)
                assertEquals(ownerJwt, ownerAgain.session.authenticator.currentJwt())
                assertEquals(listOf("owner-only"), requireNotNull(ownerAgain.recentSkills).names.first())
                assertEquals(listOf("guest-only"), guestHistory.names.first())
                assertEquals(listOf(hubUrl), app.hubRegistry.state.value.hubs)
            }
        } finally {
            app.scope.cancel()
            app.activeHubGraph.value?.close()
            Dispatchers.resetMain()
        }
    }

    private fun jwt(namespace: String): String {
        val exp = System.currentTimeMillis() / 1000 + 3_600
        val payload = Base64.getUrlEncoder().withoutPadding()
            .encodeToString("""{"uid":1,"ns":"$namespace","exp":$exp}""".encodeToByteArray())
        return "header.$payload.signature"
    }
}
