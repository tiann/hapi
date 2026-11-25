package app.hapi.companion.feature.share

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import app.hapi.companion.di.DataStoreChatDrafts
import app.hapi.data.api.HapiApi
import app.hapi.data.store.MessageWindowStores
import app.hapi.data.store.SessionStore
import app.hapi.data.store.WindowSnapshots
import app.hapi.protocol.window.MessageStatus
import app.hapi.protocol.window.PersistedMessageWindow
import app.hapi.protocol.window.WindowMessage
import app.hapi.protocol.window.buildOptimisticMessage
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Rule
import org.junit.rules.TemporaryFolder

class StoreShareSessionGatewayTest {
    @get:Rule val temp = TemporaryFolder()

    @Test fun `confirmed Share reopen restores failed sends from the cold source window`() = runTest {
        val moved = reopenFromColdSnapshot(verifiedNamespace = "owner")
        assertEquals(listOf("failed"), moved.map { it.localId })
        assertEquals(MessageStatus.Failed, moved.single().status)
    }

    @Test fun `Share does not restore legacy rows when source detail has another namespace`() = runTest {
        assertTrue(reopenFromColdSnapshot(verifiedNamespace = "other").isEmpty())
    }

    private suspend fun TestScope.reopenFromColdSnapshot(verifiedNamespace: String): List<WindowMessage> {
        val hub = "https://share.example.test"
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            val payload = when (request.method to request.url.encodedPath) {
                "GET" to "/api/sessions/source" -> """
                    {"session":{"id":"source","namespace":"$verifiedNamespace","seq":0,"createdAt":0,"updatedAt":0,
                    "active":false,"metadataVersion":0,"agentStateVersion":0,"thinking":false,"thinkingAt":0}}
                """.trimIndent()
                "POST" to "/api/sessions/source/reopen" -> """{"sessionId":"replacement","resumed":true}"""
                "GET" to "/api/sessions" -> """{"sessions":[]}"""
                else -> error("Unexpected request: ${request.method} ${request.url.encodedPath}")
            }
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(payload.toResponseBody("application/json".toMediaType())).build()
        }.build()
        val api = HapiApi(hub, client)
        val legacy = WindowSnapshots(temp.newFolder(), io = Dispatchers.Unconfined)
        val current = WindowSnapshots(temp.newFolder(), io = Dispatchers.Unconfined)
        legacy.save("source", PersistedMessageWindow(messages = listOf(
            buildOptimisticMessage("failed", "unsent", 10, status = MessageStatus.Failed),
            buildOptimisticMessage("queued", "do not migrate", 20, status = MessageStatus.Queued),
        )))
        val windows = MessageWindowStores(api, backgroundScope, current, legacySnapshots = legacy, snapshotNamespace = "owner")
        val drafts = DataStoreChatDrafts(
            PreferenceDataStoreFactory.create(scope = backgroundScope) { File(temp.root, "drafts.preferences_pb") },
            hub,
        )
        drafts.save("source", "draft")
        val controller = ShareTargetController(StoreShareSessionGateway(SessionStore(api, backgroundScope), windows, drafts), backgroundScope)

        controller.select("source")
        assertEquals("source", controller.state.first { !it.busy }.confirmSessionId)
        assertNull(windows.peek("source"), "Do not open a legacy window just to ask for confirmation")

        controller.select("source", confirmReopen = true)
        assertEquals("replacement", controller.state.first { !it.busy }.resolvedSessionId)
        assertEquals("draft", drafts.load("replacement"))
        return current.load("replacement")?.messages.orEmpty()
    }
}
