package app.hapi.data.store

import app.hapi.data.api.MessagesApi
import app.hapi.data.api.MessagesQuery
import app.hapi.protocol.window.MessagePosition
import app.hapi.protocol.window.MessageStatus
import app.hapi.protocol.window.MessageViewMode
import app.hapi.protocol.window.MessageWindowLogic
import app.hapi.protocol.window.MessageWindowState
import app.hapi.protocol.window.OlderLoadOutcome
import app.hapi.protocol.window.PAGE_SIZE
import app.hapi.protocol.window.WindowMessage
import app.hapi.protocol.window.asWindowMessage
import app.hapi.protocol.window.buildOptimisticMessage
import app.hapi.protocol.wire.AttachmentMetadata
import app.hapi.protocol.wire.MessagesResponse
import app.hapi.protocol.wire.SyncEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** What the chat screen renders — mirror of the web `useMessages` return shape. */
data class MessageWindowUiState(
    val messages: List<WindowMessage>,
    val hasMore: Boolean,
    val isSyncingTail: Boolean,
    val isLoadingMore: Boolean,
    val warning: String?,
    val viewMode: MessageViewMode,
    val messagesVersion: Long,
    val historyVersion: Long,
    val tailRevision: Long,
)

/**
 * Per-session message window orchestration — the async half of the web
 * reference `web/src/lib/message-window-store.ts`, driving the pure
 * transitions in `MessageWindowLogic` over a [StateFlow].
 *
 * Concurrency model: the web store is single-threaded JS whose interleaving
 * points are its `await`s; here every synchronous read-modify-write segment
 * between transport calls runs under [stateMutex], and the generation
 * counters + request-baseline identity checks (ported as-is) handle whatever
 * interleaves across the api calls — which are deliberately made **outside**
 * the lock. Tail syncs are single-flight per session with an optional
 * trailing re-run, exactly like the web `TailSyncController`.
 */
class MessageWindowStore(
    val sessionId: String,
    private val api: MessagesApi,
    private val scope: CoroutineScope,
    private val snapshots: WindowSnapshots? = null,
    initialState: MessageWindowState? = null,
) {
    private val stateMutex = Mutex()
    private val _state = MutableStateFlow(initialState ?: MessageWindowLogic.createState(sessionId))

    /** The full window state (UI projects what it needs; see [uiState]). */
    val state: StateFlow<MessageWindowState> = _state.asStateFlow()

    /**
     * UI-facing projection — the fields the web `useMessages` hook returns;
     * cursor/generation internals stay off the render path.
     */
    val uiState: Flow<MessageWindowUiState> = state
        .map { current ->
            MessageWindowUiState(
                messages = current.messages,
                hasMore = current.hasMore,
                isSyncingTail = current.isSyncingTail,
                isLoadingMore = current.isLoadingMore,
                warning = current.warning,
                viewMode = current.viewMode,
                messagesVersion = current.messagesVersion,
                historyVersion = current.historyVersion,
                tailRevision = current.tailRevision,
            )
        }
        .distinctUntilChanged()

    // ------------------------------------------------------- tail controller --

    private val controllerLock = Any()
    private var running: TailRun? = null
    private var trailingRequested = false

    /** Bumped by [clear]/[seedFrom] so a finished run stops chaining trailing runs. */
    private var controllerEpoch = 0

    private class TailRun(val prefersLatest: Boolean) {
        lateinit var job: Deferred<Unit>
    }

    private sealed interface SyncDecision {
        data class Await(val job: Deferred<Unit>) : SyncDecision
        data class Drain(val observed: Deferred<Unit>) : SyncDecision
    }

    /**
     * Run (or join) a tail sync (web `syncTailMessages`). With
     * [ensureAfterCurrent] the call drains: if a run is already in flight, a
     * trailing run is requested and awaited, so the caller returns only after
     * a sync that STARTED at or after this call.
     */
    suspend fun syncTail(ensureAfterCurrent: Boolean = false) {
        val decision: SyncDecision = synchronized(controllerLock) {
            val current = running
            when {
                current == null -> SyncDecision.Await(startTailSyncLocked())
                _state.value.preferLatestOnActivation ->
                    if (current.prefersLatest) {
                        SyncDecision.Await(current.job)
                    } else {
                        trailingRequested = false
                        SyncDecision.Await(startTailSyncLocked())
                    }
                !ensureAfterCurrent -> SyncDecision.Await(current.job)
                else -> {
                    trailingRequested = true
                    SyncDecision.Drain(current.job)
                }
            }
        }
        when (decision) {
            is SyncDecision.Await -> decision.job.join()
            is SyncDecision.Drain -> drainTailSync(decision.observed)
        }
    }

    private fun startTailSyncLocked(): Deferred<Unit> {
        val epoch = controllerEpoch
        val run = TailRun(prefersLatest = _state.value.preferLatestOnActivation)
        // UNDISPATCHED mirrors the web: `runTailSync` executes to its first true
        // suspension (normally the api call) before `startTailSync` returns, so
        // `beginTailSync`'s generation bump lands synchronously and an in-flight
        // run it replaces cannot commit another page in between.
        run.job = scope.async(start = CoroutineStart.UNDISPATCHED) { runTailSync() }
        running = run
        run.job.invokeOnCompletion {
            synchronized(controllerLock) {
                if (controllerEpoch != epoch || running !== run) return@invokeOnCompletion
                running = null
                if (!trailingRequested) return@invokeOnCompletion
                trailingRequested = false
                startTailSyncLocked()
            }
        }
        return run.job
    }

    /** Web `waitForTailSyncDrain`: follow the chain until no newer run exists. */
    private suspend fun drainTailSync(observed: Deferred<Unit>) {
        val epoch = synchronized(controllerLock) { controllerEpoch }
        var current: Deferred<Unit>? = observed
        while (current != null) {
            current.join()
            current = synchronized(controllerLock) {
                if (controllerEpoch != epoch) return
                val next = running?.job
                if (next != null && next !== current) next else null
            }
        }
    }

    private fun isCurrentTailSync(generation: Long): Boolean =
        _state.value.syncGeneration == generation

    private suspend fun runTailSync() {
        val generation = update { MessageWindowLogic.beginTailSync(it) }.syncGeneration
        try {
            val initial = _state.value
            val initialCursor = initial.newestPosition
            val preferLatestOnActivation = initial.preferLatestOnActivation
            val canIncrement = initialCursor != null
                && initial.epoch != null
                && !initial.requiresLatestReset
                && !preferLatestOnActivation

            if (!canIncrement) {
                val requestBaseline = baseline()
                val response = api.getMessages(sessionId, MessagesQuery.Latest(limit = PAGE_SIZE))
                if (!isCurrentTailSync(generation)) return
                update { previous ->
                    if (previous.syncGeneration != generation) return@update previous
                    MessageWindowLogic.applyLatestResponse(
                        previous,
                        response.windowMessages(),
                        response.page,
                        replaceServerRows = initial.requiresLatestReset
                            || preferLatestOnActivation
                            || response.page.reset,
                        requestBaseline = requestBaseline,
                    ).copy(preferLatestOnActivation = false)
                }
                finishTailSync(generation, warning = null)
                return
            }

            var after: MessagePosition = initialCursor!!
            var until: MessagePosition? = null
            while (true) {
                val requestBaseline = baseline()
                val response = api.getMessages(
                    sessionId,
                    MessagesQuery.After(
                        afterAt = after.at,
                        afterSeq = after.seq,
                        untilAt = until?.at,
                        untilSeq = until?.seq,
                        epoch = initial.epoch!!,
                        limit = PAGE_SIZE,
                    ),
                )
                if (!isCurrentTailSync(generation)) return

                if (response.page.reset || response.page.direction == "latest") {
                    update { previous ->
                        if (previous.syncGeneration != generation) return@update previous
                        MessageWindowLogic.applyLatestResponse(
                            previous,
                            response.windowMessages(),
                            response.page,
                            replaceServerRows = true,
                            requestBaseline = requestBaseline,
                        )
                    }
                    break
                }

                val nextAfter = MessageWindowLogic.pagePosition(response.page.nextAfterAt, response.page.nextAfterSeq)
                val snapshotHead =
                    MessageWindowLogic.pagePosition(response.page.snapshotHeadAt, response.page.snapshotHeadSeq)
                if (until == null) {
                    until = snapshotHead
                }

                update { previous ->
                    if (previous.syncGeneration != generation) return@update previous
                    MessageWindowLogic.applyAfterPage(previous, response.windowMessages(), response.page, nextAfter)
                }

                val current = _state.value
                if (
                    current.requiresLatestReset
                    || current.preferLatestOnActivation
                    || !response.page.hasMore
                    || nextAfter == null
                ) {
                    break
                }
                if (nextAfter <= after) {
                    throw IllegalStateException("Message tail cursor did not advance")
                }
                after = nextAfter
            }

            finishTailSync(generation, warning = null)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            if (!isCurrentTailSync(generation)) return
            finishTailSync(generation, error.message ?: "Failed to synchronize messages")
        }
    }

    private suspend fun finishTailSync(generation: Long, warning: String?) {
        update { MessageWindowLogic.finishTailSync(it, generation, warning) }
        persist()
    }

    // ---------------------------------------------------------- older pages --

    /**
     * Load one older page (web `fetchOlderMessages`). On an epoch mismatch
     * the window is invalidated and a full tail sync (`ensureAfterCurrent`)
     * runs before the `stopped/epoch-reset` outcome is returned.
     * [onBeforeApply] runs while the state lock is held (mirror of the web's
     * synchronous updater) — it must not call back into this store.
     */
    suspend fun fetchOlder(onBeforeApply: ((Long) -> Boolean)? = null): OlderLoadOutcome {
        val initial = _state.value
        when (val precheck = MessageWindowLogic.olderLoadPrecheck(initial)) {
            is MessageWindowLogic.OlderPrecheck.Stop -> return OlderLoadOutcome.Stopped(precheck.reason)
            is MessageWindowLogic.OlderPrecheck.Proceed -> {
                val before = precheck.before
                val generation = initial.olderGeneration + 1
                update { MessageWindowLogic.beginOlderLoad(it, generation) }
                return try {
                    val response = api.getMessages(
                        sessionId,
                        MessagesQuery.Before(beforeAt = before.at, beforeSeq = before.seq, limit = PAGE_SIZE),
                    )
                    if (_state.value.olderGeneration != generation) {
                        return OlderLoadOutcome.Stopped(OlderLoadOutcome.StopReason.Invalidated)
                    }

                    if (initial.epoch != null && response.page.epoch != initial.epoch) {
                        update { MessageWindowLogic.applyOlderEpochMismatch(it, generation) }
                        syncTail(ensureAfterCurrent = true)
                        return OlderLoadOutcome.Stopped(OlderLoadOutcome.StopReason.EpochReset)
                    }

                    var historyVersion = 0L
                    var addedRenderableCount = 0
                    var applyRejected = false
                    update { previous ->
                        if (previous.olderGeneration != generation) return@update previous
                        val incoming = response.windowMessages()
                        addedRenderableCount = MessageWindowLogic.countNewRenderableMessages(previous, incoming)
                        val nextHistoryVersion = previous.historyVersion + 1
                        if (onBeforeApply != null && !onBeforeApply(nextHistoryVersion)) {
                            applyRejected = true
                            return@update MessageWindowLogic.rejectOlderApply(previous)
                        }
                        historyVersion = nextHistoryVersion
                        MessageWindowLogic.applyOlderResponse(previous, incoming, response.page, nextHistoryVersion)
                    }
                    if (applyRejected || historyVersion == 0L) {
                        return OlderLoadOutcome.Stopped(OlderLoadOutcome.StopReason.Invalidated)
                    }
                    persist()
                    OlderLoadOutcome.Applied(
                        historyVersion = historyVersion,
                        hasMore = response.page.hasMore,
                        addedRenderableCount = addedRenderableCount,
                    )
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Throwable) {
                    if (_state.value.olderGeneration != generation) {
                        return OlderLoadOutcome.Stopped(OlderLoadOutcome.StopReason.Invalidated)
                    }
                    update {
                        MessageWindowLogic.failOlderLoad(
                            it,
                            generation,
                            error.message ?: "Failed to load older messages",
                        )
                    }
                    OlderLoadOutcome.Failed(error)
                }
            }
        }
    }

    suspend fun cancelOlderLoad() {
        update { MessageWindowLogic.cancelOlderLoad(it) }
    }

    // ----------------------------------------------------------- SSE ingest --

    /**
     * Route one message-stream SSE event into this window (the
     * `SyncTargets.onMessageEvent` hook). `messages-invalidated` clears the
     * window and starts a fresh tail sync; `scheduled-matured` re-syncs so
     * the released row (and its consumption) lands even if the
     * `message-received` frame was missed.
     */
    suspend fun onMessageEvent(event: SyncEvent) {
        when (event) {
            is SyncEvent.MessageReceived -> ingestSseMessages(listOf(event.message.asWindowMessage()))
            is SyncEvent.MessagesConsumed -> markConsumed(event.localIds, event.invokedAt)
            is SyncEvent.MessagesIndeterminate -> markIndeterminate(event.localIds)
            is SyncEvent.MessagesRequeued -> markRequeued(event.localIds)
            is SyncEvent.MessageCancelled -> removeMessage(event.messageId)
            is SyncEvent.MessagesInvalidated -> {
                clear()
                scope.launch { syncTail() }
            }
            is SyncEvent.ScheduledMatured -> scope.launch { syncTail(ensureAfterCurrent = true) }
            else -> Unit
        }
    }

    /** SSE `message-received` ingest (web `ingestIncomingMessages`). */
    suspend fun ingestSseMessages(messages: List<WindowMessage>) {
        if (messages.isEmpty()) return
        update { MessageWindowLogic.ingestIncoming(it, messages) }
        persist()
    }

    /** SSE `messages-consumed` (web `markMessagesConsumed`). */
    suspend fun markConsumed(localIds: List<String>, invokedAt: Long) {
        if (localIds.isEmpty()) return
        update { MessageWindowLogic.markConsumed(it, localIds, invokedAt) }
        persist()
    }

    suspend fun markIndeterminate(localIds: List<String>) {
        update { MessageWindowLogic.markIndeterminate(it, localIds) }
        persist()
    }

    suspend fun markRequeued(localIds: List<String>) {
        update { MessageWindowLogic.markRequeued(it, localIds) }
        persist()
    }

    /** SSE `message-cancelled` / optimistic DELETE removal (web `removeOptimisticMessage`). */
    suspend fun removeMessage(localIdOrId: String) {
        update { MessageWindowLogic.removeByLocalIdOrId(it, localIdOrId) }
        persist()
    }

    // ------------------------------------------------------ optimistic sends --

    /** Append a pre-built optimistic row (web `appendOptimisticMessage`). */
    suspend fun appendOptimistic(message: WindowMessage) {
        update { MessageWindowLogic.appendOptimistic(it, message) }
        persist()
    }

    /**
     * Append the standard optimistic row for a send
     * (`useSendMessage.createOptimisticMessage`): status `sending` until the
     * POST settles, then [updateStatus] to `queued`/`sent`/`failed`.
     */
    suspend fun appendOptimistic(
        localId: String,
        text: String,
        attachments: List<AttachmentMetadata>? = null,
        scheduledAt: Long? = null,
        deliveryMode: String = "queue",
        createdAt: Long = System.currentTimeMillis(),
    ) {
        appendOptimistic(
            buildOptimisticMessage(
                localId = localId,
                text = text,
                createdAt = createdAt,
                attachments = attachments,
                scheduledAt = scheduledAt,
                deliveryMode = deliveryMode,
                status = MessageStatus.Sending,
            ),
        )
    }

    suspend fun updateStatus(localId: String, status: MessageStatus) {
        update { MessageWindowLogic.updateStatus(it, localId, status) }
        persist()
    }

    /**
     * A cancel DELETE answered `{"status":"invoked"}` — too late, the agent
     * consumed the row. Remove the queued snapshot and ingest the returned
     * authoritative row as `sent` (web `useCancelQueuedMessage`).
     */
    suspend fun applyCancelInvoked(localId: String, message: WindowMessage) {
        removeMessage(localId)
        appendOptimistic(message.copy(status = MessageStatus.Sent))
    }

    // ------------------------------------------------- queued reconciliation --

    fun queuedReconcileCandidateLocalIds(): List<String> =
        MessageWindowLogic.queuedReconcileCandidateLocalIds(_state.value)

    suspend fun reconcileQueuedLocalIds(candidateLocalIds: List<String>, queuedLocalIds: List<String>) {
        update { MessageWindowLogic.reconcileQueuedLocalIds(it, candidateLocalIds, queuedLocalIds) }
        persist()
    }

    /**
     * Queued-state recovery after a `resume: 'gap'` reconnect (port of
     * `web/src/lib/queued-state-reconciliation.ts`): tail-sync to the drain,
     * collect candidates, ask the hub for the verdict in ≤1000-id batches,
     * stamp invoked rows like `messages-consumed`, drop deleted candidates.
     */
    suspend fun reconcileQueuedState() {
        syncTail(ensureAfterCurrent = true)
        val candidateLocalIds = queuedReconcileCandidateLocalIds()
        if (candidateLocalIds.isEmpty()) return
        val queuedLocalIds = mutableListOf<String>()
        val indeterminateLocalIds = mutableListOf<String>()
        val invokedLocalMessages = mutableListOf<Pair<String, Long>>()
        candidateLocalIds.chunked(QUEUED_STATE_BATCH_SIZE).forEach { batch ->
            val response = api.getQueuedState(sessionId, batch)
            queuedLocalIds += response.queuedLocalIds
            indeterminateLocalIds += response.indeterminateLocalIds
            invokedLocalMessages += response.invokedLocalMessages.map { it.localId to it.invokedAt }
        }
        val invokedByTimestamp = LinkedHashMap<Long, MutableList<String>>()
        for ((localId, invokedAt) in invokedLocalMessages) {
            invokedByTimestamp.getOrPut(invokedAt) { mutableListOf() }.add(localId)
        }
        for ((invokedAt, localIds) in invokedByTimestamp) {
            markConsumed(localIds, invokedAt)
        }
        markIndeterminate(indeterminateLocalIds)
        reconcileQueuedLocalIds(candidateLocalIds, queuedLocalIds + indeterminateLocalIds)
    }

    // ------------------------------------------------------------ lifecycle --

    /** Switch view mode (web `setMessageViewMode`); tail re-entry trims. */
    suspend fun setViewMode(mode: MessageViewMode) {
        update { MessageWindowLogic.setViewMode(it, mode) }
        persist()
    }

    /**
     * Session (re-)activation (web `activateMessageWindow`): trims back to
     * the visible window and, with usable persisted state, requests a
     * fresh-latest trailing run from an in-flight sync.
     */
    suspend fun activate() {
        var requestedLatest = false
        update { previous ->
            val activation = MessageWindowLogic.activate(previous)
            requestedLatest = activation.requestedLatest
            activation.state
        }
        if (requestedLatest) {
            synchronized(controllerLock) {
                if (running != null) {
                    trailingRequested = true
                }
            }
        }
    }

    /** Web `clearMessageWindow`: forget everything but keep generations poisoned. */
    suspend fun clear() {
        synchronized(controllerLock) {
            controllerEpoch += 1
            running = null
            trailingRequested = false
        }
        snapshots?.delete(sessionId)
        update { previous ->
            MessageWindowLogic.createState(sessionId).copy(
                syncGeneration = previous.syncGeneration + 1,
                olderGeneration = previous.olderGeneration + 1,
            )
        }
    }

    /**
     * Seed this window from another session's (web
     * `seedMessageWindowFromSession`) — resume/reopen can hand back a new
     * session id; the old rows render instantly and `requiresLatestReset`
     * forces a fresh latest page underneath.
     */
    suspend fun seedFrom(source: MessageWindowStore) {
        if (source.sessionId == sessionId) return
        synchronized(controllerLock) {
            controllerEpoch += 1
            running = null
            trailingRequested = false
        }
        val sourceState = source.state.value
        update { target -> MessageWindowLogic.seededState(sourceState, target) }
        persist()
    }

    // -------------------------------------------------------------- internals --

    private suspend fun update(transform: (MessageWindowState) -> MessageWindowState): MessageWindowState =
        stateMutex.withLock {
            val next = transform(_state.value)
            _state.value = next
            next
        }

    /** Identity baseline of the current rows, keyed by id (web `requestBaseline`). */
    private fun baseline(): Map<String, WindowMessage> =
        _state.value.messages.associateBy { it.id }

    private fun MessagesResponse.windowMessages(): List<WindowMessage> =
        messages.map { it.asWindowMessage() }

    private suspend fun persist() {
        val snapshotStore = snapshots ?: return
        val state = _state.value
        if (MessageWindowLogic.shouldPersist(state)) {
            snapshotStore.save(sessionId, MessageWindowLogic.toPersisted(state))
        } else {
            snapshotStore.delete(sessionId)
        }
    }

    private companion object {
        const val QUEUED_STATE_BATCH_SIZE = 1000
    }
}
