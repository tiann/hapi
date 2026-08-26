package app.hapi.companion.feature.chat

import app.hapi.companion.feature.chat.attachments.ComposerAttachmentStatus
import app.hapi.companion.feature.chat.attachments.PreparedAttachment
import app.hapi.companion.feature.chat.composer.ChatDrafts
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
import app.hapi.data.store.ScratchlistAttachmentDeleteResult
import app.hapi.data.store.ScratchlistCreateResult
import app.hapi.data.store.ScratchlistSessionState
import app.hapi.data.store.ScratchlistUploadResult
import app.hapi.data.store.SessionDetailStore
import app.hapi.data.store.SessionScratchlist
import app.hapi.data.store.StoreSyncTargets
import app.hapi.protocol.catalog.PermissionMode
import app.hapi.protocol.window.MessageStatus
import app.hapi.protocol.wire.AgentState
import app.hapi.protocol.wire.AgentStateRequest
import app.hapi.protocol.wire.ApprovePermissionRequest
import app.hapi.protocol.wire.CancelMessageResponse
import app.hapi.protocol.chat.NormalizedMessage
import app.hapi.protocol.chat.normalizeDecryptedMessage
import app.hapi.protocol.wire.CodexModelsResponse
import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.DeleteUploadResponse
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
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SlashCommand
import app.hapi.protocol.wire.SlashCommandsResponse
import app.hapi.protocol.wire.SteerQueuedMessageResponse
import app.hapi.protocol.wire.SyncEvent
import app.hapi.protocol.wire.UploadFileResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
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
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

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

    override suspend fun sendMessage(sessionId: String, message: SendMessageRequest) {
        sendCalls.value = sendCalls.value + (sessionId to message)
        sendFailures.removeFirstOrNull()?.let { throw it }
    }

    override suspend fun cancelMessage(sessionId: String, messageId: String): CancelMessageResponse {
        cancelCalls.value = cancelCalls.value + messageId
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
    override suspend fun load(sessionId: String): String? = map[sessionId]
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
) {
    val api = RecordingChatApi()
    val scope = testScope.backgroundScope
    val sessionStore = InteractionSessionStore().apply {
        detailToLoad = detail
        setDetail(detail)
    }
    val drafts = FakeDrafts()
    val messageWindows = MessageWindowStores(api = api, scope = scope)
    val engine = SseEngine(
        baseUrl = "http://hub.test",
        transport = okTransport(),
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
        pipelineDispatcher = StandardTestDispatcher(testScope.testScheduler),
        draftSaveDebounceMs = 10,
        now = { 1_000L },
        localIdGenerator = { "local-${++localIdCounter}" },
    )

    suspend fun window() = messageWindows.open(IX_SESSION)
}

// ------------------------------------------------------------------ tests --

class ChatViewModelInteractionTest {

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
    private fun queuedServerRow(id: String, localId: String, text: String): DecryptedMessage =
        DecryptedMessage(
            id = id,
            seq = 7,
            localId = localId,
            createdAt = 500,
            invokedAt = OptionalField.Present(null),
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
