package app.hapi.companion.feature.chat

import app.hapi.companion.feature.chat.attachments.ComposerAttachmentStatus
import app.hapi.companion.feature.chat.attachments.ComposerDraftAttachment
import app.hapi.companion.feature.chat.attachments.PreparedAttachment
import app.hapi.companion.feature.chat.composer.AttachmentDrafts
import app.hapi.companion.feature.chat.composer.ChatDrafts
import app.hapi.companion.feature.chat.composer.ComposerDraftSnapshots
import app.hapi.data.api.ApiError
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
import app.hapi.protocol.wire.ApprovePermissionRequest
import app.hapi.protocol.wire.CancelMessageResponse
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.DeleteUploadResponse
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MessagesPage
import app.hapi.protocol.wire.MessagesResponse
import app.hapi.protocol.wire.ReopenSessionResponse
import app.hapi.protocol.wire.ResumeSessionResponse
import app.hapi.protocol.wire.RetryIndeterminateMessageResponse
import app.hapi.protocol.wire.SendMessageRequest
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionMetadata
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SlashCommandsResponse
import app.hapi.protocol.wire.SteerQueuedMessageResponse
import app.hapi.protocol.wire.SyncEvent
import app.hapi.protocol.wire.UploadFileResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.delay

private const val IX = "sess-1"
private const val TARGET = "sess-2"

// ------------------------------------------------------------------ fakes --

/** Lean [ChatSessionApi]: records the seams drafts v2 touches, errors elsewhere. */
private class LeanApi : ChatSessionApi {
    val sendCalls = MutableStateFlow<List<Pair<String, SendMessageRequest>>>(emptyList())
    val sendFailures = ArrayDeque<Exception?>()
    val deleteUploadCalls = MutableStateFlow<List<String>>(emptyList())

    var resumeResult: ResumeSessionResponse? = null

    override suspend fun getMessages(sessionId: String, query: MessagesQuery): MessagesResponse =
        MessagesResponse(
            messages = emptyList(),
            page = MessagesPage(
                direction = when (query) {
                    is MessagesQuery.After -> "after"
                    is MessagesQuery.Before -> "before"
                    is MessagesQuery.Latest -> "latest"
                },
                limit = 200, epoch = 1, reset = false, hasMore = false,
            ),
        )

    override suspend fun getQueuedState(sessionId: String, localIds: List<String>) =
        app.hapi.protocol.wire.QueuedStateResponse(queuedLocalIds = localIds, invokedLocalMessages = emptyList())

    override suspend fun sendMessage(sessionId: String, message: SendMessageRequest) {
        sendCalls.value = sendCalls.value + (sessionId to message)
        sendFailures.removeFirstOrNull()?.let { throw it }
    }

    override suspend fun cancelMessage(sessionId: String, messageId: String) =
        CancelMessageResponse(status = "cancelled")

    override suspend fun retryIndeterminateMessage(sessionId: String, messageId: String) =
        RetryIndeterminateMessageResponse(status = "retried", localId = messageId)

    override suspend fun steerMessage(sessionId: String, messageId: String) =
        SteerQueuedMessageResponse(status = "steered")

    override suspend fun abortSession(sessionId: String) = Unit

    override suspend fun clearConversation(sessionId: String): ResumeSessionResponse = error("unused")

    override suspend fun implementCodexPlan(sessionId: String, planId: String) = Unit

    override suspend fun resumeSession(sessionId: String, permissionMode: String?): ResumeSessionResponse =
        resumeResult ?: error("resume not scripted")

    override suspend fun approvePermission(sessionId: String, requestId: String, options: ApprovePermissionRequest) =
        Unit

    override suspend fun denyPermission(sessionId: String, requestId: String, decision: String?) = Unit

    override suspend fun setPermissionMode(sessionId: String, mode: String) = Unit

    override suspend fun setModel(sessionId: String, model: String?) = Unit

    override suspend fun setEffort(sessionId: String, effort: String?) = Unit

    override suspend fun setModelReasoningEffort(sessionId: String, modelReasoningEffort: String?) = Unit

    override suspend fun setServiceTier(sessionId: String, serviceTier: String?) = Unit

    override suspend fun getSessionOpencodeReasoningEffortOptions(sessionId: String): app.hapi.protocol.wire.OpencodeReasoningEffortResponse =
        app.hapi.protocol.wire.OpencodeReasoningEffortResponse(success = false)

    override suspend fun getSessionGrokReasoningEffortOptions(sessionId: String): app.hapi.protocol.wire.GrokReasoningEffortResponse =
        app.hapi.protocol.wire.GrokReasoningEffortResponse(success = false)

    override suspend fun getSessionPiModels(sessionId: String): app.hapi.protocol.wire.PiModelsResponse =
        app.hapi.protocol.wire.PiModelsResponse(success = false)

    override suspend fun getSessionCursorModels(sessionId: String): app.hapi.protocol.wire.CursorModelsResponse =
        app.hapi.protocol.wire.CursorModelsResponse(success = false)

    override suspend fun getMachineCursorModels(machineId: String): app.hapi.protocol.wire.CursorModelsResponse =
        app.hapi.protocol.wire.CursorModelsResponse(success = false)

    override suspend fun getSessionCodexModels(sessionId: String): CodexModelsResponse =
        CodexModelsResponse(success = false)

    override suspend fun getSlashCommands(sessionId: String): SlashCommandsResponse =
        SlashCommandsResponse(success = false)

    override suspend fun uploadFile(
        sessionId: String,
        filename: String,
        contentBase64: String,
        mimeType: String,
    ): UploadFileResponse = UploadFileResponse(success = true, path = "/uploads/$filename")

    override suspend fun deleteUpload(sessionId: String, path: String): DeleteUploadResponse {
        deleteUploadCalls.value = deleteUploadCalls.value + path
        return DeleteUploadResponse(success = true)
    }
}

private class LeanSessionStore(var detailToLoad: Session? = null) : SessionDetailStore {
    val summaries = MutableStateFlow<List<SessionSummary>>(emptyList())
    override val sessions: StateFlow<List<SessionSummary>> = summaries

    private val details = MutableStateFlow<Map<String, Session>>(emptyMap())

    fun setDetail(session: Session) {
        details.value = details.value + (session.id to session)
    }

    override fun sessionDetail(sessionId: String): Flow<Session?> =
        details.map { it[sessionId] }.distinctUntilChanged()

    override fun currentDetail(sessionId: String): Session? = details.value[sessionId]

    override suspend fun loadSessionDetail(sessionId: String): Session {
        val session = detailToLoad ?: throw RuntimeException("no scripted detail")
        details.value = details.value + (sessionId to session.copy(id = sessionId))
        return session
    }

    override fun releaseDetail(sessionId: String) {
        details.value = details.value - sessionId
    }

    override fun updateDetailLocal(sessionId: String, transform: (Session) -> Session) {
        val current = details.value[sessionId] ?: return
        details.value = details.value + (sessionId to transform(current))
    }

    override suspend fun refresh() = Unit
    override fun scheduleRefresh() = Unit
    override suspend fun fullResync() = Unit
    override fun applySessionEvent(scope: app.hapi.data.sse.SseSubscriptionKey, event: SyncEvent) = Unit
    override suspend fun setPinMode(sessionId: String, mode: String) = Unit
    override suspend fun archiveSession(sessionId: String) = Unit
    override suspend fun renameSession(sessionId: String, name: String) = Unit
    override suspend fun deleteSession(sessionId: String) = Unit

    var reopenResult: ReopenSessionResponse? = null
    override suspend fun reopenSession(sessionId: String): ReopenSessionResponse =
        reopenResult ?: ReopenSessionResponse(sessionId = sessionId, resumed = true)
}

private class LeanMachineStore : MachineListStore {
    override val machines: StateFlow<List<Machine>> = MutableStateFlow(emptyList())
    override suspend fun refresh() {}
    override fun scheduleRefresh() {}
    override fun applyMachineEvent(event: SyncEvent.MachineUpdated) {}
}

private class FakeTextDrafts : ChatDrafts {
    val map = mutableMapOf<String, String>()
    private val sharedReceipts = mutableSetOf<Pair<String, String>>()
    override suspend fun load(sessionId: String): String? = map[sessionId]
    override suspend fun appendSharedText(sessionId: String, requestId: String, currentText: String, text: String): String {
        if (!sharedReceipts.add(sessionId to requestId)) return currentText
        return app.hapi.companion.feature.chat.composer.appendSharedText(currentText, text).also { save(sessionId, it) }
    }
    override suspend fun save(sessionId: String, text: String) {
        if (text.isBlank()) map.remove(sessionId) else map[sessionId] = text
    }
    override suspend fun clear(sessionId: String) { map.remove(sessionId) }
    override suspend fun move(fromSessionId: String, toSessionId: String) {
        val moved = map.remove(fromSessionId) ?: return
        if (map[toSessionId].isNullOrEmpty()) map[toSessionId] = moved
    }
}

/** In-memory [AttachmentDrafts]; [version] bumps on every write for awaits. */
private class FakeAttachmentDrafts : AttachmentDrafts {
    val map = mutableMapOf<String, List<ComposerDraftAttachment>>()
    val version = MutableStateFlow(0)

    /** Thread-safe read for cross-thread assertions (exit flushes run on IO). */
    fun stored(sessionId: String): List<ComposerDraftAttachment>? = synchronized(map) { map[sessionId] }

    override suspend fun load(sessionId: String): List<ComposerDraftAttachment> = synchronized(map) { map[sessionId].orEmpty() }

    override suspend fun save(sessionId: String, attachments: List<ComposerDraftAttachment>) = synchronized(map) {
        if (attachments.isEmpty()) map.remove(sessionId) else map[sessionId] = attachments
        version.value += 1
    }

    override suspend fun clear(sessionId: String) = synchronized(map) {
        map.remove(sessionId)
        version.value += 1
    }

    override suspend fun move(fromSessionId: String, toSessionId: String) = synchronized(map) {
        val moved = map.remove(fromSessionId) ?: return
        if (map[toSessionId].isNullOrEmpty()) map[toSessionId] = moved
        version.value += 1
    }
}

private fun okTransport(): SseTransport = object : SseTransport {
    override fun open(url: String, lastEventId: String?) = flow<TransportEvent> {
        emit(TransportEvent.Connected)
        emit(
            TransportEvent.Event(
                SseRawEvent(
                    id = null,
                    data = """{"type":"connection-changed","data":{"status":"connected","subscriptionId":"sub-1","resume":"ok"}}""",
                ),
            ),
        )
        awaitCancellation()
    }
}

private fun detail(active: Boolean): Session = Session(
    id = IX,
    namespace = "default",
    seq = 1,
    createdAt = 1,
    updatedAt = 1,
    active = active,
    metadata = SessionMetadata(path = "/repo/app", host = "devbox", flavor = "claude"),
    metadataVersion = 1,
    agentState = null,
    agentStateVersion = 1,
    thinking = false,
    thinkingAt = 0,
    model = null,
    effort = null,
    permissionMode = "default",
)

private fun ref(id: String, path: String = "/uploads/$id.jpg") = ComposerDraftAttachment(
    id = id, filename = "$id.jpg", mimeType = "image/jpeg", sizeBytes = 3, path = path,
    previewUrl = "data:image/jpeg;base64,QUJD",
)

private fun prepared(id: String) = PreparedAttachment(
    id = id, filename = "$id.jpg", mimeType = "image/jpeg",
    bytes = byteArrayOf(1, 2, 3), previewBytes = byteArrayOf(7, 7),
)

private class DraftsHarness(
    testScope: TestScope,
    active: Boolean,
    pipelineDispatcher: CoroutineDispatcher = StandardTestDispatcher(testScope.testScheduler),
) {
    val api = LeanApi()
    val scope = testScope.backgroundScope
    val sessionStore = LeanSessionStore(detailToLoad = detail(active)).apply { setDetail(detail(active)) }
    val textDrafts = FakeTextDrafts()
    val attachmentDrafts = FakeAttachmentDrafts()
    val snapshots = ComposerDraftSnapshots()
    val machineStore = LeanMachineStore()
    val messageWindows = MessageWindowStores(api = api, scope = scope)
    val engine = SseEngine(
        baseUrl = "http://hub.test",
        transport = okTransport(),
        tokenProvider = { "jwt" },
        scope = scope,
    )
    var localIdCounter = 0
    val viewModel = ChatViewModel(
        sessionId = IX,
        api = api,
        sessionStore = sessionStore,
        machineStore = machineStore,
        lastSeenStore = LastSeenStore(scope),
        messageWindows = messageWindows,
        sseEngine = engine,
        syncTargets = StoreSyncTargets(sessionStore, machineStore, scope, messageWindows),
        scope = scope,
        drafts = textDrafts,
        attachmentDrafts = attachmentDrafts,
        draftSnapshots = snapshots,
        pipelineDispatcher = pipelineDispatcher,
        uiDispatcher = StandardTestDispatcher(testScope.testScheduler),
        draftSaveDebounceMs = 10,
        now = { 1_000L },
        localIdGenerator = { "local-${++localIdCounter}" },
    )

    suspend fun awaitReady(id: String) {
        viewModel.attachments.items.first { list ->
            list.any { it.id == id && it.status == ComposerAttachmentStatus.Ready }
        }
    }

    /** The exit flushes run on a real GlobalScope+IO; poll them out-of-band. */
    suspend fun awaitReal(condition: () -> Boolean) {
        withContext(Dispatchers.Default) {
            val deadline = System.currentTimeMillis() + 5_000
            while (!condition()) {
                if (System.currentTimeMillis() > deadline) error("exit-flush condition not met in time")
                delay(10)
            }
        }
    }
}

// ------------------------------------------------------------------ tests --

/**
 * Drafts v2 ViewModel wiring: persist on Ready, restore by activity,
 * clear on send, and the whole-draft carry across supersession.
 */
class ChatViewModelAttachmentDraftsTest {

    @Test
    fun `a Ready chip persists as a reference and survives an exit that keeps uploads`() = runTest {
        val harness = DraftsHarness(this, active = true)
        harness.viewModel.start()

        harness.viewModel.attachments.add(prepared("att-1"))
        harness.awaitReady("att-1")
        harness.attachmentDrafts.version.first { harness.attachmentDrafts.stored(IX) != null }

        val stored = harness.attachmentDrafts.stored(IX)!!
        assertEquals(listOf("att-1"), stored.map { it.id })
        assertEquals("/uploads/att-1.jpg", stored.single().path)

        // Holder exit sequence: stop() (exit flush) then discard (no deletes).
        harness.viewModel.stop()
        harness.viewModel.discardAttachments()

        assertTrue(harness.api.deleteUploadCalls.value.isEmpty(), "draft-owned uploads must survive the exit")
        harness.awaitReal { harness.attachmentDrafts.stored(IX)?.map { it.id } == listOf("att-1") }
    }

    @Test
    fun `an active session restores stored references as Ready chips`() = runTest {
        val harness = DraftsHarness(this, active = true)
        harness.attachmentDrafts.map[IX] = listOf(ref("saved"))
        harness.viewModel.start()

        harness.viewModel.attachments.items.first { list ->
            list.size == 1 && list[0].id == "saved" && list[0].status == ComposerAttachmentStatus.Ready
        }
        // A restored chip is sendable as-is (the stored path rides the send).
        harness.viewModel.sendMessage()
        val (target, request) = harness.api.sendCalls.first { it.isNotEmpty() }.single()
        assertEquals(IX, target)
        assertEquals("/uploads/saved.jpg", request.attachments!!.single().path)
    }

    @Test
    fun `an inactive session restores text but keeps the stored references untouched`() = runTest {
        val harness = DraftsHarness(this, active = false)
        harness.textDrafts.map[IX] = "typed earlier"
        harness.attachmentDrafts.map[IX] = listOf(ref("saved"))
        harness.viewModel.start()

        harness.viewModel.composer.first { it.text == "typed earlier" }
        testScheduler.advanceUntilIdle()

        // Attachments stay stored (web: inactive remount restores text only)…
        assertTrue(
            harness.viewModel.attachments.items.value.isEmpty(),
            "inactive session must not restore attachment chips",
        )
        assertEquals(listOf("saved"), harness.attachmentDrafts.stored(IX)?.map { it.id })
        // …and the empty tray's observer write must not have erased them.
        harness.viewModel.stop()
        harness.viewModel.discardAttachments()
        assertEquals(listOf("saved"), harness.attachmentDrafts.stored(IX)?.map { it.id })
    }

    @Test
    fun `removing the last Ready chip clears the persisted references`() = runTest {
        val harness = DraftsHarness(this, active = true)
        harness.viewModel.start()

        harness.viewModel.attachments.add(prepared("att-1"))
        harness.awaitReady("att-1")
        harness.attachmentDrafts.version.first { harness.attachmentDrafts.stored(IX) != null }

        harness.viewModel.attachments.remove("att-1")
        harness.viewModel.attachments.items.first { it.isEmpty() }
        // The chip's own hub delete is expected (explicit user removal)…
        assertEquals("/uploads/att-1.jpg", harness.api.deleteUploadCalls.value.single())
        // …and the tray-empty write clears the stored references.
        harness.attachmentDrafts.version.first { harness.attachmentDrafts.stored(IX) == null }
    }

    @Test
    fun `a successful send clears both draft stores and the live snapshot`() = runTest {
        val harness = DraftsHarness(this, active = true)
        harness.viewModel.start()

        harness.viewModel.attachments.add(prepared("att-1"))
        harness.awaitReady("att-1")
        harness.viewModel.setComposerText("see this")
        harness.viewModel.sendMessage()

        harness.api.sendCalls.first { it.isNotEmpty() }
        harness.attachmentDrafts.version.first { harness.attachmentDrafts.stored(IX) == null }
        assertNull(harness.textDrafts.map[IX])
        // The explicit remove runs at send time; the observer may then record
        // a web-parity empty snapshot for the cleared composer.
        testScheduler.advanceUntilIdle()
        val snapshot = harness.snapshots.get(IX)
        assertTrue(snapshot == null || (snapshot.text.isEmpty() && snapshot.attachments.isEmpty()))
    }

    @Test
    fun `reopen supersession carries text and references whole and retires the source`() = runTest {
        val harness = DraftsHarness(this, active = false)
        harness.sessionStore.reopenResult = ReopenSessionResponse(sessionId = TARGET, resumed = false)
        harness.textDrafts.map[IX] = "carry me over"
        harness.attachmentDrafts.map[IX] = listOf(ref("kept"))
        harness.snapshots.set(IX, app.hapi.companion.feature.chat.composer.ComposerDraftSnapshot("carry me over"))
        harness.viewModel.start()
        // Wait for the text restore before superseding: the carry samples the
        // live composer (flush-freshest), so it must observe the restored text.
        harness.viewModel.composer.first { it.text == "carry me over" }

        var superseded: String? = null
        val collector = launch { superseded = harness.viewModel.events
            .filterIsInstance<ChatEvent.SessionSuperseded>().first().sessionId }

        harness.viewModel.reopenSession()
        collector.join()

        assertEquals(TARGET, superseded)
        assertEquals("carry me over", harness.textDrafts.map[TARGET])
        assertNull(harness.textDrafts.map[IX])
        assertEquals(listOf("kept"), harness.attachmentDrafts.stored(TARGET)?.map { it.id })
        assertNull(harness.attachmentDrafts.stored(IX))
        // Live snapshot: target recorded, source tombstoned.
        assertEquals("carry me over", harness.snapshots.get(TARGET)?.text)
        assertEquals(listOf("kept"), harness.snapshots.get(TARGET)?.attachments?.map { it.id })
        assertTrue(harness.snapshots.wasHandedOff(IX))
        assertNull(harness.snapshots.get(IX))

        // Holder exit after the hand-off: the carried path is the TARGET's
        // draft asset — the source exit must not delete it or resurrect itself.
        harness.viewModel.stop()
        harness.viewModel.discardAttachments()
        assertTrue(harness.api.deleteUploadCalls.value.isEmpty())
        assertNull(harness.attachmentDrafts.stored(IX))
        assertEquals(listOf("kept"), harness.attachmentDrafts.stored(TARGET)?.map { it.id })
    }

    @Test
    fun `reopen carry flushes the freshest un-debounced text before moving`() = runTest {
        val harness = DraftsHarness(this, active = false)
        harness.sessionStore.reopenResult = ReopenSessionResponse(sessionId = TARGET, resumed = false)
        harness.viewModel.start()

        var superseded: String? = null
        val collector = launch { superseded = harness.viewModel.events
            .filterIsInstance<ChatEvent.SessionSuperseded>().first().sessionId }

        harness.viewModel.setComposerText("typed just before reopening")
        // Do NOT advance past the 10 ms debounce: the carry itself must flush.
        harness.viewModel.reopenSession()
        collector.join()

        assertEquals(TARGET, superseded)
        assertEquals("typed just before reopening", harness.textDrafts.map[TARGET])
        assertNull(harness.textDrafts.map[IX])
    }

    @Test
    fun `resume supersession retires the source and never deletes carried uploads`() = runTest {
        val harness = DraftsHarness(this, active = false)
        harness.api.sendFailures += ApiError(409, code = "session_inactive")
        harness.api.resumeResult = ResumeSessionResponse(sessionId = TARGET)
        harness.attachmentDrafts.map[IX] = listOf(ref("kept"))
        harness.viewModel.start()

        var superseded: String? = null
        val collector = launch { superseded = harness.viewModel.events
            .filterIsInstance<ChatEvent.SessionSuperseded>().first().sessionId }

        harness.viewModel.setComposerText("wake up")
        harness.viewModel.sendMessage()
        collector.join()

        assertEquals(TARGET, superseded)
        assertEquals(TARGET, harness.api.sendCalls.value.last().first)
        // The send consumed the draft stores up front (sent content is not a
        // draft); the supersession still retired the source for good.
        assertTrue(harness.snapshots.wasHandedOff(IX))
        assertNull(harness.snapshots.get(IX))
        assertNotNull(harness.snapshots.get(TARGET))

        harness.viewModel.stop()
        harness.viewModel.discardAttachments()
        assertTrue(harness.api.deleteUploadCalls.value.isEmpty())
    }

    @Test
    fun `text restore falls back to the live snapshot when the store is empty`() = runTest {
        val harness = DraftsHarness(this, active = true)
        harness.snapshots.set(IX, app.hapi.companion.feature.chat.composer.ComposerDraftSnapshot("in-memory only"))
        harness.viewModel.start()

        harness.viewModel.composer.first { it.text == "in-memory only" }
    }
}
