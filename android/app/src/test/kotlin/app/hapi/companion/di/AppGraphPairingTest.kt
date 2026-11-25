@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package app.hapi.companion.di

import android.app.Application
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.lifecycle.viewModelScope
import app.hapi.companion.feature.pairing.PairingClient
import app.hapi.companion.feature.pairing.PairingUiState
import app.hapi.companion.feature.passkey.FakePasskeyPlatform
import app.hapi.companion.feature.passkey.passkeyAssertion
import app.hapi.companion.feature.passkey.passkeyUserHandle
import app.hapi.data.auth.CredentialStore
import app.hapi.data.auth.HubCredentials
import app.hapi.data.auth.InMemoryCredentialStore
import app.hapi.data.push.DeviceRegistrar
import app.hapi.data.push.PushDeviceGateway
import app.hapi.data.push.PushIdentity
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertNotSame
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
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
        val registrations = Channel<String>(Channel.UNLIMITED)
        val app = AppGraph(context, creds, deviceRegistrarFactory = { registry, scope ->
            DeviceRegistrar(
                registry = registry,
                gateway = object : PushDeviceGateway {
                    override suspend fun register(hubUrl: String, token: String, identity: PushIdentity) {
                        registrations.send(requireNotNull(creds.get(hubUrl)?.pairedNamespace))
                    }

                    override suspend fun unregister(hubUrl: String, token: String) = Unit
                },
                tokenSource = { "device-token" },
                identities = { PushIdentity("device-id", "push-key") },
                retryScheduler = { error("Unexpected push registration retry") },
                scope = scope,
            )
        })
        Dispatchers.setMain(UnconfinedTestDispatcher())
        try {
            withTimeout(10_000) {
                app.setForeground(false)
                app.hubRegistry.addHub(hubUrl)
                app.start()
                val owner = app.activeHubGraph.filterNotNull().first()
                assertEquals(ownerJwt, owner.session.authenticator.currentJwt())
                assertEquals("owner", registrations.receive())
                assertTrue(owner.sessionStore.sessions.value.isEmpty(), "Do not hydrate URL-only legacy snapshots")
                owner.recentSkills.record("owner-only")
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
                assertEquals("guest", registrations.receive())
                val guestHistory = guest.recentSkills
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

                val paired = requireNotNull(creds.get(hubUrl))
                val withoutJwt = InMemoryCredentialStore().apply { set(paired.copy(jwt = null, jwtObtainedAtMs = null)) }
                HubGraph(hubUrl, withoutJwt, { _, _ -> }, context).use { restarted ->
                    assertEquals("owner", restarted.pairedNamespace)
                    assertEquals(listOf("owner-session"), restarted.sessionStore.sessions.value.map { it.id })
                    assertEquals(listOf("owner-only"), restarted.recentSkills.names.first())
                }
            }
        } finally {
            app.scope.cancel()
            app.activeHubGraph.value?.close()
            Dispatchers.resetMain()
        }
    }

    @Test fun `dismissing pairing after storing credentials still publishes the new graph`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val hubUrl = "https://cancel-pairing.example.test"
        val ownerJwt = jwt("owner")
        val guestJwt = jwt("guest")
        val stored = CompletableDeferred<Unit>()
        val releaseWrite = CountDownLatch(1)
        val backing = InMemoryCredentialStore().apply { set(HubCredentials(hubUrl, accessToken = "owner", jwt = ownerJwt)) }
        val creds = object : CredentialStore by backing {
            override fun set(credentials: HubCredentials) {
                backing.set(credentials)
                if (credentials.jwt == guestJwt) {
                    stored.complete(Unit)
                    check(releaseWrite.await(5, TimeUnit.SECONDS))
                }
            }
        }
        val app = AppGraph(context, creds)
        Dispatchers.setMain(UnconfinedTestDispatcher())
        try {
            withTimeout(5_000) {
                app.setForeground(false)
                app.hubRegistry.addHub(hubUrl)
                app.start()
                val owner = app.activeHubGraph.filterNotNull().first()
                val pairing = app.newPairingViewModel {
                    object : PairingClient {
                        override suspend fun health() = HubHealthResponse(status = "ok", protocolVersion = SUPPORTED_PROTOCOL_VERSION)
                        override suspend fun authenticate(accessToken: String) = AuthResponse(token = guestJwt, user = AuthUser(id = 1))
                        override suspend fun passkeyLoginVerify(response: JsonObject): PasskeyLoginResponse = error("Not used")
                    }
                }
                pairing.pair(hubUrl, "guest")
                stored.await()
                pairing.viewModelScope.cancel()
                releaseWrite.countDown()

                val guest = app.activeHubGraph.filterNotNull().first { it !== owner }
                assertEquals(guestJwt, creds.get(hubUrl)?.jwt)
                assertEquals(guestJwt, guest.session.authenticator.currentJwt())
                assertEquals("guest", guest.pairedNamespace)
            }
        } finally {
            releaseWrite.countDown()
            app.scope.cancel()
            app.activeHubGraph.value?.close()
            Dispatchers.resetMain()
        }
    }

    @Test fun `legacy background refresh recovers persistence without replacing the live graph`() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val hubUrl = "https://legacy-skills.example.test"
        val legacy = HubCredentials(hubUrl, accessToken = "owner")
        val creds = InMemoryCredentialStore().apply { set(legacy) }
        val app = AppGraph(context, creds)
        try {
            withTimeout(10_000) {
                app.setForeground(false)
                app.hubRegistry.addHub(hubUrl)
                app.start()
                val live = app.activeHubGraph.filterNotNull().first()
                seedOwnerSnapshots(live)
                val window = live.messageWindows.open("owner-session")
                val history = live.recentSkills

                // The push worker's independent authenticator updates the shared store.
                assertTrue(creds.replace(legacy, legacy.withJwt(jwt("owner"), System.currentTimeMillis())))
                assertTrue(live.session.authenticator.ensureFreshToken() != null)
                HubGraph(hubUrl, creds, { _, _ -> }, context).use { known ->
                    known.recentSkills.record("owner-only")
                    assertEquals(listOf("owner-only"), history.names.first { it.isNotEmpty() })
                }

                assertSame(live, app.activeHubGraph.value)
                assertSame(window, live.messageWindows.open("owner-session"))
                assertEquals(listOf("owner-session"), live.sessionStore.sessions.value.map { it.id })
                live.sessionStore.flushPersistence()
                live.machineStore.flushPersistence()
                HubGraph(hubUrl, creds, { _, _ -> }, context).use { restarted ->
                    assertEquals(listOf("owner-session"), restarted.sessionStore.sessions.value.map { it.id })
                    assertEquals(listOf("owner-machine"), restarted.machineStore.machines.value.map { it.id })
                    assertEquals(1, restarted.messageWindows.open("owner-session").state.value.messages.size)
                }
            }
        } finally {
            app.scope.cancel()
            app.activeHubGraph.value?.close()
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
