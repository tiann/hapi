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
import app.hapi.data.sse.SseSubscriptionKey
import app.hapi.protocol.wire.AuthResponse
import app.hapi.protocol.wire.AuthUser
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.HubHealthResponse
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.OptionalField
import app.hapi.protocol.wire.PasskeyLoginResponse
import app.hapi.protocol.wire.SUPPORTED_PROTOCOL_VERSION
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SyncEvent
import java.io.File
import java.util.Base64
import kotlin.test.assertEquals
import kotlin.test.assertNotSame
import kotlin.test.assertTrue
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
    @Test fun `same origin re-pairing switches skills history and snapshots before completing`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val hubUrl = "https://skills.example.test"
        val legacy = File(context.filesDir, "hubs/https___skills.example.test/sessions.json")
        val legacyData = """[{"id":"legacy-session","active":false}]"""
        legacy.parentFile?.mkdirs()
        legacy.writeText(legacyData)
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
                assertTrue(owner.sessionStore.sessions.value.isEmpty(), "Do not hydrate URL-only legacy snapshots")
                requireNotNull(owner.recentSkills).record("owner-only")
                seedOwnerSnapshots(owner)

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
                assertTrue(guest.sessionStore.sessions.value.isEmpty(), "Guest must not see owner sessions")
                assertTrue(guest.machineStore.machines.value.isEmpty(), "Guest must not see owner machines")
                assertTrue(guest.messageWindows.open("owner-session").state.value.messages.isEmpty(), "Guest must not see owner messages")

                val platform = FakePasskeyPlatform().apply { getResult = { passkeyAssertion(passkeyUserHandle(hubUrl)) } }
                pairing.signInWithPasskey(hubUrl, platform)
                assertEquals(PairingUiState.Success(hubUrl), pairing.state.first { it != PairingUiState.Validating })

                val ownerAgain = requireNotNull(app.activeHubGraph.value)
                assertNotSame(guest, ownerAgain)
                assertEquals(ownerJwt, ownerAgain.session.authenticator.currentJwt())
                assertEquals(listOf("owner-only"), requireNotNull(ownerAgain.recentSkills).names.first())
                assertEquals(listOf("guest-only"), guestHistory.names.first())
                assertEquals(listOf("owner-session"), ownerAgain.sessionStore.sessions.value.map { it.id })
                assertEquals(listOf("owner-machine"), ownerAgain.machineStore.machines.value.map { it.id })
                val restoredMessages = ownerAgain.messageWindows.open("owner-session").state.value.messages
                assertEquals("owner-message", restoredMessages.single().localId)
                assertEquals(legacyData, legacy.readText(), "Keep legacy data untouched")
                assertEquals(listOf(hubUrl), app.hubRegistry.state.value.hubs)
            }
        } finally {
            app.scope.cancel()
            app.activeHubGraph.value?.close()
            Dispatchers.resetMain()
        }
    }

    private suspend fun seedOwnerSnapshots(graph: HubGraph) {
        val row = Session(
            id = "owner-session", namespace = "owner", seq = 1, createdAt = 1, updatedAt = 1,
            active = false, metadataVersion = 0, agentStateVersion = 0, thinking = false, thinkingAt = 0,
        )
        graph.sessionStore.applySessionEvent(
            SseSubscriptionKey.Global,
            SyncEvent.SessionAdded(sessionId = row.id, data = HapiJson.encodeToJsonElement(Session.serializer(), row)),
        )
        val machine = Machine(
            id = "owner-machine", namespace = "owner", seq = 1, createdAt = 1, updatedAt = 1,
            active = true, activeAt = 1, metadataVersion = 0, runnerStateVersion = 0,
        )
        graph.machineStore.applyMachineEvent(
            SyncEvent.MachineUpdated(
                machineId = machine.id,
                data = OptionalField.Present(HapiJson.encodeToJsonElement(Machine.serializer(), machine)),
            ),
        )
        graph.sessionStore.flushPersistence()
        graph.machineStore.flushPersistence()
        graph.messageWindows.open(row.id).appendOptimistic(localId = "owner-message", text = "owner-only transcript")
    }

    private fun jwt(namespace: String): String {
        val exp = System.currentTimeMillis() / 1000 + 3_600
        val payload = Base64.getUrlEncoder().withoutPadding()
            .encodeToString("""{"uid":1,"ns":"$namespace","exp":$exp}""".encodeToByteArray())
        return "header.$payload.signature"
    }
}
