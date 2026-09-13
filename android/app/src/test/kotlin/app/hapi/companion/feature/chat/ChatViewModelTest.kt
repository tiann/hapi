package app.hapi.companion.feature.chat

import app.hapi.companion.feature.sessions.SessionListViewModel
import app.hapi.data.api.ChatSessionApi
import app.hapi.data.api.MessagesQuery
import app.hapi.data.sse.SseEngine
import app.hapi.data.sse.SseRawEvent
import app.hapi.data.sse.SseTransport
import app.hapi.data.sse.TransportEvent
import app.hapi.data.store.ChatHistoryPagingState
import app.hapi.protocol.window.MessageViewMode
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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Job
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
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
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.CompletableDeferred
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
private open class FakeMessagesApi : ChatSessionApi {
    val queries = MutableStateFlow<List<MessagesQuery>>(emptyList())
    val tailResponses = ArrayDeque<MessagesResponse>()
    var beforePage: MessagesResponse? = null
    var tailFailure = false
    var tailGate: CompletableDeferred<Unit>? = null
    var beforeGate: CompletableDeferred<Unit>? = null

    override suspend fun getMessages(sessionId: String, query: MessagesQuery): MessagesResponse {
        queries.value = queries.value + query
        if (query is MessagesQuery.Before) {
            val response = beforePage ?: emptyLatest(direction = "before")
            beforeGate?.await()
            return response
        }
        if (query !is MessagesQuery.Before) {
            tailGate?.await()
            if (tailFailure) error("offline")
        }
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
    override suspend fun clearConversation(sessionId: String): ResumeSessionResponse = error("Unexpected clear")

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
    var connects = 0
        private set

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
    val scope: CoroutineScope = testScope.backgroundScope,
    uiDispatcher: CoroutineDispatcher = StandardTestDispatcher(testScope.testScheduler),
    pipelineDispatcher: CoroutineDispatcher = StandardTestDispatcher(testScope.testScheduler),
) {
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
        pipelineDispatcher = pipelineDispatcher,
        uiDispatcher = uiDispatcher,
    )
}

// ------------------------------------------------------------------ tests --

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ChatViewModelTest {
    @Test
    fun `inspection cancels hidden history demand and keeps one session subscription`() = runTest {
        val transport = ScriptedTransport(listOf("ok"))
        val gate = CompletableDeferred<Unit>()
        // Model an HTTP response already crossing the cancellation boundary.
        val api = object : FakeMessagesApi() {
            override suspend fun getMessages(sessionId: String, query: MessagesQuery): MessagesResponse =
                if (query is MessagesQuery.Before) withContext(kotlinx.coroutines.NonCancellable) {
                    super.getMessages(sessionId, query)
                } else super.getMessages(sessionId, query)
        }
        val h = Harness(this, transport, api)
        api.tailResponses += MessagesResponse(
            listOf(agentMessage("latest", 10, 10_000, "latest")),
            page("latest", true, nextBeforeAt = 10_000, nextBeforeSeq = 10),
        )
        api.beforePage = MessagesResponse(
            listOf(agentMessage("older", 9, 9_000, "older")),
            page("before", true, nextBeforeAt = 9_000, nextBeforeSeq = 9),
        )
        api.beforeGate = gate
        h.viewModel.start()
        h.viewModel.uiState.first { it.blocks.isNotEmpty() }
        runCurrent()
        h.viewModel.readingViewportChanged(false, true)
        runCurrent()
        assertEquals(1, api.queries.value.filterIsInstance<MessagesQuery.Before>().size)
        h.viewModel.beginInspection()
        // Layout callbacks from the exiting destination must be ignored.
        h.viewModel.readingViewportChanged(true, true)
        gate.complete(Unit)
        runCurrent()
        val store = h.messageWindows.open(SESSION_ID)
        assertEquals(MessageViewMode.History, store.state.value.viewMode)
        assertEquals(listOf("latest"), store.state.value.messages.map { it.id })
        assertEquals(1, transport.connects)
        assertEquals(1, api.queries.value.filterIsInstance<MessagesQuery.Before>().size)
        h.viewModel.setTranscriptVisible(true)
        h.viewModel.start() // Host re-entry / rotation is idempotent.
        runCurrent()
        assertEquals(1, api.queries.value.filterIsInstance<MessagesQuery.Before>().size)
        h.viewModel.readingViewportChanged(false, true)
        h.viewModel.uiState.first { it.historyVersion == 1L }
        assertEquals(2, api.queries.value.filterIsInstance<MessagesQuery.Before>().size)
        assertEquals(1, transport.connects)
        h.viewModel.stop()
    }

    @Test
    fun `Default workers cannot mutate paging state outside the UI dispatcher`() = runTest {
        val workers = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val ui = Executors.newSingleThreadExecutor { Thread(it, "hapi-history-ui") }.asCoroutineDispatcher()
        try {
            // Real worker threads and a separate serial UI executor, not a
            // shared single-threaded TestDispatcher hiding producer/UI races.
            withContext(Dispatchers.Default) {
                withTimeout(10_000) {
                    val inFlight = AtomicInteger()
                    val peak = AtomicInteger()
                    val beforeCount = AtomicInteger()
                    val uiThread = withContext(ui) { Thread.currentThread() }
                    val requestThreads = CopyOnWriteArrayList<Thread>()
                    val api = object : FakeMessagesApi() {
                        override suspend fun getMessages(sessionId: String, query: MessagesQuery): MessagesResponse {
                            requestThreads += Thread.currentThread()
                            if (query is MessagesQuery.Before) {
                                beforeCount.incrementAndGet()
                                peak.accumulateAndGet(inFlight.incrementAndGet(), ::maxOf)
                                try {
                                    delay(1)
                                    val seq = query.beforeSeq - 1
                                    return MessagesResponse(
                                        listOf(agentMessage("row-$seq", seq, seq * 1000, "Row $seq")),
                                        page("before", seq > 1, nextBeforeAt = seq * 1000, nextBeforeSeq = seq),
                                    )
                                } finally {
                                    inFlight.decrementAndGet()
                                }
                            }
                            return if (query is MessagesQuery.Latest) MessagesResponse(
                                listOf(agentMessage("row-21", 21, 21_000, "Row 21")),
                                page("latest", true, nextBeforeAt = 21_000, nextBeforeSeq = 21),
                            ) else emptyLatest(direction = "after")
                        }
                    }
                    val h = Harness(this@runTest, ScriptedTransport(listOf("ok")), api,
                        scope = workers, uiDispatcher = ui, pipelineDispatcher = Dispatchers.Default)
                    val transitions = CopyOnWriteArrayList<Pair<ChatHistoryPagingState.Phase, Thread>>()
                    try {
                        withContext(ui) {
                            // Unconfined observation records the writer's
                            // thread rather than hopping to a collector thread.
                            workers.launch(Dispatchers.Unconfined) {
                                h.viewModel.historyPaging.collect {
                                    transitions += it.phase to Thread.currentThread()
                                }
                            }
                            h.viewModel.start()
                        }
                        h.viewModel.uiState.first { it.blocks.isNotEmpty() && !it.isSyncingTail }
                        val store = h.messageWindows.open(SESSION_ID)
                        store.syncTail(ensureAfterCurrent = true)
                        // Acknowledge the committed version immediately. This
                        // can beat fetchOlder's completion back to the UI queue.
                        workers.launch(Dispatchers.Unconfined) {
                            store.state.map { it.historyVersion }.distinctUntilChanged().collect { version ->
                                if (version > 0) withContext(ui) { h.viewModel.historyLaidOut(version, true) }
                            }
                        }
                        withContext(ui) { h.viewModel.readingViewportChanged(false, true) }
                        store.state.first { it.historyVersion == 20L }
                        h.viewModel.historyPaging.first {
                            it.phase == ChatHistoryPagingState.Phase.Idle && it.generation >= 20
                        }
                        assertEquals(20, beforeCount.get())
                        assertEquals(1, peak.get())
                        assertTrue(transitions.any { it.first == ChatHistoryPagingState.Phase.Loading })
                        assertTrue(transitions.all { it.second == uiThread }, transitions.toString())
                        assertTrue(requestThreads.all { it != uiThread }, "Message work must stay off the UI thread")
                    } finally {
                        withContext(ui) { h.viewModel.stop() }
                    }
                }
            }
        } finally {
            workers.cancel()
            workers.coroutineContext[Job]?.join()
            ui.close()
        }
    }

    @Test
    fun `invalidated older response restarts pending demand after tail sync finished`() = runTest {
        val h = Harness(this, ScriptedTransport(listOf("ok")))
        h.api.tailResponses += MessagesResponse(
            listOf(agentMessage("new", 10, 10_000, "new")),
            page("latest", true, nextBeforeAt = 10_000, nextBeforeSeq = 10),
        )
        h.api.beforePage = MessagesResponse(
            listOf(agentMessage("stale", 9, 9_000, "stale")),
            page("before", true, nextBeforeAt = 9_000, nextBeforeSeq = 9),
        )
        val gate = CompletableDeferred<Unit>()
        h.api.beforeGate = gate
        h.viewModel.start()
        h.viewModel.uiState.first { it.blocks.isNotEmpty() }
        runCurrent()
        h.viewModel.readingViewportChanged(followsTail = false, needsOlder = true)
        runCurrent()
        assertEquals(1, h.api.queries.value.filterIsInstance<MessagesQuery.Before>().size)

        // Tail sync poisons the older generation, then finishes while the
        // slower HTTP response still owns the coordinator's olderJob.
        val store = h.messageWindows.open(SESSION_ID)
        store.syncTail(ensureAfterCurrent = true)
        runCurrent()
        assertEquals(false, store.state.value.isSyncingTail)
        assertEquals(ChatHistoryPagingState.Phase.Loading, h.viewModel.historyPaging.value.phase)
        h.api.beforePage = MessagesResponse(
            listOf(agentMessage("fresh", 8, 8_000, "fresh")),
            page("before", false, nextBeforeAt = 8_000, nextBeforeSeq = 8),
        )
        h.api.beforeGate = null
        gate.complete(Unit)
        runCurrent()

        // No new gesture, layout callback, or store event to unstick the pump.
        assertEquals(2, h.api.queries.value.filterIsInstance<MessagesQuery.Before>().size)
        assertEquals(listOf("fresh", "new"), store.state.value.messages.map { it.id })
        assertTrue(h.viewModel.historyPaging.value.phase is ChatHistoryPagingState.Phase.AwaitingLayout)
        h.viewModel.stop()
    }

    @Test
    fun `viewport demand waits for layout and resumes without another gesture`() = runTest {
        val h = Harness(this, ScriptedTransport(listOf("ok")))
        h.api.tailResponses += MessagesResponse(
            listOf(agentMessage("new", 10, 10_000, "new")),
            page("latest", true, nextBeforeAt = 10_000, nextBeforeSeq = 10),
        )
        h.api.beforePage = MessagesResponse(
            listOf(agentMessage("older", 9, 9_000, "older")),
            page("before", true, nextBeforeAt = 9_000, nextBeforeSeq = 9),
        )
        h.viewModel.start()
        h.viewModel.uiState.first { it.blocks.isNotEmpty() }
        runCurrent()
        h.viewModel.readingViewportChanged(followsTail = false, needsOlder = true)
        val first = h.viewModel.uiState.first { it.historyVersion == 1L }
        runCurrent()
        assertEquals(1, h.api.queries.value.filterIsInstance<MessagesQuery.Before>().size)
        assertTrue(h.viewModel.historyPaging.value.phase is ChatHistoryPagingState.Phase.AwaitingLayout)
        h.api.beforePage = MessagesResponse(
            listOf(agentMessage("oldest", 8, 8_000, "oldest")),
            page("before", false, nextBeforeAt = 8_000, nextBeforeSeq = 8),
        )
        h.viewModel.historyLaidOut(first.historyVersion, madeProgress = true)
        h.viewModel.uiState.first { it.historyVersion == 2L }
        assertEquals(2, h.api.queries.value.filterIsInstance<MessagesQuery.Before>().size)
        h.viewModel.stop()
    }

    @Test
    fun `return from an overlay keeps history and failed latest sync remains retryable`() = runTest {
        val h = Harness(this, ScriptedTransport(listOf("ok")))
        h.api.tailResponses += MessagesResponse(
            listOf(agentMessage("old", 1, 1000, "old")),
            page("latest", false, nextBeforeAt = 1000, nextBeforeSeq = 1),
        )
        h.viewModel.start()
        h.viewModel.uiState.first { it.blocks.isNotEmpty() }
        runCurrent()
        h.viewModel.readingViewportChanged(false, false)
        runCurrent()
        val store = h.messageWindows.open(SESSION_ID)
        val retained = store.state.value.messages
        val queries = h.api.queries.value.size
        h.viewModel.stop()
        runCurrent()
        h.viewModel.start()
        runCurrent()
        assertEquals(MessageViewMode.History, store.state.value.viewMode)
        assertEquals(retained, store.state.value.messages)
        assertEquals(queries, h.api.queries.value.size)

        // Seed an explicitly truncated window. Failure must not claim latest.
        val seed = h.messageWindows.open("seed")
        seed.seedFrom(store)
        store.seedFrom(seed)
        store.setViewMode(MessageViewMode.History)
        h.api.tailFailure = true
        h.viewModel.jumpToLatest()
        runCurrent()
        assertEquals(false, h.viewModel.jumpingLatest.value)
        assertEquals(0L, h.viewModel.jumpToken.value)
        assertTrue(store.state.value.requiresLatestReset)
        assertEquals(MessageViewMode.History, store.state.value.viewMode)

        // Cancelling a pending jump cannot leave a permanent spinner or
        // complete a newer screen's navigation when its HTTP response returns.
        h.api.tailFailure = false
        val gate = CompletableDeferred<Unit>()
        h.api.tailGate = gate
        h.viewModel.jumpToLatest()
        runCurrent()
        assertTrue(h.viewModel.jumpingLatest.value)
        h.viewModel.stop()
        h.viewModel.start()
        runCurrent()
        assertEquals(false, h.viewModel.jumpingLatest.value)
        gate.complete(Unit)
        runCurrent()
        assertEquals(0L, h.viewModel.jumpToken.value)
        h.viewModel.stop()
    }

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
            "codex-plan-proposal-completed.json" to { blocks ->
                blocks.filterIsInstance<ToolCallBlock>().any {
                    app.hapi.companion.feature.chat.blocks.planProposalMarkdown(it.tool) != null
                }
            },
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
            for (block in state.blocks.filterIsInstance<ToolCallBlock>()) {
                app.hapi.companion.feature.chat.blocks.planProposalMarkdown(block.tool)?.let { plan ->
                    assertTrue(harness.viewModel.markdownCache.cached(plan) != null, "Plans must be prepared before publication")
                }
            }
            harness.viewModel.stop()
        }
    }
}
