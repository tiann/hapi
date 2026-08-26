package app.hapi.companion.feature.chat

import app.hapi.companion.feature.sessions.SessionListViewModel
import app.hapi.data.api.ChatSessionApi
import app.hapi.data.api.MessagesQuery
import app.hapi.data.sse.SseEngine
import app.hapi.data.sse.SseRawEvent
import app.hapi.data.sse.SseTransport
import app.hapi.data.sse.TransportEvent
import app.hapi.data.store.LastSeenStore
import app.hapi.data.store.MachineListStore
import app.hapi.data.store.MessageWindowStores
import app.hapi.data.store.SessionDetailStore
import app.hapi.data.store.StoreSyncTargets
import app.hapi.protocol.chat.AgentTextBlock
import app.hapi.protocol.chat.ToolCallBlock
import app.hapi.protocol.wire.ApprovePermissionRequest
import app.hapi.protocol.wire.CancelMessageResponse
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.ResumeSessionResponse
import app.hapi.protocol.wire.RetryIndeterminateMessageResponse
import app.hapi.protocol.wire.SendMessageRequest
import app.hapi.protocol.wire.SteerQueuedMessageResponse
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MessagesPage
import app.hapi.protocol.wire.MessagesResponse
import app.hapi.protocol.wire.QueuedStateResponse
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.SyncEvent
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

private const val SESSION_ID = "sess-1"

// ------------------------------------------------------------------ fakes --

private class FakeSessionStore : SessionDetailStore {
    val summaries = MutableStateFlow<List<SessionSummary>>(emptyList())
    override val sessions: StateFlow<List<SessionSummary>> = summaries

    private val details = MutableStateFlow<Map<String, Session>>(emptyMap())
    var detailToLoad: Session? = null
    var failDetailLoad = false
    val calls = MutableStateFlow<List<String>>(emptyList())

    private fun record(call: String) {
        calls.value = calls.value + call
    }

    fun setDetail(session: Session) {
        details.value = details.value + (session.id to session)
    }

    override fun sessionDetail(sessionId: String): Flow<Session?> =
        details.map { it[sessionId] }.distinctUntilChanged()

    override suspend fun loadSessionDetail(sessionId: String): Session {
        record("loadDetail:$sessionId")
        if (failDetailLoad) throw RuntimeException("offline")
        val session = detailToLoad ?: throw RuntimeException("no scripted detail")
        details.value = details.value + (sessionId to session)
        return session
    }

    override fun currentDetail(sessionId: String): Session? = details.value[sessionId]

    override fun releaseDetail(sessionId: String) {
        details.value = details.value - sessionId
    }

    override fun updateDetailLocal(sessionId: String, transform: (Session) -> Session) {
        val current = details.value[sessionId] ?: return
        details.value = details.value + (sessionId to transform(current))
    }

    override suspend fun refresh() = record("refresh")
    override fun scheduleRefresh() = record("scheduleRefresh")
    override suspend fun fullResync() = record("fullResync")
    override fun applySessionEvent(scope: app.hapi.data.sse.SseSubscriptionKey, event: SyncEvent) =
        record("event:${event::class.simpleName}")

    override suspend fun setPinMode(sessionId: String, mode: String) = record("pin")
    override suspend fun archiveSession(sessionId: String) = record("archive")
    override suspend fun renameSession(sessionId: String, name: String) = record("rename")
    override suspend fun deleteSession(sessionId: String) = record("delete")
    override suspend fun reopenSession(sessionId: String): app.hapi.protocol.wire.ReopenSessionResponse {
        record("reopen")
        return app.hapi.protocol.wire.ReopenSessionResponse(sessionId = sessionId, resumed = true)
    }
}

private class FakeMachineStore : MachineListStore {
    override val machines: StateFlow<List<Machine>> = MutableStateFlow(emptyList())
    override suspend fun refresh() {}
    override fun scheduleRefresh() {}
    override fun applyMachineEvent(event: SyncEvent.MachineUpdated) {}
}

/** Scripted [ChatSessionApi]: `latest`/`after` serve [tailResponses] in order, `before` serves [beforePage]. */
private class FakeMessagesApi : ChatSessionApi {
    val queries = MutableStateFlow<List<MessagesQuery>>(emptyList())
    val tailResponses = ArrayDeque<MessagesResponse>()
    var beforePage: MessagesResponse? = null

    override suspend fun getMessages(sessionId: String, query: MessagesQuery): MessagesResponse {
        queries.value = queries.value + query
        return when (query) {
            is MessagesQuery.Before -> beforePage ?: emptyLatest(direction = "before")
            // A drained script answers per query direction: an "after" query
            // answered with direction "latest" would (correctly!) reset the
            // window and wipe rows — real hubs answer after-queries "after".
            is MessagesQuery.After -> tailResponses.removeFirstOrNull() ?: emptyLatest(direction = "after")
            is MessagesQuery.Latest -> tailResponses.removeFirstOrNull() ?: emptyLatest(direction = "latest")
        }
    }

    override suspend fun getQueuedState(sessionId: String, localIds: List<String>): QueuedStateResponse =
        QueuedStateResponse(queuedLocalIds = emptyList(), invokedLocalMessages = emptyList())

    // Interaction endpoints are exercised by ChatViewModelInteractionTest.
    override suspend fun sendMessage(sessionId: String, message: SendMessageRequest) {}
    override suspend fun cancelMessage(sessionId: String, messageId: String): CancelMessageResponse =
        CancelMessageResponse(status = "cancelled", localId = messageId)
    override suspend fun retryIndeterminateMessage(sessionId: String, messageId: String): RetryIndeterminateMessageResponse =
        RetryIndeterminateMessageResponse(status = "retried", localId = messageId)

    override suspend fun steerMessage(sessionId: String, messageId: String): SteerQueuedMessageResponse =
        SteerQueuedMessageResponse(status = "steered", localId = messageId)
    override suspend fun abortSession(sessionId: String) {}
    override suspend fun resumeSession(sessionId: String, permissionMode: String?): ResumeSessionResponse =
        ResumeSessionResponse(sessionId = sessionId)
    override suspend fun approvePermission(sessionId: String, requestId: String, options: ApprovePermissionRequest) {}
    override suspend fun denyPermission(sessionId: String, requestId: String, decision: String?) {}
    override suspend fun setPermissionMode(sessionId: String, mode: String) {}
    override suspend fun setModel(sessionId: String, model: String?) {}
    override suspend fun setEffort(sessionId: String, effort: String?) {}
    override suspend fun setModelReasoningEffort(sessionId: String, modelReasoningEffort: String?) {}
    override suspend fun getSessionCodexModels(sessionId: String): CodexModelsResponse =
        CodexModelsResponse(success = false, error = "not scripted")
    override suspend fun getSlashCommands(sessionId: String): app.hapi.protocol.wire.SlashCommandsResponse =
        app.hapi.protocol.wire.SlashCommandsResponse(success = false, error = "not scripted")
    override suspend fun uploadFile(
        sessionId: String,
        filename: String,
        contentBase64: String,
        mimeType: String,
    ): app.hapi.protocol.wire.UploadFileResponse =
        app.hapi.protocol.wire.UploadFileResponse(success = true, path = "/uploads/$filename")
    override suspend fun deleteUpload(sessionId: String, path: String): app.hapi.protocol.wire.DeleteUploadResponse =
        app.hapi.protocol.wire.DeleteUploadResponse(success = true)
}

private fun page(
    direction: String,
    hasMore: Boolean,
    nextBeforeAt: Long? = null,
    nextBeforeSeq: Long? = null,
    snapshotHeadAt: Long? = null,
    snapshotHeadSeq: Long? = null,
): MessagesPage = MessagesPage(
    direction = direction,
    limit = 200,
    epoch = 4,
    reset = false,
    nextBeforeAt = nextBeforeAt,
    nextBeforeSeq = nextBeforeSeq,
    snapshotHeadAt = snapshotHeadAt,
    snapshotHeadSeq = snapshotHeadSeq,
    hasMore = hasMore,
)

private fun emptyLatest(direction: String) =
    MessagesResponse(messages = emptyList(), page = page(direction, hasMore = false))

/** Codex-flavor agent text message (the simplest renderable wire shape). */
private fun agentMessage(id: String, seq: Long, at: Long, text: String): DecryptedMessage =
    DecryptedMessage(
        id = id,
        seq = seq,
        createdAt = at,
        content = buildJsonObject {
            put("role", "agent")
            putJsonObject("content") {
                put("type", "codex")
                putJsonObject("data") {
                    put("type", "message")
                    put("message", text)
                }
            }
        },
    )

private fun summary(updatedAt: Long): SessionSummary = SessionSummary(
    id = SESSION_ID,
    active = true,
    thinking = false,
    activeAt = 0,
    updatedAt = updatedAt,
    metadata = SessionSummaryMetadata(name = "Chat session", path = "/repo/app", flavor = "codex"),
)

private fun detailSession(): Session = Session(
    id = SESSION_ID,
    namespace = "default",
    seq = 1,
    createdAt = 1,
    updatedAt = 1,
    active = true,
    metadataVersion = 1,
    agentStateVersion = 1,
    thinking = false,
    thinkingAt = 0,
)

/** Transport that hands each connection a handshake verdict from [verdicts] (last repeats). */
private class ScriptedTransport(private val verdicts: List<String>) : SseTransport {
    private var connects = 0

    override fun open(url: String, lastEventId: String?) = flow<TransportEvent> {
        val verdict = verdicts.getOrElse(connects) { verdicts.last() }
        connects += 1
        emit(TransportEvent.Connected)
        emit(
            TransportEvent.Event(
                SseRawEvent(
                    id = null,
                    data = """{"type":"connection-changed","data":{"status":"connected","subscriptionId":"sub-1","resume":"$verdict"}}""",
                )
            )
        )
        awaitCancellation()
    }
}

/** Transport that waits for the test to release each frame (deterministic ordering). */
private class GatedTransport : SseTransport {
    val frames = Channel<String>(Channel.UNLIMITED)

    override fun open(url: String, lastEventId: String?) = flow<TransportEvent> {
        emit(TransportEvent.Connected)
        for (frame in frames) {
            emit(TransportEvent.Event(SseRawEvent(id = null, data = frame)))
        }
        awaitCancellation()
    }
}

private class Harness(
    testScope: TestScope,
    transport: SseTransport,
    val api: FakeMessagesApi = FakeMessagesApi(),
) {
    val scope: CoroutineScope = testScope.backgroundScope
    val sessionStore = FakeSessionStore().apply { detailToLoad = detailSession() }
    val lastSeenStore = LastSeenStore(scope)
    val messageWindows = MessageWindowStores(api = api, scope = scope)
    val engine = SseEngine(
        baseUrl = "http://hub.test",
        transport = transport,
        tokenProvider = { "jwt" },
        scope = scope,
    )
    val viewModel = ChatViewModel(
        sessionId = SESSION_ID,
        api = api,
        sessionStore = sessionStore,
        machineStore = FakeMachineStore(),
        lastSeenStore = lastSeenStore,
        messageWindows = messageWindows,
        sseEngine = engine,
        syncTargets = StoreSyncTargets(sessionStore, FakeMachineStore(), scope, messageWindows),
        scope = scope,
        pipelineDispatcher = StandardTestDispatcher(testScope.testScheduler),
    )
}

// ------------------------------------------------------------------ tests --

class ChatViewModelTest {

    @Test
    fun `blocks flow from the window store through the pipeline`() = runTest {
        val harness = Harness(this, ScriptedTransport(listOf("ok")))
        harness.api.tailResponses += MessagesResponse(
            messages = listOf(
                agentMessage("a-1", seq = 1, at = 1000, text = "First answer"),
                agentMessage("a-2", seq = 2, at = 2000, text = "Second answer"),
            ),
            page = page("latest", hasMore = false, nextBeforeAt = 1000, nextBeforeSeq = 1),
        )
        harness.sessionStore.summaries.value = listOf(summary(updatedAt = 2000))

        harness.viewModel.start()
        val state = harness.viewModel.uiState.first { it.blocks.size == 2 }

        assertTrue(state.blocks.all { it is AgentTextBlock })
        assertEquals("Chat session", state.header.title)
        assertEquals(false, state.isInitialLoading)
        assertEquals("/repo/app", state.basePath)
        harness.viewModel.stop()
    }

    @Test
    fun `gap handshake triggers a window resync`() = runTest {
        val transport = GatedTransport()
        val harness = Harness(this, transport)
        harness.api.tailResponses += MessagesResponse(
            messages = listOf(agentMessage("a-1", seq = 1, at = 1000, text = "hello")),
            page = page(
                "latest", hasMore = false,
                nextBeforeAt = 1000, nextBeforeSeq = 1,
                snapshotHeadAt = 1000, snapshotHeadSeq = 1,
            ),
        )

        harness.viewModel.start()
        // Initial sync settles first, so the gap resync is attributable.
        harness.viewModel.uiState.first { it.blocks.isNotEmpty() }
        val callsBefore = harness.api.queries.value.size

        transport.frames.trySend(
            """{"type":"connection-changed","data":{"status":"connected","subscriptionId":"s","resume":"gap"}}"""
        )

        // Full resync (list + detail) plus the window catch-up sync.
        harness.sessionStore.calls.first { calls -> calls.contains("fullResync") }
        harness.api.queries.first { it.size > callsBefore }
        harness.viewModel.stop()
    }

    @Test
    fun `loadOlder pages through the before cursor`() = runTest {
        val harness = Harness(this, ScriptedTransport(listOf("ok")))
        harness.api.tailResponses += MessagesResponse(
            messages = listOf(agentMessage("a-10", seq = 10, at = 10_000, text = "newest")),
            page = page(
                "latest", hasMore = true,
                nextBeforeAt = 10_000, nextBeforeSeq = 10,
                snapshotHeadAt = 10_000, snapshotHeadSeq = 10,
            ),
        )
        harness.api.beforePage = MessagesResponse(
            messages = listOf(agentMessage("a-9", seq = 9, at = 9_000, text = "older")),
            page = page("before", hasMore = false, nextBeforeAt = 9_000, nextBeforeSeq = 9),
        )

        harness.viewModel.start()
        val loaded = harness.viewModel.uiState.first { it.blocks.isNotEmpty() }
        assertTrue(loaded.hasMore)

        harness.viewModel.loadOlder()
        val after = harness.viewModel.uiState.first { it.blocks.size == 2 }

        assertEquals(false, after.hasMore)
        val beforeQuery = harness.api.queries.value.filterIsInstance<MessagesQuery.Before>().single()
        assertEquals(10_000, beforeQuery.beforeAt)
        assertEquals(10, beforeQuery.beforeSeq)
        harness.viewModel.stop()
    }

    @Test
    fun `marks the session seen on entry and on updates`() = runTest {
        val harness = Harness(this, ScriptedTransport(listOf("ok")))
        harness.sessionStore.summaries.value = listOf(summary(updatedAt = 500))

        harness.viewModel.start()
        harness.lastSeenStore.state.first { it.lastSeen[SESSION_ID] == 500L }

        harness.sessionStore.summaries.value = listOf(summary(updatedAt = 900))
        harness.lastSeenStore.state.first { it.lastSeen[SESSION_ID] == 900L }
        harness.viewModel.stop()
    }

    /** Pipeline smoke over real golden fixtures: wire JSON → visible blocks. */
    @Test
    fun `fixture transcripts render to visible blocks`() = runTest {
        val fixturesDir = File(
            System.getProperty("hapi.fixtures.dir")
                ?: error("hapi.fixtures.dir not set (app/build.gradle.kts testOptions)"),
        )
        val fixtures = listOf(
            "claude-tool-use-result-pair.json" to { blocks: List<app.hapi.protocol.chat.VisibleChatBlock> ->
                blocks.filterIsInstance<ToolCallBlock>().any { it.tool.name == "Bash" }
            },
            "claude-assistant-text.json" to { blocks -> blocks.any { it is AgentTextBlock } },
        )

        for ((name, expectation) in fixtures) {
            val document = HapiJson.parseToJsonElement(File(fixturesDir, "chat/$name").readText()).jsonObject
            val rawMessages = document.getValue("input").jsonObject.getValue("messages") as JsonArray
            var seq = 0L
            val messages = rawMessages.map { raw ->
                // Fixture inputs omit paging fields; stamp a seq so rows are pageable.
                seq += 1
                HapiJson.decodeFromJsonElement(DecryptedMessage.serializer(), raw).copy(seq = seq)
            }

            val harness = Harness(this, ScriptedTransport(listOf("ok")))
            harness.api.tailResponses += MessagesResponse(
                messages = messages,
                page = page(
                    "latest", hasMore = false,
                    nextBeforeAt = messages.first().positionAt, nextBeforeSeq = 1,
                ),
            )

            harness.viewModel.start()
            val state = harness.viewModel.uiState.first { it.blocks.isNotEmpty() }
            assertTrue(expectation(state.blocks), "fixture $name should satisfy its block expectation")
            harness.viewModel.stop()
        }
    }
}
