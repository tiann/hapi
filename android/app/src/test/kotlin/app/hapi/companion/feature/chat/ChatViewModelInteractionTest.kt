package app.hapi.companion.feature.chat

import app.hapi.companion.feature.chat.attachments.ComposerAttachmentStatus
import app.hapi.companion.feature.chat.attachments.PreparedAttachment
import app.hapi.companion.feature.chat.attachments.PrepareResult
import app.hapi.companion.feature.chat.composer.RecentSkills
import app.hapi.companion.feature.chat.composer.ChatDrafts
import app.hapi.companion.feature.chat.composer.PendingSchedule
import app.hapi.companion.feature.share.PendingShare
import app.hapi.companion.feature.share.SharedFile
import app.hapi.companion.feature.share.SharedFileStatus
import app.hapi.data.api.ApiError
import app.hapi.data.api.ChatSessionApi
import app.hapi.data.api.MessagesQuery
import app.hapi.data.sse.SseEngine
import app.hapi.data.sse.SseRawEvent
import app.hapi.data.sse.SseSubscriptionKey
import app.hapi.data.sse.SseTransport
import app.hapi.data.sse.TransportEvent
import app.hapi.data.store.LastSeenStore
import app.hapi.data.store.MachineListStore
import app.hapi.data.store.MessageWindowStores
import app.hapi.data.store.ScratchlistAttachmentDeleteResult
import app.hapi.data.store.ScratchlistCreateResult
import app.hapi.data.store.ScratchlistEntryOps
import app.hapi.data.store.ScratchlistMoveDirection
import app.hapi.data.store.ScratchlistSessionState
import app.hapi.data.store.ScratchlistUploadResult
import app.hapi.data.store.SessionDetailStore
import app.hapi.data.store.SessionScratchlist
import app.hapi.data.store.StoreSyncTargets
import app.hapi.data.store.WindowSnapshots
import app.hapi.protocol.catalog.PermissionMode
import app.hapi.protocol.window.MessageStatus
import app.hapi.protocol.window.PersistedMessageWindow
import app.hapi.protocol.window.buildOptimisticMessage
import app.hapi.protocol.wire.AgentState
import app.hapi.protocol.wire.AgentStateRequest
import app.hapi.protocol.wire.ApprovePermissionRequest
import app.hapi.protocol.wire.CancelMessageResponse
import app.hapi.protocol.wire.MessageContextResponse
import app.hapi.protocol.chat.NormalizedMessage
import app.hapi.protocol.chat.normalizeDecryptedMessage
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.DeleteUploadResponse
import app.hapi.protocol.wire.FeaturesResponse
import app.hapi.protocol.wire.InputTranslationFeature
import app.hapi.protocol.wire.FileSearchItem
import app.hapi.protocol.wire.FileSearchResponse
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MessagesPage
import app.hapi.protocol.wire.MessagesResponse
import app.hapi.protocol.wire.OptionalField
import app.hapi.protocol.wire.QueuedStateResponse
import app.hapi.protocol.wire.ReopenSessionResponse
import app.hapi.protocol.wire.ResumeSessionResponse
import app.hapi.protocol.wire.RetryIndeterminateMessageResponse
import app.hapi.protocol.wire.SendMessageRequest
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionMetadata
import app.hapi.protocol.wire.SessionCapabilities
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.SkillSummary
import app.hapi.protocol.wire.SkillsResponse
import app.hapi.protocol.wire.SlashCommand
import app.hapi.protocol.wire.SlashCommandsResponse
import app.hapi.protocol.wire.SteerQueuedMessageResponse
import app.hapi.protocol.wire.SyncEvent
import app.hapi.protocol.wire.UploadFileResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
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
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import org.junit.Rule
import org.junit.rules.TemporaryFolder

private const val IX_SESSION = "sess-1"

// ------------------------------------------------------------------ fakes --

private class InteractionSessionStore : SessionDetailStore {
    val summaries = MutableStateFlow<List<SessionSummary>>(emptyList())
    override val sessions: StateFlow<List<SessionSummary>> = summaries

    private val details = MutableStateFlow<Map<String, Session>>(emptyMap())
    var detailToLoad: Session? = null
    val calls = MutableStateFlow<List<String>>(emptyList())

    private fun record(call: String) {
        calls.value = calls.value + call
    }

    fun setDetail(session: Session) {
        details.value = details.value + (session.id to session)
    }

    override fun sessionDetail(sessionId: String): Flow<Session?> =
        details.map { it[sessionId] }.distinctUntilChanged()

    override fun currentDetail(sessionId: String): Session? = details.value[sessionId]

    override suspend fun loadSessionDetail(sessionId: String): Session {
        record("loadDetail:$sessionId")
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

    override suspend fun refresh() = record("refresh")
    override fun scheduleRefresh() = record("scheduleRefresh")
    override suspend fun fullResync() = record("fullResync")
    override fun applySessionEvent(scope: app.hapi.data.sse.SseSubscriptionKey, event: SyncEvent) = record("event")
    override suspend fun setPinMode(sessionId: String, mode: String) = record("pin")
    override suspend fun archiveSession(sessionId: String) = record("archive")

    var renameFailure: Exception? = null
    override suspend fun renameSession(sessionId: String, name: String) {
        record("rename:$sessionId:$name")
        renameFailure?.let { throw it }
    }

    var deleteFailure: Exception? = null
    override suspend fun deleteSession(sessionId: String) {
        record("delete:$sessionId")
        deleteFailure?.let { throw it }
    }

    var reopenResult: ReopenSessionResponse? = null
    var reopenFailure: Exception? = null
    override suspend fun reopenSession(sessionId: String): ReopenSessionResponse {
        record("reopen:$sessionId")
        reopenFailure?.let { throw it }
        return reopenResult ?: ReopenSessionResponse(sessionId = sessionId, resumed = true)
    }
}

private class InteractionMachineStore : MachineListStore {
    override val machines: StateFlow<List<Machine>> = MutableStateFlow(emptyList())
    override suspend fun refresh() {}
    override fun scheduleRefresh() {}
    override fun applyMachineEvent(event: SyncEvent.MachineUpdated) {}
}

/** Records every interaction call; failures/results are scriptable per endpoint. */
private class RecordingChatApi : ChatSessionApi {
    val sendCalls = MutableStateFlow<List<Pair<String, SendMessageRequest>>>(emptyList())
    val sendFailures = ArrayDeque<Exception?>()

    var resumeResult: ResumeSessionResponse? = null
    val resumeCalls = MutableStateFlow<List<Pair<String, String?>>>(emptyList())

    var cancelResult: CancelMessageResponse = CancelMessageResponse(status = "cancelled")
    val cancelCalls = MutableStateFlow<List<String>>(emptyList())
    /** Hold cancel round-trips open to interleave schedule picks mid-edit. */
    var cancelGate: CompletableDeferred<Unit>? = null

    var steerResult: SteerQueuedMessageResponse = SteerQueuedMessageResponse(status = "steered")
    val steerCalls = MutableStateFlow<List<String>>(emptyList())

    val approveCalls = MutableStateFlow<List<Pair<String, ApprovePermissionRequest>>>(emptyList())
    var approveFailure: Exception? = null
    val denyCalls = MutableStateFlow<List<Pair<String, String?>>>(emptyList())

    val configCalls = MutableStateFlow<List<String>>(emptyList())
    var configFailure: Exception? = null

    var codexModelsResult: CodexModelsResponse = CodexModelsResponse(success = false, error = "not scripted")

    override suspend fun getMessages(sessionId: String, query: MessagesQuery): MessagesResponse =
        MessagesResponse(
            messages = emptyList(),
            page = MessagesPage(
                // Direction must match the query: a "latest" answer to an
                // after-query means reset and would wipe ingested rows.
                direction = when (query) {
                    is MessagesQuery.After -> "after"
                    is MessagesQuery.Before -> "before"
                    is MessagesQuery.Latest -> "latest"
                },
                limit = 200,
                epoch = 1,
                reset = false,
                hasMore = false,
            ),
        )

    override suspend fun getQueuedState(sessionId: String, localIds: List<String>): QueuedStateResponse =
        QueuedStateResponse(queuedLocalIds = localIds, invokedLocalMessages = emptyList())

    override suspend fun getMessageContext(sessionId: String, messageId: String): MessageContextResponse? = null

    override suspend fun sendMessage(sessionId: String, message: SendMessageRequest) {
        sendCalls.value = sendCalls.value + (sessionId to message)
        sendFailures.removeFirstOrNull()?.let { throw it }
    }

    override suspend fun cancelMessage(sessionId: String, messageId: String): CancelMessageResponse {
        cancelCalls.value = cancelCalls.value + messageId
        cancelGate?.await()
        return cancelResult
    }

    override suspend fun retryIndeterminateMessage(sessionId: String, messageId: String): RetryIndeterminateMessageResponse =
        RetryIndeterminateMessageResponse(status = "retried", localId = messageId)

    override suspend fun steerMessage(sessionId: String, messageId: String): SteerQueuedMessageResponse {
        steerCalls.value = steerCalls.value + messageId
        return steerResult
    }

    override suspend fun abortSession(sessionId: String) {
        configCalls.value = configCalls.value + "abort:$sessionId"
    }

    override suspend fun clearConversation(sessionId: String): ResumeSessionResponse = error("Unexpected clear")

    var featuresResult: FeaturesResponse = FeaturesResponse()
    override suspend fun getFeatures(): FeaturesResponse = featuresResult

    var hubSettingsResult: app.hapi.protocol.wire.HubSettingsResponse = app.hapi.protocol.wire.HubSettingsResponse()
    override suspend fun getHubSettings(): app.hapi.protocol.wire.HubSettingsResponse = hubSettingsResult

    val translateCalls = MutableStateFlow<List<Pair<String, Boolean>>>(emptyList())
    var translateFailure: Exception? = null
    override suspend fun setSessionTranslateInput(sessionId: String, enabled: Boolean) {
        translateCalls.value = translateCalls.value + (sessionId to enabled)
        translateFailure?.let { throw it }
    }

    val planCalls = MutableStateFlow<List<Pair<String, String>>>(emptyList())
    var planGate: CompletableDeferred<Unit>? = null
    val planFailures = ArrayDeque<Exception?>()
    override suspend fun implementCodexPlan(sessionId: String, planId: String) {
        planCalls.value = planCalls.value + (sessionId to planId)
        planGate?.await()
        planFailures.removeFirstOrNull()?.let { throw it }
    }

    override suspend fun resumeSession(sessionId: String, permissionMode: String?): ResumeSessionResponse {
        resumeCalls.value = resumeCalls.value + (sessionId to permissionMode)
        return resumeResult ?: throw RuntimeException("resume not scripted")
    }

    override suspend fun approvePermission(sessionId: String, requestId: String, options: ApprovePermissionRequest) {
        approveCalls.value = approveCalls.value + (requestId to options)
        approveFailure?.let { throw it }
    }

    override suspend fun denyPermission(sessionId: String, requestId: String, decision: String?) {
        denyCalls.value = denyCalls.value + (requestId to decision)
    }

    override suspend fun setPermissionMode(sessionId: String, mode: String) {
        configCalls.value = configCalls.value + "mode:$mode"
        configFailure?.let { throw it }
    }

    override suspend fun setModel(sessionId: String, model: String?) {
        configCalls.value = configCalls.value + "model:$model"
        configFailure?.let { throw it }
    }

    override suspend fun setEffort(sessionId: String, effort: String?) {
        configCalls.value = configCalls.value + "effort:$effort"
        configFailure?.let { throw it }
    }

    override suspend fun setModelReasoningEffort(sessionId: String, modelReasoningEffort: String?) {
        configCalls.value = configCalls.value + "modelReasoningEffort:$modelReasoningEffort"
        configFailure?.let { throw it }
    }

    override suspend fun getSessionCodexModels(sessionId: String): CodexModelsResponse = codexModelsResult

    var slashCommandsResult: SlashCommandsResponse = SlashCommandsResponse(success = false, error = "not scripted")
    val slashCommandsCalls = MutableStateFlow(0)
    override suspend fun getSlashCommands(sessionId: String): SlashCommandsResponse {
        slashCommandsCalls.value += 1
        return slashCommandsResult
    }

    var skillsResult = SkillsResponse(success = false, error = "not scripted")
    var skillsGate: CompletableDeferred<Unit>? = null
    var skillsFailure: Exception? = null
    val skillsCalls = mutableListOf<String>()
    override suspend fun getSkills(sessionId: String): SkillsResponse {
        skillsCalls += sessionId
        skillsGate?.await()
        skillsFailure?.let { throw it }
        return skillsResult
    }

    var fileSearchResult: FileSearchResponse = FileSearchResponse(success = false, error = "not scripted")
    var fileSearchFailure: Exception? = null
    /** Non-null ⇒ the file RPC records its call then parks until completed. */
    var fileSearchGate: CompletableDeferred<Unit>? = null
    val fileSearchCalls = MutableStateFlow<List<Triple<String, String, Int?>>>(emptyList())
    override suspend fun searchSessionFiles(sessionId: String, query: String, limit: Int?): FileSearchResponse {
        fileSearchCalls.value = fileSearchCalls.value + Triple(sessionId, query, limit)
        fileSearchGate?.await()
        fileSearchFailure?.let { throw it }
        return fileSearchResult
    }

    var uploadResult: UploadFileResponse = UploadFileResponse(success = true, path = "/uploads/ok")

    /** When set, uploads park here (in-flight chip tests). */
    var uploadGate: CompletableDeferred<Unit>? = null
    val uploadCalls = MutableStateFlow<List<String>>(emptyList())
    override suspend fun uploadFile(
        sessionId: String,
        filename: String,
        contentBase64: String,
        mimeType: String,
    ): UploadFileResponse {
        uploadCalls.value = uploadCalls.value + filename
        uploadGate?.await()
        return uploadResult
    }

    val deleteUploadCalls = MutableStateFlow<List<String>>(emptyList())
    override suspend fun deleteUpload(sessionId: String, path: String): DeleteUploadResponse {
        deleteUploadCalls.value = deleteUploadCalls.value + path
        return DeleteUploadResponse(success = true)
    }
}

private class FakeDrafts : ChatDrafts {
    val map = mutableMapOf<String, String>()
    val sharedReceipts = mutableSetOf<Pair<String, String>>()
    var loadGate: CompletableDeferred<Unit>? = null
    override suspend fun load(sessionId: String): String? {
        loadGate?.await()
        return map[sessionId]
    }
    override suspend fun appendSharedText(sessionId: String, requestId: String, currentText: String, text: String): String {
        if (!sharedReceipts.add(sessionId to requestId)) return currentText
        return app.hapi.companion.feature.chat.composer.appendSharedText(currentText, text).also { save(sessionId, it) }
    }
    override suspend fun save(sessionId: String, text: String) {
        if (text.isBlank()) map.remove(sessionId) else map[sessionId] = text
    }

    override suspend fun clear(sessionId: String) {
        map.remove(sessionId)
    }

    override suspend fun move(fromSessionId: String, toSessionId: String) {
        val moved = map.remove(fromSessionId) ?: return
        if (map[toSessionId].isNullOrEmpty()) map[toSessionId] = moved
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

private fun detail(
    id: String = IX_SESSION,
    flavor: String = "claude",
    active: Boolean = true,
    thinking: Boolean = false,
    permissionMode: String? = "default",
    model: String? = null,
    effort: String? = null,
    agentState: AgentState? = null,
): Session = Session(
    id = id,
    namespace = "default",
    seq = 1,
    createdAt = 1,
    updatedAt = 1,
    active = active,
    metadata = SessionMetadata(path = "/repo/app", host = "devbox", flavor = flavor),
    metadataVersion = 1,
    agentState = agentState,
    agentStateVersion = 1,
    thinking = thinking,
    thinkingAt = 0,
    model = model,
    effort = effort,
    permissionMode = permissionMode,
)

private fun bashRequest(command: String = "rm -rf build") = AgentStateRequest(
    tool = "Bash",
    arguments = buildJsonObject { put("command", command) },
)

/** Recording [SessionScratchlist] fake for the park/badge seam (B-M4d). */
private class FakeScratchlist : SessionScratchlist {
    val created = mutableListOf<Pair<String, String>>()
    var createResult: (String) -> ScratchlistCreateResult = { text ->
        ScratchlistCreateResult.Created(
            app.hapi.protocol.wire.ScratchlistEntry(entryId = "hub-1", text = text, createdAt = 1, updatedAt = 2)
        )
    }
    val sessionState = MutableStateFlow(ScratchlistSessionState())

    override fun state(sessionId: String): Flow<ScratchlistSessionState> = sessionState
    override fun currentState(sessionId: String): ScratchlistSessionState = sessionState.value
    override fun open(sessionId: String) = Unit
    override fun release(sessionId: String) = Unit
    override suspend fun refresh(sessionId: String) = Unit
    override suspend fun createEntry(
        sessionId: String,
        text: String,
        attachments: List<app.hapi.protocol.wire.ScratchlistAttachment>,
    ): ScratchlistCreateResult {
        created += sessionId to text.trim()
        return createResult(text)
    }
    override suspend fun updateEntry(
        sessionId: String,
        entryId: String,
        text: String?,
        attachments: List<app.hapi.protocol.wire.ScratchlistAttachment>?,
    ): Boolean = true
    override suspend fun deleteEntry(sessionId: String, entryId: String): Boolean = true
    override fun moveEntry(sessionId: String, entryId: String, direction: ScratchlistMoveDirection) {
        sessionState.value = sessionState.value.copy(
            entries = ScratchlistEntryOps.moveEntry(sessionState.value.entries, entryId, direction)
        )
    }
    override suspend fun uploadAttachment(
        sessionId: String,
        filename: String,
        bytes: ByteArray,
        mimeType: String,
    ): ScratchlistUploadResult = ScratchlistUploadResult.Failed("unused")
    override suspend fun deleteAttachment(
        sessionId: String,
        attachmentId: String,
    ): ScratchlistAttachmentDeleteResult = ScratchlistAttachmentDeleteResult.Removed
    override suspend fun limits(sessionId: String) = app.hapi.protocol.wire.ScratchlistAttachmentLimits.DEFAULT
}

private class InteractionHarness(
    testScope: TestScope,
    detail: Session = detail(),
    val scratchlist: FakeScratchlist? = null,
    recentSkills: RecentSkills? = null,
    snapshots: WindowSnapshots? = null,
    legacySnapshots: WindowSnapshots? = null,
    transport: SseTransport = okTransport(),
) {
    val api = RecordingChatApi()
    val scope = testScope.backgroundScope
    val sessionStore = InteractionSessionStore().apply {
        detailToLoad = detail
        setDetail(detail)
    }
    val drafts = FakeDrafts()
    val messageWindows = MessageWindowStores(
        api = api,
        scope = scope,
        snapshots = snapshots,
        legacySnapshots = legacySnapshots,
        snapshotNamespace = if (snapshots != null) "default" else null,
    )
    val engine = SseEngine(
        baseUrl = "http://hub.test",
        transport = transport,
        tokenProvider = { "jwt" },
        scope = scope,
    )
    var localIdCounter = 0
    val viewModel = ChatViewModel(
        sessionId = IX_SESSION,
        api = api,
        sessionStore = sessionStore,
        machineStore = InteractionMachineStore(),
        lastSeenStore = LastSeenStore(scope),
        messageWindows = messageWindows,
        sseEngine = engine,
        syncTargets = StoreSyncTargets(sessionStore, InteractionMachineStore(), scope, messageWindows),
        scope = scope,
        drafts = drafts,
        scratchlist = scratchlist,
        recentSkills = recentSkills,
        pipelineDispatcher = StandardTestDispatcher(testScope.testScheduler),
        uiDispatcher = StandardTestDispatcher(testScope.testScheduler),
        draftSaveDebounceMs = 10,
        now = { 1_000L },
        localIdGenerator = { "local-${++localIdCounter}" },
    )

    suspend fun window() = messageWindows.open(IX_SESSION)
}

// ------------------------------------------------------------------ tests --

class ChatViewModelInteractionTest {

    @get:Rule
    val temp = TemporaryFolder()

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `upgrade restores only authenticated failed sends and does not resend or resurrect them`() = runTest {
        val legacyDir = temp.newFolder()
        val legacy = WindowSnapshots(legacyDir, io = Dispatchers.Unconfined)
        val current = WindowSnapshots(temp.newFolder(), io = Dispatchers.Unconfined)
        val failed = buildOptimisticMessage("failed", "unsent text", 10, status = MessageStatus.Failed)
        val duplicate = buildOptimisticMessage("already-sent", "sent text", 20, status = MessageStatus.Sent)
        val stored = duplicate.copy(wire = duplicate.wire.copy(id = "server-id", seq = 1))
        val queued = buildOptimisticMessage("queued", "not a failed send", 30, status = MessageStatus.Queued)
        legacy.save(IX_SESSION, PersistedMessageWindow(
            messages = listOf(failed, duplicate.copy(status = MessageStatus.Failed), queued, stored),
            epoch = 99,
        ))
        current.save(IX_SESSION, PersistedMessageWindow(messages = listOf(stored), epoch = 1))
        val original = legacyDir.listFiles()!!.single()
        val originalJson = original.readText()
        assertTrue(original.setLastModified(123_000))

        val harness = InteractionHarness(this, snapshots = current, legacySnapshots = legacy)
        harness.sessionStore.detailToLoad = null // cached detail is not proof of ownership
        harness.viewModel.start()
        runCurrent()
        val window = harness.window()
        assertTrue(window.state.value.messages.none { it.id == "failed" })

        harness.sessionStore.detailToLoad = detail().copy(namespace = "another-namespace")
        harness.viewModel.retry()
        runCurrent()
        assertTrue(window.state.value.messages.none { it.id == "failed" })

        harness.sessionStore.detailToLoad = detail(id = "redirected")
        harness.viewModel.retry()
        runCurrent()
        assertTrue(window.state.value.messages.none { it.id == "failed" })

        // Keep the destination duplicate represented even if the fake tail reset it.
        window.ingestSseMessages(listOf(stored))
        harness.sessionStore.detailToLoad = detail()
        harness.viewModel.retry()
        runCurrent()
        val messages = window.state.value.messages
        assertEquals(failed, messages.single { it.status == MessageStatus.Failed })
        assertTrue(messages.none { it.id == "queued" })
        assertTrue(harness.api.sendCalls.value.isEmpty())
        val persisted = assertNotNull(current.load(IX_SESSION))
        assertTrue(persisted.messages.contains(failed))
        assertTrue(persisted.epoch != 99L)
        assertEquals(originalJson, original.readText())
        assertEquals(123_000L, original.lastModified())

        harness.viewModel.retryFailedMessage("failed")
        runCurrent()
        val (sessionId, retry) = harness.api.sendCalls.value.single()
        assertEquals(IX_SESSION, sessionId)
        assertEquals("unsent text", retry.text)
        assertEquals("failed", retry.localId)

        // Once no longer retained by the destination window, the recovered row
        // must not become retryable again when the process restarts.
        window.removeMessage("failed")
        val reopened = InteractionHarness(this, snapshots = current, legacySnapshots = legacy)
        reopened.viewModel.start()
        runCurrent()
        assertTrue(reopened.window().state.value.messages.none { it.id == "failed" })
        assertTrue(reopened.api.sendCalls.value.isEmpty())
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `verified upgrade recovery waits for delayed namespace binding`() = runTest {
        val legacy = WindowSnapshots(temp.newFolder(), io = Dispatchers.Unconfined)
        val current = WindowSnapshots(temp.newFolder(), io = Dispatchers.Unconfined)
        val failed = buildOptimisticMessage("failed", "unsent text", 10, status = MessageStatus.Failed)
        legacy.save(IX_SESSION, PersistedMessageWindow(messages = listOf(failed)))
        val harness = InteractionHarness(this, legacySnapshots = legacy)
        harness.viewModel.start()
        runCurrent()
        assertTrue("loadDetail:$IX_SESSION" in harness.sessionStore.calls.value)
        assertTrue(harness.window().state.value.messages.isEmpty())

        harness.messageWindows.enableSnapshots(current, "default")
        runCurrent()
        assertEquals(listOf(failed), harness.window().state.value.messages)
        assertEquals(listOf(failed), current.load(IX_SESSION)?.messages)
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `offline upgrade recovers failed sends when the open chat reconnects`() = runTest {
        val legacy = WindowSnapshots(temp.newFolder(), io = Dispatchers.Unconfined)
        val current = WindowSnapshots(temp.newFolder(), io = Dispatchers.Unconfined)
        val failed = buildOptimisticMessage("failed", "unsent text", 10, status = MessageStatus.Failed)
        legacy.save(IX_SESSION, PersistedMessageWindow(messages = listOf(failed)))
        val online = okTransport()
        var attempts = 0
        val transport = object : SseTransport {
            override fun open(url: String, lastEventId: String?) = if (attempts++ == 0) {
                flow { emit(TransportEvent.Failure(code = null)) }
            } else online.open(url, lastEventId)
        }
        val harness = InteractionHarness(this, snapshots = current, legacySnapshots = legacy, transport = transport)
        harness.sessionStore.detailToLoad = null
        harness.viewModel.start()
        runCurrent()
        assertEquals(1, harness.sessionStore.calls.value.count { it == "loadDetail:$IX_SESSION" })
        assertTrue(harness.window().state.value.messages.isEmpty())

        harness.sessionStore.detailToLoad = detail()
        harness.engine.requestReconnect(SseSubscriptionKey.Session(IX_SESSION))
        runCurrent()
        assertEquals(2, attempts)
        assertEquals(2, harness.sessionStore.calls.value.count { it == "loadDetail:$IX_SESSION" })
        assertEquals(listOf(failed), current.load(IX_SESSION)?.messages)
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    private fun planDetail(): Session = detail(
        flavor = "codex", agentState = AgentState(codexPlanProposalId = "plan-1"),
    ).copy(
        metadata = SessionMetadata(path = "/repo", host = "host", flavor = "codex",
                                   capabilities = SessionCapabilities(concurrentClients = true)),
        collaborationMode = "plan",
    )

    @Test fun `only the active shared current Codex proposal is actionable`() = runTest {
        val harness = InteractionHarness(this, planDetail())
        val vm = harness.viewModel
        testScheduler.runCurrent()
        assertTrue(vm.codexPlanActions.value.forPlan("plan-1").canAct)
        assertFalse(vm.codexPlanActions.value.forPlan("history").isVisible)
        assertFalse(vm.codexPlanActions.value.forPlan("child-plan").isVisible)
        for (session in listOf(
            planDetail().copy(active = false),
            planDetail().copy(metadata = planDetail().metadata!!.copy(flavor = "claude")),
            planDetail().copy(metadata = planDetail().metadata!!.copy(capabilities = null)),
            planDetail().copy(agentState = AgentState()),
            planDetail().copy(agentState = AgentState(codexPlanProposalId = "newer-plan")),
        )) {
            harness.sessionStore.setDetail(session)
            // Even before the combined flow catches up, callbacks check live state.
            vm.implementCodexPlan("plan-1")
            vm.continueCodexPlan("plan-1")
            testScheduler.runCurrent()
            assertFalse(vm.codexPlanActions.value.forPlan("plan-1").isVisible)
        }
        assertTrue(harness.api.planCalls.value.isEmpty())
        assertEquals(0L, vm.composer.value.focusRequest)
    }

    @Test fun `continue planning dismisses actions and preserves the draft and mode without a request`() = runTest {
        val harness = InteractionHarness(this, planDetail())
        harness.viewModel.setComposerText("Refine step two")
        harness.viewModel.continueCodexPlan("plan-1")
        testScheduler.runCurrent()
        assertEquals(1L, harness.viewModel.composer.value.focusRequest)
        assertEquals("Refine step two", harness.viewModel.composer.value.text)
        assertEquals("plan", harness.sessionStore.currentDetail(IX_SESSION)?.collaborationMode)
        assertTrue(harness.api.planCalls.value.isEmpty())
        assertTrue(harness.api.sendCalls.value.isEmpty())
        assertTrue(harness.api.approveCalls.value.isEmpty())
        assertTrue(harness.api.configCalls.value.isEmpty())
        assertFalse(harness.viewModel.codexPlanActions.value.forPlan("plan-1").isVisible)
        harness.viewModel.continueCodexPlan("plan-1")
        harness.viewModel.implementCodexPlan("plan-1")
        harness.sessionStore.setDetail(planDetail())
        testScheduler.runCurrent()
        assertEquals(1L, harness.viewModel.composer.value.focusRequest)
        assertTrue(harness.api.planCalls.value.isEmpty())
        assertFalse(harness.viewModel.codexPlanActions.value.forPlan("plan-1").isVisible)
        harness.sessionStore.setDetail(planDetail().copy(agentState = AgentState(codexPlanProposalId = "plan-2")))
        testScheduler.runCurrent()
        assertTrue(harness.viewModel.codexPlanActions.value.forPlan("plan-2").canAct)
    }

    @Test fun `plan implementation is single flight and acceptance survives stale refresh`() = runTest {
        val harness = InteractionHarness(this, planDetail())
        val vm = harness.viewModel
        harness.api.planGate = CompletableDeferred()
        vm.setComposerText("Keep this draft")
        vm.implementCodexPlan("plan-1")
        vm.implementCodexPlan("plan-1")
        vm.continueCodexPlan("plan-1")
        testScheduler.runCurrent()
        assertTrue(vm.codexPlanActions.value.forPlan("plan-1").pending)
        assertFalse(vm.codexPlanActions.value.forPlan("plan-1").canAct)
        assertEquals(0L, vm.composer.value.focusRequest)
        harness.sessionStore.setDetail(planDetail().copy(agentState = AgentState()))
        testScheduler.runCurrent()
        assertTrue(vm.codexPlanActions.value.forPlan("plan-1").pending)
        assertFalse(vm.codexPlanActions.value.forPlan("plan-1").available)
        harness.api.planGate!!.complete(Unit)
        testScheduler.runCurrent()
        // The refresh deliberately serves the old id: accepted actions stay hidden.
        assertFalse(vm.codexPlanActions.value.forPlan("plan-1").isVisible)
        vm.implementCodexPlan("plan-1")
        testScheduler.runCurrent()
        assertEquals(listOf(IX_SESSION to "plan-1"), harness.api.planCalls.value)
        assertEquals(1, harness.sessionStore.calls.value.count { it == "loadDetail:$IX_SESSION" })
        assertEquals("Keep this draft", vm.composer.value.text)
        assertTrue(harness.api.sendCalls.value.isEmpty())
        assertTrue(harness.api.approveCalls.value.isEmpty())
        assertTrue(harness.api.configCalls.value.isEmpty())
    }

    @Test fun `plan errors survive withdrawal and do not automatically resubmit`() = runTest {
        for ((status, code) in listOf(409 to "stale_plan", 409 to "unavailable", 500 to "failed", 503 to "indeterminate")) {
            val harness = InteractionHarness(this, planDetail())
            harness.api.planFailures.add(ApiError.from(status, """{"ok":false,"code":"$code","error":"Not confirmed"}"""))
            harness.sessionStore.detailToLoad = planDetail().copy(agentState = AgentState())
            harness.viewModel.implementCodexPlan("plan-1")
            testScheduler.runCurrent()
            val state = harness.viewModel.codexPlanActions.value.forPlan("plan-1")
            assertEquals("Not confirmed", state.error?.detail)
            assertTrue(state.isVisible)
            assertFalse(state.available || state.canAct || state.pending)
            assertEquals(1, harness.api.planCalls.value.size)
            assertEquals(1, harness.sessionStore.calls.value.count { it == "loadDetail:$IX_SESSION" })
            assertEquals("plan", harness.sessionStore.currentDetail(IX_SESSION)?.collaborationMode)
        }
    }

    @Test fun `confirmed failure allows an explicit retry and clears its error`() = runTest {
        val harness = InteractionHarness(this, planDetail())
        harness.api.planFailures.add(ApiError.from(500, """{"code":"failed","error":"Try again"}"""))
        harness.viewModel.implementCodexPlan("plan-1")
        testScheduler.runCurrent()
        assertTrue(harness.viewModel.codexPlanActions.value.forPlan("plan-1").canAct)
        harness.api.planGate = CompletableDeferred()
        harness.viewModel.implementCodexPlan("plan-1")
        testScheduler.runCurrent()
        assertNull(harness.viewModel.codexPlanActions.value.forPlan("plan-1").error)
        harness.api.planGate!!.complete(Unit)
        testScheduler.runCurrent()
        assertFalse(harness.viewModel.codexPlanActions.value.forPlan("plan-1").isVisible)
        assertEquals(2, harness.api.planCalls.value.size)
    }

    // ---------------------------------------------------------------- send --

    @Test
    fun `optimistic send happy path posts queue delivery and settles to sent`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()

        harness.viewModel.setComposerText("hello agent")
        harness.viewModel.sendMessage()

        val (sessionId, request) = harness.api.sendCalls.first { it.isNotEmpty() }.single()
        assertEquals(IX_SESSION, sessionId)
        assertEquals("hello agent", request.text)
        assertEquals("local-1", request.localId)
        assertEquals("queue", request.deliveryMode)
        assertNull(request.scheduledAt)

        val row = harness.window().state.first { state ->
            state.messages.any { it.localId == "local-1" && it.status == MessageStatus.Sent }
        }.messages.single()
        assertEquals("local-1", row.id) // optimistic until the SSE echo replaces it
        assertEquals(0, harness.viewModel.composer.value.text.length)
        assertNull(harness.drafts.map[IX_SESSION])
    }

    @Test
    fun `send while thinking settles to queued and steer intent rides the wire`() = runTest {
        val harness = InteractionHarness(this, detail(thinking = true))
        harness.viewModel.start()

        harness.viewModel.setComposerText("steer this")
        harness.viewModel.sendMessage(steer = true)

        val (_, request) = harness.api.sendCalls.first { it.isNotEmpty() }.single()
        assertEquals("steer", request.deliveryMode)
        harness.window().state.first { state ->
            state.messages.any { it.localId == "local-1" && it.status == MessageStatus.Queued }
        }
    }

    @Test
    fun `failed send marks the row failed and retry re-fires with the same localId`() = runTest {
        val harness = InteractionHarness(this)
        harness.api.sendFailures += RuntimeException("boom")
        harness.viewModel.start()

        harness.viewModel.setComposerText("try me")
        harness.viewModel.sendMessage()
        harness.window().state.first { state ->
            state.messages.any { it.localId == "local-1" && it.status == MessageStatus.Failed }
        }

        harness.viewModel.retryFailedMessage("local-1")
        harness.window().state.first { state ->
            state.messages.any { it.localId == "local-1" && it.status == MessageStatus.Sent }
        }
        val requests = harness.api.sendCalls.value.map { it.second }
        assertEquals(2, requests.size)
        assertEquals("try me", requests[1].text)
        assertEquals("local-1", requests[1].localId)
        // Retry never re-binds a steer intent; durable queue only.
        assertEquals("queue", requests[1].deliveryMode)
    }

    @Test
    fun `session_inactive resumes once and retries against the same id`() = runTest {
        val harness = InteractionHarness(this, detail(active = false, permissionMode = "acceptEdits"))
        harness.api.sendFailures += ApiError(409, code = "session_inactive")
        harness.api.resumeResult = ResumeSessionResponse(sessionId = IX_SESSION)
        harness.viewModel.start()
        // Entry loading crosses the UI/worker boundary; finish it before
        // testing an action that intentionally changes the server snapshot.
        harness.sessionStore.calls.first { "loadDetail:$IX_SESSION" in it }

        harness.viewModel.setComposerText("wake up")
        harness.viewModel.sendMessage()

        harness.window().state.first { state ->
            state.messages.any { it.localId == "local-1" && it.status == MessageStatus.Sent }
        }
        assertEquals(listOf(IX_SESSION to "acceptEdits"), harness.api.resumeCalls.value)
        assertEquals(2, harness.api.sendCalls.value.size)
        assertEquals(IX_SESSION, harness.api.sendCalls.value[1].first)
        // Resume success reflects activity locally.
        assertTrue(harness.sessionStore.currentDetail(IX_SESSION)!!.active)
    }

    @Test
    fun `session_inactive resume with a superseding id migrates the send and emits the event`() = runTest {
        val harness = InteractionHarness(this, detail(active = false))
        harness.api.sendFailures += ApiError(409, code = "session_inactive")
        harness.api.resumeResult = ResumeSessionResponse(sessionId = "sess-2")
        harness.viewModel.start()

        var superseded: String? = null
        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            superseded = harness.viewModel.events
                .filterIsInstance<ChatEvent.SessionSuperseded>()
                .first()
                .sessionId
        }

        harness.viewModel.setComposerText("follow me")
        harness.viewModel.sendMessage()
        collector.join()

        assertEquals("sess-2", superseded)
        // The retry targeted the superseding session…
        assertEquals("sess-2", harness.api.sendCalls.value[1].first)
        // …and the optimistic row lives (settled) in the new window only.
        val newWindow = harness.messageWindows.open("sess-2")
        newWindow.state.first { state ->
            state.messages.any { it.localId == "local-1" && it.status == MessageStatus.Sent }
        }
        val oldRows = harness.window().state.value.messages.filter { it.localId == "local-1" }
        assertTrue(oldRows.isEmpty())
    }

    // --------------------------------------------------------- attachments --

    private fun preparedShot(id: String = "att-1", filename: String = "shot.jpg") = PreparedAttachment(
        id = id,
        filename = filename,
        mimeType = "image/jpeg",
        bytes = byteArrayOf(1, 2, 3),
        previewBytes = byteArrayOf(7, 7),
    )

    private suspend fun InteractionHarness.awaitAttachmentsReady() {
        viewModel.attachments.items.first { list ->
            list.isNotEmpty() && list.all { it.status == ComposerAttachmentStatus.Ready }
        }
    }

    private fun sharedBatch() = PendingShare("share-1", 1_000, "shared text", listOf(
        SharedFile("shared-1", "content://one", "one.jpg", status = SharedFileStatus.Ready),
        SharedFile("shared-2", "content://two", "two.jpg", status = SharedFileStatus.Ready),
    ))

    @Test fun `entering the share picker commits unsaved text before a superseding session migration`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        vm.start()
        testScheduler.runCurrent()
        vm.setComposerText("latest keystrokes")
        assertNull(harness.drafts.map[IX_SESSION])
        vm.persistComposerDraft()
        harness.drafts.move(IX_SESSION, "replacement")
        assertEquals("latest keystrokes", harness.drafts.map["replacement"])
    }

    @Test fun `share waits for draft restore and handoff before allowing an explicit send`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val loadGate = CompletableDeferred<Unit>()
        val handoffGate = CompletableDeferred<Unit>()
        harness.drafts.map[IX_SESSION] = "existing draft"
        harness.drafts.loadGate = loadGate
        vm.start()
        vm.attachments.add(preparedShot("existing"))
        val prepared = mutableListOf<String>()
        val importing = async {
            vm.importShare(sharedBatch(), complete = { handoffGate.await() }) { file ->
                prepared += file.id
                PrepareResult.Ready(preparedShot(file.id, file.filename))
            }
        }
        testScheduler.runCurrent()
        assertTrue(vm.composer.value.isImportingShare)
        assertTrue(prepared.isEmpty())
        vm.sendMessage()
        assertTrue(harness.api.sendCalls.value.isEmpty())
        loadGate.complete(Unit)
        testScheduler.runCurrent()
        assertEquals("existing draft\nshared text", vm.composer.value.text)
        vm.sendMessage()
        assertTrue(harness.api.sendCalls.value.isEmpty(), "the inbox handoff has not committed yet")
        handoffGate.complete(Unit)
        assertNull(importing.await())
        vm.attachments.items.first { it.size == 3 && it.all { chip -> chip.status == ComposerAttachmentStatus.Ready } }
        assertTrue(harness.api.sendCalls.value.isEmpty(), "import never sends automatically")
        vm.sendMessage()
        val request = harness.api.sendCalls.first { it.isNotEmpty() }.single().second
        assertEquals("existing draft\nshared text", request.text)
        assertEquals(setOf("existing", "shared-1", "shared-2"), request.attachments!!.map { it.id }.toSet())
        vm.importShare(sharedBatch()) { error("already accepted share must not prepare again") }
        assertEquals(1, harness.api.sendCalls.value.size)
    }

    @Test fun `partial share failure and retry do not duplicate text or successful attachments`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        harness.drafts.map[IX_SESSION] = "existing"
        vm.start()
        val prepared = mutableListOf<String>()
        val failure = vm.importShare(sharedBatch()) { file ->
            prepared += file.id
            if (file.id == "shared-2") PrepareResult.Unreadable(file.filename)
            else PrepareResult.Ready(preparedShot(file.id, file.filename))
        }
        assertEquals(ShareImportFailure("shared-2", SharedFileStatus.Unreadable), failure)
        vm.importShare(sharedBatch()) { file ->
            prepared += file.id
            PrepareResult.Ready(preparedShot(file.id, file.filename))
        }
        assertEquals(listOf("shared-1", "shared-2", "shared-2"), prepared)
        assertEquals("existing\nshared text", vm.composer.first { !it.isImportingShare }.text)
        assertEquals(setOf("shared-1", "shared-2"), vm.attachments.items.first { it.size == 2 }.map { it.id }.toSet())
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    @Test fun `canceled import can resume on the same holder without replaying its text`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        vm.start()
        val gate = CompletableDeferred<Unit>()
        val importing = launch {
            vm.importShare(sharedBatch()) { file ->
                gate.await()
                PrepareResult.Ready(preparedShot(file.id, file.filename))
            }
        }
        testScheduler.runCurrent()
        assertEquals("shared text", vm.composer.value.text)
        importing.cancel()
        importing.join()
        vm.importShare(sharedBatch()) { file -> PrepareResult.Ready(preparedShot(file.id, file.filename)) }
        assertEquals("shared text", vm.composer.first { !it.isImportingShare }.text)
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    @Test
    fun `send rides ready attachments as wire metadata and the optimistic row carries them`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()

        harness.viewModel.attachments.add(preparedShot())
        harness.awaitAttachmentsReady()
        harness.viewModel.setComposerText("see the screenshot")
        harness.viewModel.sendMessage()

        val (_, request) = harness.api.sendCalls.first { it.isNotEmpty() }.single()
        val metadata = request.attachments!!.single()
        assertEquals("att-1", metadata.id)
        assertEquals("shot.jpg", metadata.filename)
        assertEquals("image/jpeg", metadata.mimeType)
        assertEquals(3L, metadata.size)
        assertEquals("/uploads/ok", metadata.path)
        assertTrue(metadata.previewUrl!!.startsWith("data:image/jpeg;base64,"))
        assertNull(request.scheduledAt)

        // The optimistic row carries the attachments — thumbnails render
        // before the SSE echo replaces it.
        val row = harness.window().state.first { state ->
            state.messages.any { it.localId == "local-1" && it.status == MessageStatus.Sent }
        }.messages.single()
        val normalized = normalizeDecryptedMessage(row.wire) as NormalizedMessage.User
        assertEquals(listOf("shot.jpg"), normalized.attachments?.map { it.filename })

        // The tray was consumed by the send (items is derived — await it).
        harness.viewModel.attachments.items.first { it.isEmpty() }
    }

    @Test
    fun `attachments-only send posts empty text (wire allows text OR attachments)`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()

        harness.viewModel.attachments.add(preparedShot())
        harness.awaitAttachmentsReady()
        harness.viewModel.sendMessage()

        val (_, request) = harness.api.sendCalls.first { it.isNotEmpty() }.single()
        assertEquals("", request.text)
        assertEquals(1, request.attachments!!.size)
    }

    @Test
    fun `send refuses while an attachment upload is unsettled`() = runTest {
        val harness = InteractionHarness(this)
        harness.api.uploadGate = CompletableDeferred()
        harness.viewModel.start()

        var notice: ChatNotice? = null
        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            notice = harness.viewModel.events
                .filterIsInstance<ChatEvent.Notice>()
                .first()
                .notice
        }

        harness.viewModel.attachments.add(preparedShot())
        harness.api.uploadCalls.first { it.isNotEmpty() } // parked on the gate
        harness.viewModel.setComposerText("hold on")
        harness.viewModel.sendMessage()
        collector.join()

        assertEquals(ChatNotice.AttachmentsUploading, notice)
        assertTrue(harness.api.sendCalls.value.isEmpty())
        // The draft text and the chip both survive the refused send.
        assertEquals("hold on", harness.viewModel.composer.first { it.text.isNotEmpty() }.text)
        assertEquals(1, harness.viewModel.attachments.items.first { it.isNotEmpty() }.size)

        // Once the upload settles, the same send goes through with metadata.
        harness.api.uploadGate!!.complete(Unit)
        harness.awaitAttachmentsReady()
        harness.viewModel.sendMessage()
        val (_, request) = harness.api.sendCalls.first { it.isNotEmpty() }.single()
        assertEquals("hold on", request.text)
        assertEquals(1, request.attachments!!.size)
    }

    @Test
    fun `failed send retry re-sends the same attachments from the wire row`() = runTest {
        val harness = InteractionHarness(this)
        harness.api.sendFailures += RuntimeException("boom")
        harness.viewModel.start()

        harness.viewModel.attachments.add(preparedShot())
        harness.awaitAttachmentsReady()
        harness.viewModel.setComposerText("try again")
        harness.viewModel.sendMessage()
        harness.window().state.first { state ->
            state.messages.any { it.localId == "local-1" && it.status == MessageStatus.Failed }
        }

        harness.viewModel.retryFailedMessage("local-1")
        harness.window().state.first { state ->
            state.messages.any { it.localId == "local-1" && it.status == MessageStatus.Sent }
        }

        val requests = harness.api.sendCalls.value.map { it.second }
        assertEquals(2, requests.size)
        // Attachments round-tripped through the optimistic row's wire JSON.
        assertEquals(requests[0].attachments, requests[1].attachments)
        assertEquals("/uploads/ok", requests[1].attachments!!.single().path)
    }

    @Test
    fun `removing a ready chip deletes the hub upload and discard drops the rest`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()

        harness.viewModel.attachments.add(preparedShot(id = "att-1", filename = "a.jpg"))
        harness.awaitAttachmentsReady()
        harness.viewModel.attachments.remove("att-1")
        harness.api.deleteUploadCalls.first { it.size == 1 }
        harness.viewModel.attachments.items.first { it.isEmpty() }

        // Un-sent leftovers are discarded when the screen goes away for good.
        harness.viewModel.attachments.add(preparedShot(id = "att-2", filename = "b.jpg"))
        harness.awaitAttachmentsReady()
        harness.viewModel.discardAttachments()
        harness.api.deleteUploadCalls.first { it.size == 2 }
        harness.viewModel.attachments.items.first { it.isEmpty() }
    }

    // ---------------------------------------------------------- queued bar --

    /** Server-echoed queued row (id != localId, explicit `invokedAt: null`). */
    private fun queuedServerRow(
        id: String,
        localId: String,
        text: String,
        scheduledAt: Long? = null,
    ): DecryptedMessage =
        DecryptedMessage(
            id = id,
            seq = 7,
            localId = localId,
            createdAt = 500,
            invokedAt = OptionalField.Present(null),
            scheduledAt = scheduledAt,
            content = buildJsonObject {
                put("role", "user")
                putJsonObject("content") {
                    put("type", "text")
                    put("text", text)
                }
            },
        )

    @Test
    fun `queued cancel invoked-race ingests the authoritative row as sent`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()
        val window = harness.window()
        window.ingestSseMessages(
            listOf(app.hapi.protocol.window.WindowMessage(queuedServerRow("srv-1", "l-1", "queued text"))),
        )
        harness.viewModel.queuedRows.first { rows -> rows.any { it.id == "srv-1" && it.canAct } }

        harness.api.cancelResult = CancelMessageResponse(
            status = "invoked",
            message = queuedServerRow("srv-1", "l-1", "queued text")
                .copy(invokedAt = OptionalField.Present(900)),
        )
        harness.viewModel.cancelQueuedMessage("srv-1")

        harness.viewModel.queuedRows.first { it.isEmpty() }
        val row = window.state.first { state ->
            state.messages.any { it.localId == "l-1" && it.status == MessageStatus.Sent }
        }.messages.single { it.localId == "l-1" }
        assertEquals(900L, row.invokedAtOrNull)
        assertEquals(listOf("srv-1"), harness.api.cancelCalls.value)
    }

    @Test
    fun `steer posts and an invoked answer reconciles a missed consume`() = runTest {
        val harness = InteractionHarness(this, detail(thinking = true))
        harness.viewModel.start()
        val window = harness.window()
        window.ingestSseMessages(
            listOf(app.hapi.protocol.window.WindowMessage(queuedServerRow("srv-2", "l-2", "steer me"))),
        )
        harness.viewModel.queuedRows.first { rows -> rows.any { it.id == "srv-2" && it.canSteer } }

        harness.api.steerResult = SteerQueuedMessageResponse(
            status = "invoked",
            message = queuedServerRow("srv-2", "l-2", "steer me").copy(invokedAt = OptionalField.Present(950)),
        )
        harness.viewModel.steerQueuedMessage("srv-2")

        val row = window.state.first { state ->
            state.messages.any { it.localId == "l-2" && it.invokedAtOrNull == 950L }
        }.messages.single { it.localId == "l-2" }
        assertNotNull(row)
        assertEquals(listOf("srv-2"), harness.api.steerCalls.value)
    }

    @Test
    fun `edit cancels and prefills the composer`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()
        harness.window().ingestSseMessages(
            listOf(app.hapi.protocol.window.WindowMessage(queuedServerRow("srv-3", "l-3", "edit me"))),
        )
        harness.viewModel.queuedRows.first { rows -> rows.any { it.id == "srv-3" } }

        harness.viewModel.editQueuedMessage("srv-3")
        harness.viewModel.composer.first { it.text == "edit me" }
        assertEquals(listOf("srv-3"), harness.api.cancelCalls.value)
    }

    // ------------------------------------------------------ scheduled send --

    @Test
    fun `scheduled send resolves the preset at the send instant and clears the pick`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()

        harness.viewModel.setComposerText("later please")
        harness.viewModel.setPendingSchedule(PendingSchedule.Preset("+30m"))
        assertEquals(PendingSchedule.Preset("+30m"), harness.viewModel.pendingSchedule.value)
        harness.viewModel.sendMessage()

        val (_, request) = harness.api.sendCalls.first { it.isNotEmpty() }.single()
        // The now() fixture is 1_000 — a preset anchors to the Send tap.
        assertEquals(1_801_000L, request.scheduledAt)
        assertEquals("queue", request.deliveryMode)
        assertNull(harness.viewModel.pendingSchedule.value)

        val row = harness.window().state.first { state ->
            state.messages.any { it.localId == "local-1" && it.status == MessageStatus.Sent }
        }.messages.single()
        assertEquals(1_801_000L, row.wire.scheduledAt)
    }

    @Test
    fun `pending schedule downgrades a steer long-press to durable queue`() = runTest {
        val harness = InteractionHarness(this, detail(thinking = true))
        harness.viewModel.start()

        harness.viewModel.setComposerText("steer later")
        harness.viewModel.setPendingSchedule(PendingSchedule.Absolute(50_000))
        harness.viewModel.sendMessage(steer = true)

        val (_, request) = harness.api.sendCalls.first { it.isNotEmpty() }.single()
        assertEquals(50_000L, request.scheduledAt)
        // The wire forbids scheduledAt + steer; the web forces the send
        // intent to 'default' while a schedule is pending.
        assertEquals("queue", request.deliveryMode)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `absolute pending pick auto-clears on the virtual clock and presets never do`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()

        // now() fixture is 1_000 → this pick is 4_000 ms out.
        harness.viewModel.setPendingSchedule(PendingSchedule.Absolute(5_000))
        assertEquals(PendingSchedule.Absolute(5_000), harness.viewModel.pendingSchedule.value)
        testScheduler.advanceTimeBy(3_999)
        testScheduler.runCurrent()
        assertEquals(PendingSchedule.Absolute(5_000), harness.viewModel.pendingSchedule.value)
        testScheduler.advanceTimeBy(2)
        testScheduler.runCurrent()
        assertNull(harness.viewModel.pendingSchedule.value)

        // Presets are send-relative; they never expire on a timer.
        harness.viewModel.setPendingSchedule(PendingSchedule.Preset("+5m"))
        testScheduler.advanceTimeBy(60_000_000)
        testScheduler.runCurrent()
        assertEquals(PendingSchedule.Preset("+5m"), harness.viewModel.pendingSchedule.value)
    }

    @Test
    fun `within-grace past absolute pick clears immediately`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()

        // 500 < now() = 1_000, but within the 30 s validation grace: the
        // web's `remaining <= 0` branch clears it the moment it is picked.
        harness.viewModel.setPendingSchedule(PendingSchedule.Absolute(500))
        assertNull(harness.viewModel.pendingSchedule.value)
    }

    @Test
    fun `edit of a scheduled queued row re-arms the pending schedule`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()
        harness.window().ingestSseMessages(
            listOf(
                app.hapi.protocol.window.WindowMessage(
                    queuedServerRow("srv-4", "l-4", "scheduled edit", scheduledAt = 99_999),
                ),
            ),
        )
        harness.viewModel.queuedRows.first { rows -> rows.any { it.id == "srv-4" } }

        harness.viewModel.editQueuedMessage("srv-4")
        harness.viewModel.composer.first { it.text == "scheduled edit" }
        assertEquals(PendingSchedule.Absolute(99_999), harness.viewModel.pendingSchedule.value)
        assertEquals(listOf("srv-4"), harness.api.cancelCalls.value)
    }

    @Test
    fun `edit of an unscheduled row clears any pending pick`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()
        harness.window().ingestSseMessages(
            listOf(app.hapi.protocol.window.WindowMessage(queuedServerRow("srv-5", "l-5", "plain edit"))),
        )
        harness.viewModel.queuedRows.first { rows -> rows.any { it.id == "srv-5" } }
        harness.viewModel.setPendingSchedule(PendingSchedule.Preset("+1h"))

        // The web restores unconditionally (computeEditPendingSchedule(null)
        // → null), so the re-send goes out immediately.
        harness.viewModel.editQueuedMessage("srv-5")
        harness.viewModel.composer.first { it.text == "plain edit" }
        harness.viewModel.pendingSchedule.first { it == null }
    }

    @Test
    fun `edit drops the schedule restore while attachments sit in the tray`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()
        harness.window().ingestSseMessages(
            listOf(
                app.hapi.protocol.window.WindowMessage(
                    queuedServerRow("srv-6", "l-6", "with tray", scheduledAt = 77_777),
                ),
            ),
        )
        harness.viewModel.queuedRows.first { rows -> rows.any { it.id == "srv-6" } }
        // Any chip (even mid-upload) blocks the restore: the clock button is
        // disabled with a non-empty tray, so an armed pick would be invisible
        // and un-clearable, and the send would trip the scheduled+attachments
        // wire invariant.
        harness.viewModel.attachments.add(preparedShot())

        // Subscribe before the edit so the zero-replay event flow keeps it.
        val notice = async {
            harness.viewModel.events.filterIsInstance<ChatEvent.Notice>().first().notice
        }
        harness.viewModel.editQueuedMessage("srv-6")
        harness.viewModel.composer.first { it.text == "with tray" }
        assertNull(harness.viewModel.pendingSchedule.value)
        assertEquals(ChatNotice.QueuedEditScheduleDropped, notice.await())
    }

    @Test
    fun `edit keeps a schedule pick re-made while the edit is in flight`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()
        harness.window().ingestSseMessages(
            listOf(
                app.hapi.protocol.window.WindowMessage(
                    queuedServerRow("srv-7", "l-7", "mid-flight pick", scheduledAt = 88_888),
                ),
            ),
        )
        harness.viewModel.queuedRows.first { rows -> rows.any { it.id == "srv-7" } }

        // The edit snapshots the pick at tap time (null); the operator
        // re-picks on the clock while the cancel round-trip is in flight.
        harness.viewModel.editQueuedMessage("srv-7")
        harness.viewModel.setPendingSchedule(PendingSchedule.Preset("+1h"))

        harness.viewModel.composer.first { it.text == "mid-flight pick" }
        assertEquals(PendingSchedule.Preset("+1h"), harness.viewModel.pendingSchedule.value)
    }

    @Test
    fun `a scheduled clear queues instead of the concurrent shortcut`() = runTest {
        val concurrent = detail().copy(
            metadata = SessionMetadata(
                path = "/repo/app", host = "devbox", flavor = "claude",
                capabilities = SessionCapabilities(concurrentClients = true),
            ),
        )
        val harness = InteractionHarness(this, concurrent)
        harness.viewModel.start()

        harness.viewModel.setComposerText("/clear")
        harness.viewModel.setPendingSchedule(PendingSchedule.Preset("+5m"))
        harness.viewModel.sendMessage()

        // With a schedule pending the /clear goes out as a queued scheduled
        // message (web gates the shortcut on scheduledAt == null); the fake's
        // clearConversation throws, so a regression would surface as no send.
        val (_, request) = harness.api.sendCalls.first { it.isNotEmpty() }.single()
        assertNotNull(request.scheduledAt)
        assertEquals("queue", request.deliveryMode)
    }

    // ------------------------------------------- schedule x attachments gate --

    @Test
    fun `schedule picks are rejected while attachments sit in the tray`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()
        // The open-picker scenario: the panel stays interactive after "+"
        // drops a chip; the ViewModel transition — not the disabled clock
        // button — must refuse to arm over the tray.
        harness.viewModel.attachments.add(preparedShot())
        harness.awaitAttachmentsReady()

        harness.viewModel.setPendingSchedule(PendingSchedule.Preset("+30m"))
        assertNull(harness.viewModel.pendingSchedule.value)
        harness.viewModel.setPendingSchedule(PendingSchedule.Absolute(999_999))
        assertNull(harness.viewModel.pendingSchedule.value)

        // Clearing stays allowed over a non-empty tray (it only disarms).
        harness.viewModel.setPendingSchedule(null)
        assertNull(harness.viewModel.pendingSchedule.value)

        // A rejected pick never leaks into the attachment send.
        harness.viewModel.setComposerText("plain attachment send")
        harness.viewModel.sendMessage()
        val (_, request) = harness.api.sendCalls.first { it.isNotEmpty() }.single()
        assertNull(request.scheduledAt)
        assertEquals(1, request.attachments?.size)
    }

    @Test
    fun `a scheduled send over tray chips blocks before consuming the draft or uploads`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()
        harness.viewModel.setComposerText("with chips")
        harness.viewModel.setPendingSchedule(PendingSchedule.Preset("+5m"))
        // The reverse order (pick armed first, chip lands after — share
        // import or the still-open panel) must refuse BEFORE the draft
        // clears or the tray consumes, keeping both recoverable instead of
        // crashing later on the wire invariant.
        harness.viewModel.attachments.add(preparedShot())
        harness.awaitAttachmentsReady()

        val notices = mutableListOf<ChatNotice>()
        val collector = launch { harness.viewModel.events.collect { if (it is ChatEvent.Notice) notices += it.notice } }
        testScheduler.runCurrent()
        harness.viewModel.sendMessage()
        testScheduler.runCurrent()
        collector.cancel()

        assertEquals<List<ChatNotice>>(listOf(ChatNotice.ScheduleAttachmentConflict), notices)
        assertEquals("with chips", harness.viewModel.composer.value.text)
        assertEquals(PendingSchedule.Preset("+5m"), harness.viewModel.pendingSchedule.value)
        assertTrue(harness.api.sendCalls.value.isEmpty())
        assertEquals(1, harness.viewModel.attachments.items.value.size, "the refused send must not consume the chip")
    }

    // ---------------------------------------------- schedule serialization --

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `rapid consecutive absolute picks keep only the newest expiry alive`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()

        // now() fixture is 1_000 → first pick fires at t+4_000, second at
        // t+8_000. Registration is one critical section: the second apply
        // always observes and cancels the first timer, and the revision
        // guard is the second layer if it ever raced through.
        harness.viewModel.setPendingSchedule(PendingSchedule.Absolute(5_000))
        harness.viewModel.setPendingSchedule(PendingSchedule.Absolute(9_000))
        assertEquals(PendingSchedule.Absolute(9_000), harness.viewModel.pendingSchedule.value)

        testScheduler.advanceTimeBy(4_000)
        testScheduler.runCurrent()
        assertEquals(PendingSchedule.Absolute(9_000), harness.viewModel.pendingSchedule.value)

        testScheduler.advanceTimeBy(4_001)
        testScheduler.runCurrent()
        assertNull(harness.viewModel.pendingSchedule.value)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `a preset picked after a restored absolute survives the restore's deadline`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()
        harness.window().ingestSseMessages(
            listOf(
                app.hapi.protocol.window.WindowMessage(
                    queuedServerRow("srv-8", "l-8", "stale deadline", scheduledAt = 5_000),
                ),
            ),
        )
        harness.viewModel.queuedRows.first { rows -> rows.any { it.id == "srv-8" } }

        // The edit re-arms the row's absolute pick (deadline t+4_000), then
        // the operator re-picks a preset. The restored pick's timer must not
        // clear the newer preset at its deadline — the review's "next Send
        // goes out immediately despite the newer preset" symptom.
        harness.viewModel.editQueuedMessage("srv-8")
        harness.viewModel.pendingSchedule.first { it == PendingSchedule.Absolute(5_000) }
        harness.viewModel.setPendingSchedule(PendingSchedule.Preset("+5m"))

        testScheduler.advanceTimeBy(4_100)
        testScheduler.runCurrent()
        assertEquals(PendingSchedule.Preset("+5m"), harness.viewModel.pendingSchedule.value)

        // And the send under it still resolves the preset, not immediate.
        harness.viewModel.setComposerText("still scheduled")
        harness.viewModel.sendMessage()
        val (_, request) = harness.api.sendCalls.first { it.isNotEmpty() }.single()
        assertNotNull(request.scheduledAt)
    }

    @Test
    fun `edit restore loses to a pick and explicit clear made mid-flight`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()
        harness.window().ingestSseMessages(
            listOf(
                app.hapi.protocol.window.WindowMessage(
                    queuedServerRow("srv-9", "l-9", "pick then clear", scheduledAt = 99_999),
                ),
            ),
        )
        harness.viewModel.queuedRows.first { rows -> rows.any { it.id == "srv-9" } }

        // Edit taps with no pending pick; while the cancel round-trip hangs,
        // the operator picks a preset and explicitly clears it. The slot is
        // null again — value equality would call it "unchanged" and restore
        // the row's old schedule over the explicit clear.
        harness.api.cancelGate = CompletableDeferred()
        harness.viewModel.editQueuedMessage("srv-9")
        testScheduler.runCurrent()
        assertEquals(listOf("srv-9"), harness.api.cancelCalls.value)
        harness.viewModel.setPendingSchedule(PendingSchedule.Preset("+1h"))
        harness.viewModel.setPendingSchedule(null)
        harness.api.cancelGate!!.complete(Unit)

        harness.viewModel.composer.first { it.text == "pick then clear" }
        testScheduler.runCurrent()
        assertNull(harness.viewModel.pendingSchedule.value)
    }

    @Test
    fun `edit restore loses to a clear and same-preset reselection made mid-flight`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()
        harness.window().ingestSseMessages(
            listOf(
                app.hapi.protocol.window.WindowMessage(
                    queuedServerRow("srv-10", "l-10", "reselect same", scheduledAt = 88_888),
                ),
            ),
        )
        harness.viewModel.queuedRows.first { rows -> rows.any { it.id == "srv-10" } }

        // The slot starts AND ends at Preset("+1h") — value equal — but the
        // clear→reselect interactions in between are newer than the Edit
        // tap, so the revision must keep the restore off the slot.
        harness.viewModel.setPendingSchedule(PendingSchedule.Preset("+1h"))
        harness.viewModel.editQueuedMessage("srv-10")
        harness.viewModel.setPendingSchedule(null)
        harness.viewModel.setPendingSchedule(PendingSchedule.Preset("+1h"))

        harness.viewModel.composer.first { it.text == "reselect same" }
        testScheduler.runCurrent()
        assertEquals(PendingSchedule.Preset("+1h"), harness.viewModel.pendingSchedule.value)
    }

    // --------------------------------------------------------- permissions --

    private fun approvedBodies(harness: InteractionHarness): List<String> =
        harness.api.approveCalls.value.map { (_, body) -> HapiJson.encodeToString(body) }

    @Test
    fun `claude approve bodies match the web PermissionFooter exactly`() = runTest {
        val requests = mapOf(
            "r-allow" to bashRequest(),
            "r-session" to bashRequest("git push"),
            "r-edits" to AgentStateRequest(tool = "Edit", arguments = buildJsonObject { put("file_path", "/a") }),
            "r-deny" to bashRequest(),
        )
        val harness = InteractionHarness(this, detail(flavor = "claude", agentState = AgentState(requests = requests)))
        harness.viewModel.start()

        harness.viewModel.resolvePermission("r-allow", PermissionAction.Allow)
        harness.api.approveCalls.first { it.size == 1 }
        harness.viewModel.resolvePermission("r-session", PermissionAction.AllowForSession)
        harness.api.approveCalls.first { it.size == 2 }
        harness.viewModel.resolvePermission("r-edits", PermissionAction.AllowAllEdits)
        harness.api.approveCalls.first { it.size == 3 }
        harness.viewModel.resolvePermission("r-deny", PermissionAction.Deny)
        harness.api.denyCalls.first { it.size == 1 }

        assertEquals(
            listOf(
                """{}""",
                """{"allowTools":["Bash(git push)"]}""",
                """{"mode":"acceptEdits"}""",
            ),
            approvedBodies(harness),
        )
        assertEquals(listOf("r-deny" to null), harness.api.denyCalls.value)
    }

    @Test
    fun `codex family approve and abort bodies use decisions`() = runTest {
        val requests = mapOf(
            "r-yes" to AgentStateRequest(tool = "CodexBash", arguments = buildJsonObject { put("command", "ls") }),
            "r-yes-session" to AgentStateRequest(tool = "CodexBash"),
            "r-abort" to AgentStateRequest(tool = "CodexBash"),
        )
        val harness = InteractionHarness(this, detail(flavor = "codex", agentState = AgentState(requests = requests)))
        harness.viewModel.start()

        harness.viewModel.resolvePermission("r-yes", PermissionAction.Allow)
        harness.api.approveCalls.first { it.size == 1 }
        harness.viewModel.resolvePermission("r-yes-session", PermissionAction.AllowForSession)
        harness.api.approveCalls.first { it.size == 2 }
        harness.viewModel.resolvePermission("r-abort", PermissionAction.Abort)
        harness.api.denyCalls.first { it.size == 1 }

        assertEquals(
            listOf(
                """{"decision":"approved"}""",
                """{"decision":"approved_for_session"}""",
            ),
            approvedBodies(harness),
        )
        assertEquals(listOf("r-abort" to "abort"), harness.api.denyCalls.value)
    }

    @Test
    fun `answers post flat for AskUserQuestion and nested for request_user_input`() = runTest {
        val requests = mapOf(
            "r-ask" to AgentStateRequest(tool = "AskUserQuestion"),
            "r-input" to AgentStateRequest(tool = "request_user_input"),
        )
        val harness = InteractionHarness(this, detail(flavor = "claude", agentState = AgentState(requests = requests)))
        harness.viewModel.start()

        harness.viewModel.resolvePermission(
            "r-ask",
            PermissionAction.FlatAnswers(linkedMapOf("0" to listOf("Option A", "free text"))),
        )
        harness.api.approveCalls.first { it.size == 1 }
        harness.viewModel.resolvePermission(
            "r-input",
            PermissionAction.NestedAnswers(linkedMapOf("field1" to listOf("Yes", "user_note: extra note"))),
        )
        harness.api.approveCalls.first { it.size == 2 }

        assertEquals(
            listOf(
                """{"answers":{"0":["Option A","free text"]}}""",
                """{"answers":{"field1":{"answers":["Yes","user_note: extra note"]}}}""",
            ),
            approvedBodies(harness),
        )
    }

    @Test
    fun `permission 404 becomes the benign already-handled override`() = runTest {
        val requests = mapOf("r-gone" to bashRequest())
        val harness = InteractionHarness(this, detail(agentState = AgentState(requests = requests)))
        harness.api.approveFailure = ApiError(404, code = "Request not found")
        harness.viewModel.start()

        harness.viewModel.resolvePermission("r-gone", PermissionAction.Allow)
        harness.viewModel.uiState.first {
            it.permissionOverrides["r-gone"] == PermissionRowOverride.AlreadyHandled
        }
    }

    @Test
    fun `successful resolve keeps the row resolving until the agentState patch settles it`() = runTest {
        val requests = mapOf("r-live" to bashRequest())
        val harness = InteractionHarness(this, detail(agentState = AgentState(requests = requests)))
        harness.viewModel.start()

        harness.viewModel.resolvePermission("r-live", PermissionAction.Allow)
        harness.viewModel.uiState.first {
            it.permissionOverrides["r-live"] == PermissionRowOverride.Resolving
        }

        // The agentState patch lands (request moved to completedRequests).
        harness.sessionStore.setDetail(detail(agentState = AgentState(requests = emptyMap())))
        harness.viewModel.uiState.first { it.permissionOverrides.isEmpty() }
    }

    // -------------------------------------------------------------- config --

    @Test
    fun `permission mode switch applies optimistically and rolls back to server truth on error`() = runTest {
        val harness = InteractionHarness(this, detail(permissionMode = "default"))
        harness.api.configFailure = ApiError(409, code = "apply_failed")
        harness.viewModel.start()
        harness.sessionStore.calls.first { "loadDetail:$IX_SESSION" in it }

        var notice: ChatNotice? = null
        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            notice = harness.viewModel.events.filterIsInstance<ChatEvent.Notice>().first().notice
        }

        harness.viewModel.setPermissionMode(PermissionMode.AcceptEdits)
        // Optimistic flip is visible synchronously in the detail cache.
        assertEquals("acceptEdits", harness.sessionStore.currentDetail(IX_SESSION)?.permissionMode)

        collector.join()
        assertIs<ChatNotice.ConfigUpdateFailed>(notice)
        // Rollback = reload server truth (scripted detail carries "default").
        assertEquals("default", harness.sessionStore.currentDetail(IX_SESSION)?.permissionMode)
        assertTrue(harness.sessionStore.calls.value.count { it == "loadDetail:$IX_SESSION" } >= 2)
        assertEquals(listOf("mode:acceptEdits"), harness.api.configCalls.value)
    }

    @Test
    fun `permission mode switch is withheld for terminal-controlled copilot sessions`() = runTest {
        val harness = InteractionHarness(
            this,
            detail(
                flavor = "copilot",
                permissionMode = "read-only",
                agentState = AgentState(controlledByUser = true),
            ),
        )
        harness.viewModel.start()
        harness.sessionStore.calls.first { "loadDetail:$IX_SESSION" in it }

        harness.viewModel.setPermissionMode(PermissionMode.Yolo)
        testScheduler.advanceUntilIdle()

        // Web parity: the switcher callback is withheld (SessionChat.tsx:
        // 2159-2163) — no request, no optimistic flip.
        assertTrue(harness.api.configCalls.value.none { it.startsWith("mode:") })
        assertEquals("read-only", harness.sessionStore.currentDetail(IX_SESSION)?.permissionMode)
    }

    @Test
    fun `permission mode switch survives terminal control outside copilot and shared-clients copilot`() = runTest {
        val sharedClients = detail(
            flavor = "copilot",
            permissionMode = "read-only",
            agentState = AgentState(controlledByUser = true),
        ).copy(
            metadata = SessionMetadata(
                path = "/repo", host = "devbox", flavor = "copilot",
                capabilities = SessionCapabilities(concurrentClients = true),
            ),
        )
        val harness = InteractionHarness(this, sharedClients)
        harness.viewModel.start()
        harness.sessionStore.calls.first { "loadDetail:$IX_SESSION" in it }

        harness.viewModel.setPermissionMode(PermissionMode.Yolo)
        harness.api.configCalls.first { "mode:yolo" in it }
        testScheduler.advanceUntilIdle()

        // Terminal-controlled claude keeps the switcher: only copilot loses
        // it on web (controlledByUser derivation matches SessionChat.tsx:996).
        harness.sessionStore.setDetail(
            detail(flavor = "claude", agentState = AgentState(controlledByUser = true)),
        )
        harness.viewModel.setPermissionMode(PermissionMode.AcceptEdits)
        harness.api.configCalls.first { "mode:acceptEdits" in it }
    }

    @Test
    fun `permission mode switch stays available for inactive sessions`() = runTest {
        val harness = InteractionHarness(this, detail(active = false, permissionMode = "default"))
        harness.viewModel.start()
        harness.sessionStore.calls.first { "loadDetail:$IX_SESSION" in it }

        harness.viewModel.setPermissionMode(PermissionMode.AcceptEdits)
        harness.api.configCalls.first { "mode:acceptEdits" in it }
    }

    @Test
    fun `model and effort switches route per flavor`() = runTest {
        val harness = InteractionHarness(this, detail(flavor = "claude", model = "sonnet", effort = null))
        harness.viewModel.start()
        // Let the open-time detail load land first, or it would overwrite the
        // optimistic writes below with the scripted detail.
        harness.sessionStore.calls.first { calls -> calls.any { it.startsWith("loadDetail") } }

        harness.viewModel.setModel("opus")
        harness.api.configCalls.first { "model:opus" in it }
        assertEquals("opus", harness.sessionStore.currentDetail(IX_SESSION)?.model)

        harness.viewModel.setEffort("high")
        harness.api.configCalls.first { "effort:high" in it }
        assertEquals("high", harness.sessionStore.currentDetail(IX_SESSION)?.effort)
    }

    @Test
    fun `codex effort routes to model-reasoning-effort`() = runTest {
        val harness = InteractionHarness(this, detail(flavor = "codex"))
        harness.viewModel.start()

        harness.viewModel.setEffort("medium")
        harness.api.configCalls.first { "modelReasoningEffort:medium" in it }
    }

    @Test
    fun `codex model options load through the session catalog endpoint`() = runTest {
        val harness = InteractionHarness(this, detail(flavor = "codex", model = "gpt-5.3-codex"))
        harness.api.codexModelsResult = CodexModelsResponse(
            success = true,
            models = listOf(
                app.hapi.protocol.wire.CodexModelSummary(
                    id = "gpt-5.3-codex",
                    displayName = "GPT-5.3 Codex",
                    isDefault = true,
                    supportedReasoningEfforts = listOf("low", "medium", "high"),
                ),
            ),
        )
        harness.viewModel.start()

        harness.viewModel.loadModelOptions()
        val config = harness.viewModel.config.first { it.modelOptions?.isNotEmpty() == true }
        assertEquals("gpt-5.3-codex", config.modelOptions?.single()?.value)
        assertEquals(listOf(null, "low", "medium", "high"), config.effortOptions?.map { it.value })
    }

    // --------------------------------------------------------------- misc --

    @Test
    fun `draft persists on typing and restores on open`() = runTest {
        val harness = InteractionHarness(this)
        harness.drafts.map[IX_SESSION] = "restored draft"
        harness.viewModel.start()

        harness.viewModel.composer.first { it.text == "restored draft" }

        harness.viewModel.setComposerText("newer draft")
        // Debounced persist (virtual time).
        harness.viewModel.composer.first { it.text == "newer draft" }
        kotlinx.coroutines.delay(50)
        assertEquals("newer draft", harness.drafts.map[IX_SESSION])
    }

    @Test
    fun `abort posts confirm-free`() = runTest {
        val harness = InteractionHarness(this, detail(thinking = true))
        harness.viewModel.start()
        harness.viewModel.abortSession()
        harness.api.configCalls.first { "abort:$IX_SESSION" in it }
    }

    // -------------------------------------------------------- session ops --

    @Test
    fun `explicit reopen with a superseding id migrates the draft and emits the event`() = runTest {
        val harness = InteractionHarness(this, detail(active = false))
        harness.sessionStore.reopenResult =
            ReopenSessionResponse(sessionId = "sess-2", resumed = false)
        harness.drafts.map[IX_SESSION] = "carry me over"
        harness.viewModel.start()

        var superseded: String? = null
        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            superseded = harness.viewModel.events
                .filterIsInstance<ChatEvent.SessionSuperseded>()
                .first()
                .sessionId
        }

        harness.viewModel.reopenSession()
        collector.join()

        assertEquals("sess-2", superseded)
        assertEquals("carry me over", harness.drafts.map["sess-2"])
        assertNull(harness.drafts.map[IX_SESSION])
        assertTrue(harness.sessionStore.calls.value.any { it == "reopen:$IX_SESSION" })
    }

    @Test
    fun `reopen returning the same id stays put`() = runTest {
        val harness = InteractionHarness(this, detail(active = false))
        harness.sessionStore.reopenResult =
            ReopenSessionResponse(sessionId = IX_SESSION, resumed = true)
        harness.viewModel.start()

        val events = mutableListOf<ChatEvent>()
        backgroundScope.launch(start = CoroutineStart.UNDISPATCHED) {
            harness.viewModel.events.collect { events += it }
        }

        harness.viewModel.reopenSession()
        harness.sessionStore.calls.first { calls -> calls.any { it == "reopen:$IX_SESSION" } }
        testScheduler.advanceUntilIdle()

        assertTrue(events.none { it is ChatEvent.SessionSuperseded })
    }

    @Test
    fun `reopen 422 surfaces the missing-metadata notice`() = runTest {
        val harness = InteractionHarness(this, detail(active = false))
        harness.sessionStore.reopenFailure = ApiError(
            422,
            code = "reopen_missing_metadata",
            body = """{"error":"Cannot reopen","missing":["cursorSessionId"]}""",
        )
        harness.viewModel.start()

        var notice: ChatNotice? = null
        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            notice = harness.viewModel.events.filterIsInstance<ChatEvent.Notice>().first().notice
        }

        harness.viewModel.reopenSession()
        collector.join()

        assertEquals(ChatNotice.ReopenFailed("Cannot reopen (missing: cursorSessionId)"), notice)
    }

    @Test
    fun `delete emits SessionDeleted on success and a 409 notice while active`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()

        val deleted = launch(start = CoroutineStart.UNDISPATCHED) {
            harness.viewModel.events.first { it is ChatEvent.SessionDeleted }
        }
        harness.viewModel.deleteSession()
        deleted.join()

        harness.sessionStore.deleteFailure = ApiError(409, code = "session_active")
        var notice: ChatNotice? = null
        val noticeJob = launch(start = CoroutineStart.UNDISPATCHED) {
            notice = harness.viewModel.events.filterIsInstance<ChatEvent.Notice>().first().notice
        }
        harness.viewModel.deleteSession()
        noticeJob.join()

        assertEquals(2, harness.sessionStore.calls.value.count { it == "delete:$IX_SESSION" })
        assertEquals(ChatNotice.DeleteConflictActive, notice)
    }

    @Test
    fun `rename trims, calls the store, and surfaces failure as a notice`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()

        harness.viewModel.renameSession("  New title  ")
        harness.sessionStore.calls.first { calls -> calls.any { it == "rename:$IX_SESSION:New title" } }

        harness.viewModel.renameSession("   ")
        harness.sessionStore.calls.first { calls -> calls.count { it.startsWith("rename:") } == 1 }

        var notice: ChatNotice? = null
        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            notice = harness.viewModel.events.filterIsInstance<ChatEvent.Notice>().first().notice
        }
        harness.sessionStore.renameFailure = RuntimeException("nope")
        harness.viewModel.renameSession("Other")
        collector.join()
        assertEquals(ChatNotice.RenameFailed("nope"), notice)
    }

    @Test
    fun `translate toggle follows features, patches the flag, and surfaces failure`() = runTest {
        val harness = InteractionHarness(this)
        harness.api.featuresResult = FeaturesResponse(inputTranslation = InputTranslationFeature(available = true))
        harness.viewModel.start()

        harness.viewModel.inputTranslationAvailable.first { it }
        assertFalse(harness.viewModel.uiState.first { it.header.title.isNotEmpty() }.header.translateInput)

        // Server truth after the PATCH: the refetched detail carries the flag.
        val enabledDetail = detail().copy(metadata = detail().metadata!!.copy(translateInput = true))
        harness.sessionStore.detailToLoad = enabledDetail
        harness.viewModel.toggleTranslateInput()
        harness.api.translateCalls.first { it == listOf(IX_SESSION to true) }
        harness.viewModel.uiState.first { it.header.translateInput }

        var notice: ChatNotice? = null
        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            notice = harness.viewModel.events.filterIsInstance<ChatEvent.Notice>().first().notice
        }
        harness.api.translateFailure = ApiError(status = 400, message = "Input translation is not configured on this hub")
        harness.viewModel.toggleTranslateInput()
        collector.join()
        assertEquals(listOf(IX_SESSION to true, IX_SESSION to false), harness.api.translateCalls.value)
        assertIs<ChatNotice.TranslateInputFailed>(notice)
        // A failed PATCH leaves the cached flag untouched.
        assertTrue(harness.sessionStore.currentDetail(IX_SESSION)?.metadata?.translateInput == true)
    }

    @Test
    fun `translate toggle follows the hub default until the session chooses`() = runTest {
        val harness = InteractionHarness(this)
        harness.api.featuresResult = FeaturesResponse(inputTranslation = InputTranslationFeature(available = true))
        harness.api.hubSettingsResult = app.hapi.protocol.wire.HubSettingsResponse(translateInputByDefault = true)
        harness.viewModel.start()

        // No explicit metadata.translateInput: the hub default turns it on.
        harness.viewModel.uiState.first { it.header.translateInput }

        val disabledDetail = detail().copy(metadata = detail().metadata!!.copy(translateInput = false))
        harness.sessionStore.detailToLoad = disabledDetail
        harness.viewModel.toggleTranslateInput()
        harness.api.translateCalls.first { it == listOf(IX_SESSION to false) }
        harness.viewModel.uiState.first { !it.header.translateInput }
    }

    @Test
    fun `translate toggle stays hidden when features are unavailable or fail`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()
        harness.viewModel.uiState.first { it.header.title.isNotEmpty() }
        assertFalse(harness.viewModel.inputTranslationAvailable.value)
    }

    // ------------------------------------------------------ slash commands --

    @Test
    fun `slash mode merges metadata names with the RPC list and filters while typing`() = runTest {
        val metadata = SessionMetadata(
            path = "/repo/app",
            host = "devbox",
            flavor = "claude",
            slashCommands = listOf("deploy", "compact"),
        )
        val harness = InteractionHarness(this, detail().copy(metadata = metadata))
        harness.api.slashCommandsResult = SlashCommandsResponse(
            success = true,
            commands = listOf(
                SlashCommand(name = "compact", description = "Compact the thread", source = "builtin"),
                SlashCommand(name = "code-review", description = null, source = "project"),
            ),
        )
        harness.viewModel.start()

        harness.viewModel.setComposerText("/")
        val all = harness.viewModel.slashSuggestions.first { it.size == 3 }
        // RPC "compact" overrides the bare metadata name and carries the description.
        assertEquals("Compact the thread", all.first { it.name == "compact" }.description)
        assertEquals(1, harness.api.slashCommandsCalls.value)

        harness.viewModel.setComposerText("/co")
        val filtered = harness.viewModel.slashSuggestions.first { it.size == 2 }
        assertEquals(listOf("compact", "code-review"), filtered.map { it.name })
        // Typing within slash mode must not refetch.
        assertEquals(1, harness.api.slashCommandsCalls.value)

        harness.viewModel.setComposerText("/co bar")
        harness.viewModel.slashSuggestions.first { it.isEmpty() }
    }

    @Test
    fun `skill picker loads on dollar and replaces the complete active word without sending`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val review = SkillSummary("review", "Review a change")
        harness.api.skillsResult = SkillsResponse(
            success = true,
            skills = listOf(SkillSummary("code-review"), SkillSummary("review-utils"), review),
        )
        vm.start()
        vm.setComposerText("cost\$review")
        testScheduler.runCurrent()
        assertTrue(harness.api.skillsCalls.isEmpty())

        vm.setComposerText("\$")
        testScheduler.runCurrent()
        assertEquals(3, vm.skillSuggestions.value.size)
        assertEquals(1, harness.api.skillsCalls.size)

        val text = "Run \$review-old please"
        val caret = "Run \$review".length
        vm.onComposerChange(text, caret, caret)
        testScheduler.runCurrent()
        assertEquals(listOf("review", "review-utils", "code-review"), vm.skillSuggestions.value.map { it.skill.name })
        assertEquals("Review a change", vm.skillSuggestions.value.first().skill.description)
        assertEquals(1, harness.api.skillsCalls.size)

        vm.selectSkillSuggestion(vm.skillSuggestions.value.first())
        testScheduler.runCurrent()
        assertEquals("Run \$review please", vm.composer.value.text)
        assertEquals("Run \$review ".length, vm.composer.value.caretPosition)
        assertTrue(vm.skillSuggestions.value.isEmpty())
        assertTrue(harness.api.sendCalls.value.isEmpty())
        assertTrue(vm.slashSuggestions.value.isEmpty())
        assertTrue(vm.mentionSuggestions.value.isEmpty())
    }

    @Test
    fun `skill picker deduplicates exact names but keeps case distinct skills selectable`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val lower = SkillSummary("review", "First match")
        val upper = SkillSummary("Review", "Different case")
        harness.api.skillsResult = SkillsResponse(
            success = true,
            skills = listOf(lower, SkillSummary("review", "Duplicate"), upper),
        )
        vm.start()

        for (skill in listOf(lower, upper)) {
            vm.setComposerText("Run \$rev")
            testScheduler.runCurrent()
            assertEquals(listOf(upper, lower), vm.skillSuggestions.value.map { it.skill })
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single { it.skill == skill })
            testScheduler.runCurrent()
            assertEquals("Run \$${skill.name} ", vm.composer.value.text)
        }
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    @Test
    fun `inserting a skill preserves surrounding full width punctuation and prose`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(SkillSummary("Review")))
        vm.start()

        for ((before, after) in listOf("请用 " to "，检查这段", "请用（" to "）检查这段", "请用 " to "。再检查")) {
            val draft = "$before\$rev$after"
            val caret = before.length + "\$rev".length
            vm.onComposerChange(draft, caret, caret)
            testScheduler.runCurrent()
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
            testScheduler.runCurrent()

            assertEquals("$before\$Review$after", vm.composer.value.text)
            assertEquals(before.length + "\$Review".length + 1, vm.composer.value.caretPosition)
            assertTrue(vm.skillSuggestions.value.isEmpty())
        }
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    @Test
    fun `inserting a skill preserves adjacent references and symbol separators`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(SkillSummary("review")))
        vm.start()

        for (separator in listOf("+", "", "💬")) {
            val caret = "Run \$rev".length
            vm.onComposerChange("Run \$rev$separator\$lint", caret, caret)
            testScheduler.runCurrent()
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
            testScheduler.runCurrent()

            assertEquals("Run \$review$separator\$lint", vm.composer.value.text)
            assertEquals("Run \$review$separator".length, vm.composer.value.caretPosition, "separator: '$separator'")
        }
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    @Test
    fun `a skill with plus signs stays open while typing and replaces its existing name`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val cpp = SkillSummary("c++")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(cpp))
        vm.start()

        for (query in listOf("c", "c+", "c++")) {
            val typed = "Run \$$query"
            vm.onComposerChange("$typed please", typed.length, typed.length)
            testScheduler.runCurrent()
            assertEquals(listOf(cpp), vm.skillSuggestions.value.map { it.skill })
            assertEquals(1, harness.api.skillsCalls.size)
        }

        val text = "Run \$c++ please"
        for (query in listOf("c", "c+", "c++")) {
            val caret = "Run \$$query".length
            vm.onComposerChange(text, caret, caret)
            testScheduler.runCurrent()
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
            testScheduler.runCurrent()
            assertEquals(text, vm.composer.value.text)
            assertEquals("Run \$c++ ".length, vm.composer.value.caretPosition)
        }
    }

    @Test
    fun `typing a hash in a skill name keeps the same picker open`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        vm.start()

        for ((index, name) in listOf("c#", "c#.lint", "c#:lint").withIndex()) {
            val skill = SkillSummary(name)
            harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(skill))
            for (length in 1..name.length) {
                val draft = "Run \$${name.take(length)}"
                vm.setComposerText(draft)
                testScheduler.runCurrent()
                assertEquals(listOf(skill), vm.skillSuggestions.value.map { it.skill }, draft)
                assertEquals(index + 1, harness.api.skillsCalls.size)
            }
            vm.setComposerText("")
            testScheduler.runCurrent()
        }
    }

    @Test
    fun `selecting a skill before its existing hash replaces the complete name`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val skills = listOf("c#", "c#.lint", "c#:lint").map { SkillSummary(it) }
        harness.api.skillsResult = SkillsResponse(success = true, skills = skills)
        vm.start()

        val caret = "Run \$c".length
        for (skill in skills) {
            val draft = "Run \$${skill.name}"
            vm.onComposerChange(draft, caret, caret)
            testScheduler.runCurrent()
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single { it.skill == skill })
            testScheduler.runCurrent()

            assertEquals("$draft ", vm.composer.value.text)
            assertEquals(draft.length + 1, vm.composer.value.caretPosition)
            assertTrue(vm.skillSuggestions.value.isEmpty())
        }
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    @Test
    fun `typing a qualifier after plus signs keeps the same picker open`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val qualified = SkillSummary("c++:lint")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(qualified))
        vm.start()

        for (query in listOf("c", "c+", "c++", "c++:", "c++:li")) {
            val typed = "Run \$$query"
            vm.onComposerChange("$typed please", typed.length, typed.length)
            testScheduler.runCurrent()
            assertEquals(listOf(qualified), vm.skillSuggestions.value.map { it.skill }, query)
            assertEquals(1, harness.api.skillsCalls.size)
        }
    }

    @Test
    fun `selecting a qualified skill replaces a suffix after plus signs but preserves prose`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val qualified = SkillSummary("c++:lint")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(qualified))
        vm.start()

        val caret = "Run \$c".length
        for ((suffix, expected) in listOf(
            "++:lint" to "Run \$c++:lint please",
            "++:li" to "Run \$c++:lint please",
            "++:continue" to "Run \$c++:lint:continue please",
        )) {
            vm.onComposerChange("Run \$c$suffix please", caret, caret)
            testScheduler.runCurrent()
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
            testScheduler.runCurrent()
            assertEquals(expected, vm.composer.value.text, suffix)
            assertEquals("Run \$c++:lint ".length, vm.composer.value.caretPosition)
            assertTrue(vm.skillSuggestions.value.isEmpty())
        }
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    @Test
    fun `typing a dot after plus signs keeps the same picker open`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val dotted = SkillSummary("c++.lint")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(dotted))
        vm.start()

        for (query in listOf("c", "c+", "c++", "c++.", "c++.li")) {
            val typed = "Run \$$query"
            vm.onComposerChange("$typed please", typed.length, typed.length)
            testScheduler.runCurrent()
            assertEquals(listOf(dotted), vm.skillSuggestions.value.map { it.skill }, query)
            assertEquals(1, harness.api.skillsCalls.size)
        }
    }

    @Test
    fun `selecting a dotted skill replaces a suffix after plus signs but preserves sentence punctuation`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val dotted = SkillSummary("c++.lint")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(dotted))
        vm.start()

        val caret = "Run \$c".length
        for ((suffix, expectedSuffix) in listOf(
            "++.lint please" to " please",
            "++.li please" to " please",
            "++. Then continue" to ". Then continue",
            "++.continue please" to ".continue please",
        )) {
            vm.onComposerChange("Run \$c$suffix", caret, caret)
            testScheduler.runCurrent()
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
            testScheduler.runCurrent()
            assertEquals("Run \$c++.lint$expectedSuffix", vm.composer.value.text, suffix)
            assertEquals("Run \$c++.lint ".length, vm.composer.value.caretPosition)
            assertTrue(vm.skillSuggestions.value.isEmpty())
        }
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    @Test
    fun `plus between references is preserved even if a skill name could include it`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val review = SkillSummary("review")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(review, SkillSummary("review+")))
        val text = "Run \$review+\$lint"
        val caret = "Run \$review".length
        vm.start()
        vm.onComposerChange(text, caret, caret)
        testScheduler.runCurrent()
        vm.selectSkillSuggestion(vm.skillSuggestions.value.single { it.skill == review })
        testScheduler.runCurrent()
        assertEquals(text, vm.composer.value.text)
        assertEquals(caret + 1, vm.composer.value.caretPosition)
    }

    @Test
    fun `an adjacent skill keeps trailing plus signs that belong to the selected name`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val cpp = SkillSummary("c++")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(cpp))
        vm.start()

        for ((suffix, caretAfter) in listOf("++" to "", "+++" to "+")) {
            val text = "Run \$c$suffix\$lint"
            for (query in listOf("c", "c+", "c++")) {
                vm.setComposerText("")
                val caret = "Run \$$query".length
                vm.onComposerChange(text, caret, caret)
                testScheduler.runCurrent()
                assertEquals(listOf(cpp), vm.skillSuggestions.value.map { it.skill }, "$suffix at $query")
                vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
                testScheduler.runCurrent()

                assertEquals(text, vm.composer.value.text, "$suffix at $query")
                assertEquals("Run \$c++$caretAfter".length, vm.composer.value.caretPosition)
            }
        }
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    @Test
    fun `switching away from a known skill replaces its trailing plus before another reference`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val cpp17 = SkillSummary("c++17")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(SkillSummary("c++"), cpp17))
        vm.start()

        for (query in listOf("c++", "c+", "c")) {
            val caret = "Run \$$query".length
            vm.onComposerChange("Run \$c++\$lint", caret, caret)
            testScheduler.runCurrent()
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single { it.skill == cpp17 })
            testScheduler.runCurrent()

            assertEquals("Run \$c++17\$lint", vm.composer.value.text, query)
            assertEquals("Run \$c++17".length, vm.composer.value.caretPosition)
        }
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    @Test
    fun `qualified Claude skills match past the colon and replace the existing qualified word`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val qualified = SkillSummary("url-plugin:url-skill")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(qualified, SkillSummary("review")))
        vm.start()

        vm.setComposerText("\$url-plugin:")
        testScheduler.runCurrent()
        assertEquals(listOf(qualified), vm.skillSuggestions.value.map { it.skill })
        vm.setComposerText("\$url-plugin:url-sk")
        testScheduler.runCurrent()
        assertEquals(listOf(qualified), vm.skillSuggestions.value.map { it.skill })
        vm.setComposerText("\$plugin:URL")
        testScheduler.runCurrent()
        assertEquals(listOf(qualified), vm.skillSuggestions.value.map { it.skill })
        assertEquals(1, harness.api.skillsCalls.size)

        for (suffix in listOf(" then continue", ".then continue")) {
            val draft = "Run \$plugin:URL$suffix"
            vm.setComposerText(draft)
            val beforeColon = "Run \$plugin".length
            vm.onComposerChange(draft, beforeColon, beforeColon)
            testScheduler.runCurrent()
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
            testScheduler.runCurrent()
            assertEquals("Run \$url-plugin:url-skill$suffix", vm.composer.value.text)
        }

        val prose = "Run \$rev:继续"
        val beforeProseColon = "Run \$rev".length
        vm.onComposerChange(prose, beforeProseColon, beforeProseColon)
        testScheduler.runCurrent()
        vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
        testScheduler.runCurrent()
        assertEquals("Run \$review:继续", vm.composer.value.text)
    }

    @Test
    fun `leading skill before punctuation is delimited for the wrappers without dropping prose`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(SkillSummary("review")))
        vm.start()

        for ((prefix, punctuation) in listOf("" to ", then check the diff", "  " to "，然后检查", "" to ": then check")) {
            val caret = "$prefix\$rev".length
            vm.onComposerChange("$prefix\$rev$punctuation", caret, caret)
            testScheduler.runCurrent()
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
            testScheduler.runCurrent()
            val completed = vm.composer.value
            assertEquals("$prefix\$review $punctuation", completed.text)
            val wrapperToken = Regex("""^\s*\$([^\s]+)(?=\s|$)""").find(completed.text)?.groupValues?.get(1)
            assertEquals("review", wrapperToken)
            assertEquals("$prefix\$review ".length, completed.caretPosition)
            assertTrue(vm.skillSuggestions.value.isEmpty())
        }
    }

    @Test
    fun `only the chosen skill can consume a matching punctuation suffix`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val review = SkillSummary("review")
        val qualified = SkillSummary("pre:continue")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(review, qualified))
        vm.start()

        val draft = "Run \$re:continue"
        val caret = "Run \$re".length
        for ((skill, completed) in listOf(review to "Run \$review:continue", qualified to "Run \$pre:continue ")) {
            vm.onComposerChange(draft, caret, caret)
            testScheduler.runCurrent()
            assertEquals(listOf(review, qualified), vm.skillSuggestions.value.map { it.skill })
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single { it.skill == skill })
            testScheduler.runCurrent()
            assertEquals(completed, vm.composer.value.text)
        }
    }

    @Test
    fun `completing a different skill replaces an existing exact qualified skill but not prose`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val replacement = SkillSummary("plugin:lint")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(SkillSummary("plugin:review"), replacement))
        vm.start()

        for (suffix in listOf(" please", ".then continue")) {
            val draft = "Run \$plugin:review$suffix"
            val caret = "Run \$plugin".length
            vm.onComposerChange(draft, caret, caret)
            testScheduler.runCurrent()
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single { it.skill == replacement })
            testScheduler.runCurrent()
            assertEquals("Run \$plugin:lint$suffix", vm.composer.value.text)
        }
    }

    @Test
    fun `a caret just after punctuation keeps prose but replaces a partial skill suffix`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val dotted = SkillSummary("review.lint")
        vm.start()

        val prefix = "Run \$review."
        for (skills in listOf(listOf(SkillSummary("review"), dotted), listOf(dotted))) {
            harness.api.skillsResult = SkillsResponse(success = true, skills = skills)
            for ((suffix, completed) in listOf(
                "then continue" to "Run \$review.lint.then continue",
                "li continue" to "Run \$review.lint continue",
                " continue" to "Run \$review.lint continue",
            )) {
                vm.onComposerChange(prefix + suffix, prefix.length, prefix.length)
                testScheduler.runCurrent()
                vm.selectSkillSuggestion(vm.skillSuggestions.value.single { it.skill == dotted })
                testScheduler.runCurrent()
                assertEquals(completed, vm.composer.value.text)
            }
        }
    }

    @Test
    fun `typing a dot or qualifier before existing text keeps the same skill picker open`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val dotted = SkillSummary("foo.bar")
        val qualified = SkillSummary("plugin:review")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(dotted, qualified))
        vm.start()

        for ((prefix, punctuation, next, skill) in listOf(
            listOf("foo", ".", "b", dotted.name),
            listOf("plugin", ":", "r", qualified.name),
        )) {
            val before = harness.api.skillsCalls.size
            for (term in listOf(prefix, prefix + punctuation, prefix + punctuation + next)) {
                val typed = "Run \$$term"
                vm.onComposerChange("$typed then continue", typed.length, typed.length)
                testScheduler.runCurrent()
                assertEquals(listOf(skill), vm.skillSuggestions.value.map { it.skill.name })
                assertEquals(before + 1, harness.api.skillsCalls.size)
            }
            vm.setComposerText("Run then continue")
            testScheduler.runCurrent()
        }
    }

    @Test
    fun `dotted skill name is one word at mid name and at word end`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val skill = SkillSummary("foo.bar")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(skill))
        vm.start()

        val draft = "Run \$foo.ba please"
        val caret = "Run \$foo".length
        vm.onComposerChange(draft, caret, caret)
        testScheduler.runCurrent()
        vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
        testScheduler.runCurrent()
        assertEquals("Run \$foo.bar please", vm.composer.value.text)
        assertEquals("Run \$foo.bar ".length, vm.composer.value.caretPosition)
        assertTrue(vm.skillSuggestions.value.isEmpty())

        vm.setComposerText("\$foo.bar")
        testScheduler.runCurrent()
        assertEquals(listOf(skill), vm.skillSuggestions.value.map { it.skill })
    }

    @Test
    fun `inserting before ASCII punctuation preserves it and does not add a space`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(SkillSummary("Review")))
        vm.start()

        for (suffix in listOf(", then run", ". Then run", ".then continue", "#notes")) {
            // Exact match exercises the caret-only path: the text should not change.
            val draft = "Run \$Review$suffix"
            val caret = "Run \$Review".length
            vm.onComposerChange(draft, caret, caret)
            testScheduler.runCurrent()
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
            testScheduler.runCurrent()

            assertEquals(draft, vm.composer.value.text)
            assertEquals(caret + 1, vm.composer.value.caretPosition)
            assertTrue(vm.composer.value.adoptCaret)
            assertTrue(vm.skillSuggestions.value.isEmpty())
        }
    }

    @Test
    fun `selecting a skill that ends in a dot or colon replaces the existing punctuation`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val plain = SkillSummary("review")
        val skills = listOf(SkillSummary("review."), SkillSummary("review:"))
        harness.api.skillsResult = SkillsResponse(success = true, skills = skills + plain)
        vm.start()

        val caret = "Run \$review".length
        for (skill in skills) {
            for (suffix in listOf(" please", "")) {
                val draft = "Run \$${skill.name}$suffix"
                vm.onComposerChange(draft, caret, caret)
                testScheduler.runCurrent()
                vm.selectSkillSuggestion(vm.skillSuggestions.value.single { it.skill == skill })
                testScheduler.runCurrent()
                assertEquals(if (suffix.isEmpty()) "$draft " else draft, vm.composer.value.text, draft)
                assertEquals(caret + 2, vm.composer.value.caretPosition)

                vm.onComposerChange(draft, caret, caret)
                testScheduler.runCurrent()
                vm.selectSkillSuggestion(vm.skillSuggestions.value.single { it.skill == plain })
                testScheduler.runCurrent()
                assertEquals(draft, vm.composer.value.text, "Preserve punctuation when selecting the shorter name")
            }
        }
        assertTrue(harness.api.sendCalls.value.isEmpty())
    }

    @Test
    fun `a sentence ending after the caret is not a partial skill suffix`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val skills = listOf(SkillSummary("review.lint"), SkillSummary("review:lint"))
        harness.api.skillsResult = SkillsResponse(success = true, skills = skills)
        vm.start()

        val caret = "Run \$review".length
        for (skill in skills) {
            val punctuation = skill.name["review".length]
            vm.onComposerChange("Run \$review$punctuation Then continue", caret, caret)
            testScheduler.runCurrent()
            vm.selectSkillSuggestion(vm.skillSuggestions.value.single { it.skill == skill })
            testScheduler.runCurrent()
            assertEquals("Run \$${skill.name}$punctuation Then continue", vm.composer.value.text)
        }
    }

    @Test
    fun `selecting before a period dismisses the menu even with a dotted completion`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val review = SkillSummary("review")
        val dotted = SkillSummary("review.lint")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(review, dotted))
        val text = "Run \$review. Then continue"
        val caret = "Run \$review".length
        vm.start()
        vm.onComposerChange(text, caret, caret)
        testScheduler.runCurrent()
        assertEquals(listOf(review, dotted), vm.skillSuggestions.value.map { it.skill })

        vm.selectSkillSuggestion(vm.skillSuggestions.value.first())
        testScheduler.runCurrent()
        assertEquals(text, vm.composer.value.text)
        assertEquals(caret + 1, vm.composer.value.caretPosition)
        assertTrue(vm.skillSuggestions.value.isEmpty())

        vm.onComposerChange(text, caret + 1, caret + 1) // no actual edit
        testScheduler.runCurrent()
        assertTrue(vm.skillSuggestions.value.isEmpty())

        vm.onComposerChange(text, caret, caret)
        testScheduler.runCurrent()
        assertEquals(listOf(review, dotted), vm.skillSuggestions.value.map { it.skill })
    }

    @Test
    fun `selecting an exact skill before a space moves the caret without changing the draft`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val review = SkillSummary("review")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(review))
        val text = "Run \$review please"
        val caret = "Run \$review".length
        vm.start()
        vm.onComposerChange(text, caret, caret)
        testScheduler.runCurrent()
        assertEquals(listOf(review), vm.skillSuggestions.value.map { it.skill })

        vm.selectSkillSuggestion(vm.skillSuggestions.value.first())
        testScheduler.runCurrent()
        assertEquals(text, vm.composer.value.text)
        assertEquals(caret + 1, vm.composer.value.caretPosition)
        assertTrue(vm.composer.value.adoptCaret)
        assertTrue(vm.skillSuggestions.value.isEmpty())
    }

    @Test
    fun `skill discovery failure clears the menu and retries only on a new opening`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        vm.start()
        vm.setComposerText("\$")
        testScheduler.runCurrent()
        assertTrue(vm.skillSuggestions.value.isEmpty())
        vm.setComposerText("\$re")
        testScheduler.runCurrent()
        assertEquals(1, harness.api.skillsCalls.size)

        vm.onComposerChange("\$re", 1, 3) // Selection, not a caret: closes the menu.
        testScheduler.runCurrent()
        val review = SkillSummary("review")
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(review))
        vm.onComposerChange("\$re", 3, 3)
        testScheduler.runCurrent()
        assertEquals(listOf(review), vm.skillSuggestions.value.map { it.skill })
        assertEquals(2, harness.api.skillsCalls.size)
    }

    @Test
    fun `closing the skill picker discards a late response`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val review = SkillSummary("review")
        val gate = CompletableDeferred<Unit>()
        harness.api.skillsGate = gate
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(review))
        vm.start()
        vm.setComposerText("\$re")
        testScheduler.runCurrent()
        assertEquals(1, harness.api.skillsCalls.size)
        vm.setComposerText("ordinary draft")
        testScheduler.runCurrent()
        gate.complete(Unit)
        testScheduler.runCurrent()
        assertEquals("ordinary draft", vm.composer.value.text)
        assertTrue(vm.skillSuggestions.value.isEmpty())
    }

    @Test
    fun `restoring a dollar draft opens the picker and typing does not refetch`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val review = SkillSummary("Review")
        harness.drafts.map[IX_SESSION] = "请用 \$rev"
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(review, SkillSummary("Run")))
        vm.start()
        testScheduler.runCurrent()
        assertEquals(listOf(review), vm.skillSuggestions.value.map { it.skill })
        vm.onComposerChange("请用 \$revi", "请用 \$revi".length, "请用 \$revi".length)
        testScheduler.runCurrent()
        assertEquals(listOf(review), vm.skillSuggestions.value.map { it.skill })
        assertEquals(listOf(IX_SESSION), harness.api.skillsCalls)
    }

    @Test
    fun `a transport failure can retry after leaving and reentering by moving only the caret`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val text = "\$rev\tplease"
        val caret = "\$rev".length
        harness.api.skillsFailure = java.io.IOException("offline")
        vm.start()
        vm.onComposerChange(text, caret, caret)
        testScheduler.runCurrent()
        assertEquals(1, harness.api.skillsCalls.size)
        assertTrue(vm.skillSuggestions.value.isEmpty())

        vm.onComposerChange(text, text.length, text.length)
        testScheduler.runCurrent()
        harness.api.skillsFailure = null
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(SkillSummary("Review")))
        vm.onComposerChange(text, caret, caret)
        testScheduler.runCurrent()
        assertEquals(2, harness.api.skillsCalls.size)
        vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
        testScheduler.runCurrent()
        assertEquals("\$Review\tplease", vm.composer.value.text)
        assertEquals("\$Review\t".length, vm.composer.value.caretPosition)
    }

    @Test
    fun `a stale row cannot insert into a second token or into a newly opened picker`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        val text = "\$rev \$rev"
        val firstCaret = "\$rev".length
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(SkillSummary("Review")))
        vm.start()
        vm.onComposerChange(text, firstCaret, firstCaret)
        testScheduler.runCurrent()
        val old = vm.skillSuggestions.value.single()

        vm.onComposerChange(text, text.length, text.length)
        // UI has not rendered the new suggestions yet.
        vm.selectSkillSuggestion(old)
        testScheduler.runCurrent()
        assertEquals(text, vm.composer.value.text)
        assertEquals(text.length, vm.composer.value.caretPosition)
        assertEquals(1, harness.api.skillsCalls.size)

        vm.onComposerChange(text, 0, text.length)
        testScheduler.runCurrent()
        assertTrue(vm.skillSuggestions.value.isEmpty())
        vm.onComposerChange(text, firstCaret, firstCaret)
        testScheduler.runCurrent()
        vm.selectSkillSuggestion(old)
        testScheduler.runCurrent()
        assertEquals(text, vm.composer.value.text)
        vm.selectSkillSuggestion(vm.skillSuggestions.value.single())
        testScheduler.runCurrent()
        assertEquals("\$Review \$rev", vm.composer.value.text)
    }

    @Test
    fun `a quick reopen of the same token invalidates its old catalogue and taps`() = runTest {
        val harness = InteractionHarness(this)
        val vm = harness.viewModel
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(SkillSummary("Review")))
        vm.start()
        vm.setComposerText("\$rev")
        testScheduler.runCurrent()
        val old = vm.skillSuggestions.value.single()

        // A selection close + reopen can be conflated into one emission downstream.
        vm.onComposerChange("\$rev", 0, 4)
        vm.onComposerChange("\$rev", 4, 4)
        vm.selectSkillSuggestion(old)
        testScheduler.runCurrent()
        assertEquals("\$rev", vm.composer.value.text)
        assertEquals(2, harness.api.skillsCalls.size)
        assertTrue(vm.skillSuggestions.value.single() !== old)
    }

    @Test
    fun `a successful skill insertion records the original name without blocking on preferences`() = runTest {
        val written = mutableListOf<String>()
        val recent = object : RecentSkills {
            override val names = MutableStateFlow(emptyList<String>())
            override suspend fun record(name: String) {
                written += name
                throw java.io.IOException("cannot persist")
            }
        }
        val harness = InteractionHarness(this, recentSkills = recent)
        val vm = harness.viewModel
        harness.api.skillsResult = SkillsResponse(success = true, skills = listOf(SkillSummary("Code-Review")))
        vm.start()
        vm.setComposerText("\$CODE")
        testScheduler.runCurrent()
        val row = vm.skillSuggestions.value.single()
        vm.selectSkillSuggestion(row)
        vm.selectSkillSuggestion(row) // Duplicate tap must not record two writes.
        testScheduler.runCurrent()
        assertEquals("\$Code-Review ", vm.composer.value.text)
        assertEquals(listOf("Code-Review"), written)
    }

    @Test
    fun `selecting a command inserts the slash token ready for arguments`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()

        harness.viewModel.selectSlashCommand(SlashCommand(name = "compact", source = "builtin"))

        harness.viewModel.composer.first { it.text == "/compact " }
    }

    @Test
    fun `RPC failure still serves the metadata names`() = runTest {
        val metadata = SessionMetadata(
            path = "/repo/app",
            host = "devbox",
            flavor = "claude",
            slashCommands = listOf("deploy"),
        )
        val harness = InteractionHarness(this, detail().copy(metadata = metadata))
        harness.api.slashCommandsResult = SlashCommandsResponse(success = false, error = "cli wedged")
        harness.viewModel.start()

        harness.viewModel.setComposerText("/")
        val suggestions = harness.viewModel.slashSuggestions.first { it.isNotEmpty() }
        assertEquals(listOf("deploy"), suggestions.map { it.name })
    }

    // ------------------------------------------------------------- mentions --

    private fun peerSummary(
        id: String,
        name: String? = "Peer chat",
        hasContent: Boolean = true,
    ): SessionSummary = SessionSummary(
        id = id,
        active = false,
        updatedAt = 200,
        hasConversationContent = hasContent,
        metadata = name?.let {
            SessionSummaryMetadata(path = "/work/peer", name = it)
        },
    )

    @Test
    fun `at-query merges session rows ahead of file hits and searches files once`() = runTest {
        val harness = InteractionHarness(this, detail(flavor = "codex"))
        harness.sessionStore.summaries.value = listOf(
            peerSummary("sess-peer-01"),
            // Current session and empty stubs are never mentionable.
            peerSummary(IX_SESSION, name = "this chat"),
            peerSummary("sess-husk", name = "Husk", hasContent = false),
        )
        harness.api.fileSearchResult = FileSearchResponse(
            success = true,
            files = listOf(
                FileSearchItem(fileName = "notes.md", filePath = "docs", fullPath = "docs/notes.md", fileType = "file"),
            ),
        )
        harness.viewModel.start()

        harness.viewModel.setComposerText("check @peer")
        val suggestions = harness.viewModel.mentionSuggestions.first { it.size == 2 }

        // Sessions first (web `[...sessionHits, ...fileHits]`), husk/current excluded.
        assertEquals("session:sess-peer-01", suggestions[0].key)
        assertEquals("@Peer chat", suggestions[0].label)
        assertEquals("@\"docs/notes.md\"", suggestions[1].key)
        assertEquals("@notes.md", suggestions[1].label)
        assertEquals(listOf(Triple(IX_SESSION, "peer", 50)), harness.api.fileSearchCalls.value)

        // Retyping the query refires the file RPC once per distinct query.
        harness.viewModel.setComposerText("check @Peer")
        harness.api.fileSearchCalls.first { it.size == 2 }
        assertEquals(
            listOf(Triple(IX_SESSION, "peer", 50), Triple(IX_SESSION, "Peer", 50)),
            harness.api.fileSearchCalls.value,
        )
        harness.viewModel.mentionSuggestions.first { rows -> rows.size == 2 && rows[0].label == "@Peer chat" }
    }

    @Test
    fun `file mentions fire only for codex and copilot flavors`() = runTest {
        val harness = InteractionHarness(this, detail(flavor = "claude"))
        harness.sessionStore.summaries.value = listOf(peerSummary("sess-peer-01"))
        harness.viewModel.start()

        harness.viewModel.setComposerText("@peer")
        val suggestions = harness.viewModel.mentionSuggestions.first { it.isNotEmpty() }

        assertEquals(listOf("session:sess-peer-01"), suggestions.map { it.key })
        testScheduler.advanceUntilIdle()
        assertEquals(emptyList(), harness.api.fileSearchCalls.value)
    }

    @Test
    fun `file RPC failure degrades silently to session-only rows`() = runTest {
        val harness = InteractionHarness(this, detail(flavor = "copilot"))
        harness.sessionStore.summaries.value = listOf(peerSummary("sess-peer-01"))
        harness.api.fileSearchFailure = RuntimeException("hub says no")
        harness.viewModel.start()

        harness.viewModel.setComposerText("@peer")
        val suggestions = harness.viewModel.mentionSuggestions.first { it.isNotEmpty() }

        assertEquals(listOf("session:sess-peer-01"), suggestions.map { it.key })
        assertEquals(listOf(Triple(IX_SESSION, "peer", 50)), harness.api.fileSearchCalls.value)
    }

    @Test
    fun `selecting a mention replaces the word and closes the dropdown`() = runTest {
        val harness = InteractionHarness(this, detail(flavor = "claude"))
        harness.sessionStore.summaries.value = listOf(peerSummary("sess-peer-01"))
        harness.viewModel.start()

        harness.viewModel.setComposerText("check @peer")
        val row = harness.viewModel.mentionSuggestions.first { it.isNotEmpty() }.single()

        harness.viewModel.selectMentionSuggestion(row)

        val expected = "check " + row.insertText + " "
        harness.viewModel.composer.first { it.text == expected }
        harness.viewModel.mentionSuggestions.first { it.isEmpty() }
    }

    @Test
    fun `mid-word prefix never queries or fires the file RPC`() = runTest {
        val harness = InteractionHarness(this, detail(flavor = "codex"))
        harness.sessionStore.summaries.value = listOf(peerSummary("sess-peer-01"))
        harness.viewModel.start()

        harness.viewModel.setComposerText("foo@peer")
        testScheduler.advanceUntilIdle()

        assertEquals(emptyList(), harness.viewModel.mentionSuggestions.value)
        assertEquals(emptyList(), harness.api.fileSearchCalls.value)
    }

    @Test
    fun `mention detection follows the caret instead of the text tail`() = runTest {
        val harness = InteractionHarness(this, detail(flavor = "codex"))
        harness.sessionStore.summaries.value = listOf(peerSummary("sess-peer-01"))
        harness.viewModel.start()

        // Draft whose tail is plain text — tail-only detection would miss it.
        harness.viewModel.onComposerChange("a @peer b", 7, 7) // caret right after "@peer"
        val rows = harness.viewModel.mentionSuggestions.first { it.isNotEmpty() }
        assertEquals(listOf("session:sess-peer-01"), rows.map { it.key })

        // Caret moves inside the word keep the same query (no refire)…
        harness.viewModel.onComposerChange("a @peer b", 5, 5)
        // …stepping off it (the space before '@') closes the dropdown…
        harness.viewModel.onComposerChange("a @peer b", 2, 2)
        harness.viewModel.mentionSuggestions.first { it.isEmpty() }
        // …and a selected range suppresses detection entirely (web rule).
        harness.viewModel.onComposerChange("a @peer b", 3, 8)
        harness.viewModel.mentionSuggestions.first { it.isEmpty() }
        testScheduler.advanceUntilIdle()
        // One caret-anchored query only — caret moves inside the word do not refire.
        assertEquals(listOf(Triple(IX_SESSION, "peer", 50)), harness.api.fileSearchCalls.value)
    }

    @Test
    fun `selecting a mention mid-draft swaps that word and rests the caret after it`() = runTest {
        val harness = InteractionHarness(this, detail(flavor = "claude"))
        harness.sessionStore.summaries.value = listOf(peerSummary("sess-peer-01"))
        harness.viewModel.start()

        harness.viewModel.onComposerChange("a @peer b", 7, 7)
        val row = harness.viewModel.mentionSuggestions.first { it.isNotEmpty() }.single()

        harness.viewModel.selectMentionSuggestion(row)

        val expected = "a " + row.insertText + " b"
        val state = harness.viewModel.composer.first { it.text == expected }
        // Caret rests right after the inserted prose — before the pre-existing
        // space, not teleported to the draft tail.
        assertEquals(expected.length - 2, state.caretPosition)
        harness.viewModel.mentionSuggestions.first { it.isEmpty() }
    }

    @Test
    fun `query change drops the previous query's file rows before the new RPC settles`() = runTest {
        val harness = InteractionHarness(this, detail(flavor = "codex"))
        harness.sessionStore.summaries.value = listOf(peerSummary("sess-peer-01"))
        harness.api.fileSearchResult = FileSearchResponse(
            success = true,
            files = listOf(
                FileSearchItem(fileName = "notes.md", filePath = "docs", fullPath = "docs/notes.md", fileType = "file"),
            ),
        )
        harness.viewModel.start()

        harness.viewModel.setComposerText("@peer")
        harness.viewModel.mentionSuggestions.first { it.size == 2 }

        // Retype with the next file RPC held in flight: the previous query's
        // file row must vanish immediately (session-only interim state), and
        // the new file row only lands once the RPC settles.
        val gate = CompletableDeferred<Unit>()
        harness.api.fileSearchGate = gate
        harness.viewModel.setComposerText("@Peer")
        val interim = harness.viewModel.mentionSuggestions.first { rows ->
            rows.isNotEmpty() && rows.none { it.key == "@\"docs/notes.md\"" }
        }
        assertEquals(listOf("session:sess-peer-01"), interim.map { it.key })

        gate.complete(Unit)
        harness.viewModel.mentionSuggestions.first { rows -> rows.size == 2 && rows[1].key == "@\"docs/notes.md\"" }
        assertEquals(
            listOf(Triple(IX_SESSION, "peer", 50), Triple(IX_SESSION, "Peer", 50)),
            harness.api.fileSearchCalls.value,
        )
    }

    // ------------------------------------------------------------ dictation --

    @Test
    fun `dictated text appends to the composer with a space separator`() = runTest {
        val harness = InteractionHarness(this)
        harness.viewModel.start()

        harness.viewModel.setComposerText("fix the bug")
        harness.viewModel.appendDictatedText(" and add tests ")

        harness.viewModel.composer.first { it.text == "fix the bug and add tests" }
    }

    // ---------------------------------------------------------- scratchlist --

    @Test
    fun `park moves the draft to the scratchlist and clears the composer`() = runTest {
        val scratch = FakeScratchlist()
        val harness = InteractionHarness(this, scratchlist = scratch)

        harness.viewModel.setComposerText("try the cursor approach instead")
        harness.viewModel.composer.first { it.text.isNotEmpty() }
        harness.viewModel.parkComposerDraft()

        harness.viewModel.composer.first { it.text.isEmpty() }
        assertEquals(listOf(IX_SESSION to "try the cursor approach instead"), scratch.created)
    }

    @Test
    fun `park at the cap keeps the draft and notifies`() = runTest {
        val scratch = FakeScratchlist().apply { createResult = { ScratchlistCreateResult.AtCap } }
        val harness = InteractionHarness(this, scratchlist = scratch)
        val notice = backgroundScope.async(start = CoroutineStart.UNDISPATCHED) {
            harness.viewModel.events.filterIsInstance<ChatEvent.Notice>().first()
        }

        harness.viewModel.setComposerText("do not lose me")
        harness.viewModel.composer.first { it.text.isNotEmpty() }
        harness.viewModel.parkComposerDraft()

        assertEquals(ChatNotice.ScratchlistFull, notice.await().notice)
        assertEquals("do not lose me", harness.viewModel.composer.value.text)
    }

    @Test
    fun `insertComposerText sets an empty composer and appends on a new line otherwise`() = runTest {
        val harness = InteractionHarness(this, scratchlist = FakeScratchlist())

        harness.viewModel.insertComposerText("first note")
        harness.viewModel.composer.first { it.text == "first note" }

        harness.viewModel.insertComposerText("second note")
        harness.viewModel.composer.first { it.text == "first note\nsecond note" }
    }

    @Test
    fun `scratchlist entry count feeds the top-bar badge`() = runTest {
        val scratch = FakeScratchlist()
        val harness = InteractionHarness(this, scratchlist = scratch)

        scratch.sessionState.value = ScratchlistSessionState(
            entries = listOf(
                app.hapi.protocol.wire.ScratchlistEntry("e1", "one", 1, 1),
                app.hapi.protocol.wire.ScratchlistEntry("e2", "two", 2, 2),
            ),
            loaded = true,
        )

        harness.viewModel.scratchlistCount.first { it == 2 }
    }
}
