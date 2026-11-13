package app.hapi.data.store

import app.hapi.data.api.MessagesApi
import app.hapi.data.api.MessagesQuery
import app.hapi.protocol.chat.AGENT_MESSAGE_PAYLOAD_TYPE
import app.hapi.protocol.window.MessageMerge
import app.hapi.protocol.window.MessagePosition
import app.hapi.protocol.window.MessageStatus
import app.hapi.protocol.window.MessageViewMode
import app.hapi.protocol.window.MessageWindowLogic
import app.hapi.protocol.window.HISTORY_WINDOW_SIZE
import app.hapi.protocol.window.MessageWindowState
import app.hapi.protocol.window.OlderLoadOutcome
import app.hapi.protocol.window.INITIAL_PAGE_SIZE
import app.hapi.protocol.window.OLDER_LOAD_WINDOW_SIZE
import app.hapi.protocol.window.PAGE_SIZE
import app.hapi.protocol.window.VISIBLE_WINDOW_SIZE
import app.hapi.protocol.window.WindowMessage
import app.hapi.protocol.window.asWindowMessage
import app.hapi.protocol.window.buildOptimisticMessage
import app.hapi.protocol.wire.AttachmentMetadata
import app.hapi.protocol.wire.MessagesResponse
import app.hapi.protocol.wire.SyncEvent
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
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
    private val historyRetentionLimit: Int = HISTORY_WINDOW_SIZE,
) {
    private val stateMutex = Mutex()
    private val _state = MutableStateFlow((initialState ?: MessageWindowLogic.createState(sessionId))
        .copy(historyRetentionLimit = historyRetentionLimit))

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

    private class TailRun(val prefersLatest: Boolean, val pendingRecovery: Boolean) {
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
    suspend fun syncTail(ensureAfterCurrent: Boolean = false, allowingHistoryReset: Boolean = false) {
        if (allowingHistoryReset) {
            val (epoch, pending) = synchronized(controllerLock) { controllerEpoch to running?.job }
            pending?.join()
            val job = synchronized(controllerLock) {
                if (epoch != controllerEpoch) return
                startTailSyncLocked(allowingHistoryReset = true)
            }
            job.join()
            return
        }
        val decision: SyncDecision = synchronized(controllerLock) {
            val current = running
            val state = _state.value
            when {
                current == null -> SyncDecision.Await(startTailSyncLocked())
                state.preferLatestOnActivation || state.pendingGapRecovery ->
                    // A running sync snapshotted its mode at start; a newly
                    // requested latest reconciliation (cached re-entry or gap
                    // recovery) must not let that older run commit a plain
                    // cursor merge or a full replacement over it.
                    when {
                        current.prefersLatest && !state.pendingGapRecovery ->
                            SyncDecision.Await(current.job)
                        current.pendingRecovery && state.pendingGapRecovery ->
                            SyncDecision.Await(current.job)
                        else -> {
                            trailingRequested = false
                            SyncDecision.Await(startTailSyncLocked())
                        }
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

    private fun startTailSyncLocked(allowingHistoryReset: Boolean = false): Deferred<Unit> {
        val epoch = controllerEpoch
        val run = TailRun(
            prefersLatest = _state.value.preferLatestOnActivation,
            pendingRecovery = _state.value.pendingGapRecovery,
        )
        // UNDISPATCHED mirrors the web: `runTailSync` executes to its first true
        // suspension (normally the api call) before `startTailSync` returns, so
        // `beginTailSync`'s generation bump lands synchronously and an in-flight
        // run it replaces cannot commit another page in between.
        run.job = scope.async(start = CoroutineStart.UNDISPATCHED) { runTailSync(allowingHistoryReset) }
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

    private suspend fun runTailSync(allowingHistoryReset: Boolean) {
        val generation = update { MessageWindowLogic.beginTailSync(it) }.syncGeneration
        try {
            val initial = _state.value
            val initialCursor = initial.newestPosition
            val preferLatestOnActivation = initial.preferLatestOnActivation
            val pendingGapRecovery = initial.pendingGapRecovery
            val canIncrement = initialCursor != null
                && initial.epoch != null
                && !initial.requiresLatestReset
                // A pending gap recovery must run its cursor catch-up even
                // when a cached activation asked for a direct latest page: the
                // activation shortcut fetches only the newest rows and leaves
                // the interval between the cached tail and the page
                // unreachable below the advanced newest cursor.
                && (!preferLatestOnActivation || pendingGapRecovery)

            if (canIncrement && preferLatestOnActivation) {
                // The recovery's catch-up + latest-page reconciliation
                // subsumes the cached-activation refresh. Defer the activation
                // shortcut for this run: left set, it would force-break the
                // catch-up loop after its first chunk.
                update { previous ->
                    if (previous.syncGeneration != generation) return@update previous
                    previous.copy(preferLatestOnActivation = false)
                }
            }

            if (!canIncrement) {
                val requestBaseline = baseline()
                val latestPageSize = if (initial.requiresLatestReset || pendingGapRecovery || initialCursor != null) {
                    PAGE_SIZE
                } else {
                    INITIAL_PAGE_SIZE
                }
                val response = api.getMessages(sessionId, MessagesQuery.Latest(limit = latestPageSize))
                if (!isCurrentTailSync(generation)) return
                update { previous ->
                    if (previous.syncGeneration != generation) return@update previous
                    // Even truncated history must validate the server epoch:
                    // a replay gap may have hidden messages-invalidated.
                    // Preserve its reading anchor only after that validation.
                    if (!allowingHistoryReset && previous.viewMode == MessageViewMode.History &&
                        previous.requiresLatestReset && previous.epoch != null &&
                        !response.page.reset && response.page.epoch == previous.epoch) return@update previous
                    MessageWindowLogic.applyLatestResponse(
                        previous,
                        response.windowMessages(),
                        response.page,
                        replaceServerRows = initial.requiresLatestReset
                            || (preferLatestOnActivation && !pendingGapRecovery)
                            || response.page.reset,
                        requestBaseline = requestBaseline,
                    ).copy(preferLatestOnActivation = false, pendingGapRecovery = false)
                }
                finishTailSync(generation, warning = null)
                return
            }

            var after: MessagePosition = initialCursor!!
            var until: MessagePosition? = null
            var catchUpReset = false
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
                        ).copy(pendingGapRecovery = false, preferLatestOnActivation = false)
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

            if (pendingGapRecovery) {
                if (catchUpReset) {
                    // A reset verdict already replaced the window
                    // authoritatively under the server's epoch; there is
                    // nothing left to refresh.
                    update { previous ->
                        if (previous.syncGeneration != generation) return@update previous
                        previous.copy(pendingGapRecovery = false, preferLatestOnActivation = false)
                    }
                } else if (_state.value.requiresLatestReset) {
                    // The catch-up overflowed the window's history budget:
                    // the prepend trim dropped the newer caught-up rows and
                    // marked the window for a reset. Reconciling the latest
                    // page on top would strand the rows between the
                    // reset-marked window and the page — unreachable from
                    // either cursor — so leave the reset requirement and the
                    // recovery flags intact: the next authoritative
                    // replacement closes the hole and consumes the flags.
                } else {
                    // The cursor phase caught the window up without error.
                    // Only now may the recovery advance to the latest page:
                    // reconciling after a failed catch-up would strand the rows
                    // between the cached tail and the page below the advanced
                    // newest cursor. On a catch-up failure the catch above
                    // skips this block, the original cursor and the flag
                    // survive, and the next sync retries the whole recovery.
                    val requestBaseline = baseline()
                    val response = api.getMessages(sessionId, MessagesQuery.Latest(limit = PAGE_SIZE))
                    if (!isCurrentTailSync(generation)) return
                    update { previous ->
                        if (previous.syncGeneration != generation) return@update previous
                        // The trim honors the window's loaded history budget
                        // (web `4d1d9e2025`): a no-news reconnect never evicts
                        // rows the reader already had.
                        val trimLimit = minOf(
                            OLDER_LOAD_WINDOW_SIZE,
                            maxOf(VISIBLE_WINDOW_SIZE, previous.messages.size),
                        )
                        MessageWindowLogic.applyLatestResponse(
                            previous,
                            response.windowMessages(),
                            response.page,
                            replaceServerRows = response.page.reset
                                || (previous.epoch != null && response.page.epoch != previous.epoch),
                            requestBaseline = requestBaseline,
                            trimLimit = trimLimit,
                        )
                        // The activation flag is consumed here — the upsert
                        // subsumed its refresh — but the recovery stays
                        // pending until the row sweep below succeeds, so a
                        // failed context request retries on the next sync
                        // instead of leaving the enriched cached call stale
                        // with no retry path.
                            .copy(preferLatestOnActivation = false)
                    }

                    // A tool-call row the client cached before the gap can be
                    // enriched in place afterwards; when more than a latest
                    // page of newer rows followed, neither the catch-up
                    // (newer rows only) nor the page reaches it, and the
                    // cached card keeps its stale input/status. Refresh those
                    // retained non-terminal rows by id through the
                    // message-context endpoint: bounded, newest first, and
                    // skipped for rows the catch-up already delivered fresh
                    // (at or after the recovery cursor).
                    val pageOldest = MessageWindowLogic.pagePosition(response.page.nextBeforeAt, response.page.nextBeforeSeq)
                    if (pageOldest != null) {
                        val refreshCandidates = _state.value.messages
                            .filter { message ->
                                val position = MessageWindowLogic.messagePosition(message)
                                if (position == null || position >= pageOldest) return@filter false
                                if (initialCursor != null && position > initialCursor) return@filter false
                                isNonTerminalToolCallRow(message)
                            }
                            .sortedByDescending { MessageWindowLogic.messagePosition(it)!! }
                            .take(GAP_ROW_REFRESH_LIMIT)
                        for (candidate in refreshCandidates) {
                            val context = api.getMessageContext(sessionId, candidate.id)
                            if (!isCurrentTailSync(generation)) return
                            val refreshed = context?.messages?.find { it.id == candidate.id }?.asWindowMessage()
                            if (refreshed == null) {
                                // The row is no longer reachable through the
                                // context endpoint: leave it as is and finish
                                // the run's bookkeeping — an early return here
                                // would leave the window marked syncing.
                                finishTailSync(generation, "Failed to refresh a merged tool call")
                                return
                            }
                            if (context.page.epoch != _state.value.epoch) {
                                // The refresh answered under a different
                                // epoch: server rows may have been deleted
                                // since the page was fetched. Mark the window
                                // for the authoritative replacement instead
                                // of reconciling against a stale snapshot,
                                // and finish the run's bookkeeping.
                                update { previous ->
                                    if (previous.syncGeneration != generation) return@update previous
                                    previous.copy(requiresLatestReset = true)
                                }
                                finishTailSync(generation, "Failed to refresh a merged tool call")
                                return
                            }
                            update { previous ->
                                if (previous.syncGeneration != generation) return@update previous
                                MessageWindowLogic.mergeRefreshedRow(previous, refreshed)
                            }
                        }
                    }

                    // The catch-up, the upsert, and every row refresh
                    // succeeded: only now is the recovery complete.
                    update { previous ->
                        if (previous.syncGeneration != generation) return@update previous
                        previous.copy(pendingGapRecovery = false)
                    }
                }
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
        // Reserve atomically: concurrent consumers must not both pass the
        // precheck before either publishes isLoadingMore.
        val (initial, precheck) = stateMutex.withLock {
            val initial = _state.value
            val check = MessageWindowLogic.olderLoadPrecheck(initial)
            if (check is MessageWindowLogic.OlderPrecheck.Proceed) {
                _state.value = MessageWindowLogic.beginOlderLoad(initial, initial.olderGeneration + 1)
            }
            initial to check
        }
        when (precheck) {
            is MessageWindowLogic.OlderPrecheck.Stop -> return OlderLoadOutcome.Stopped(precheck.reason)
            is MessageWindowLogic.OlderPrecheck.Proceed -> {
                val before = precheck.before
                val generation = initial.olderGeneration + 1
                return try {
                    val response = api.getMessages(
                        sessionId,
                        MessagesQuery.Before(beforeAt = before.at, beforeSeq = before.seq, limit = PAGE_SIZE),
                    )
                    currentCoroutineContext().ensureActive()
                    if (_state.value.olderGeneration != generation) {
                        return OlderLoadOutcome.Stopped(OlderLoadOutcome.StopReason.Invalidated)
                    }

                    if (initial.epoch != null && response.page.epoch != initial.epoch) {
                        update { MessageWindowLogic.applyOlderEpochMismatch(it, generation) }
                        syncTail(ensureAfterCurrent = true)
                        return OlderLoadOutcome.Stopped(OlderLoadOutcome.StopReason.EpochReset)
                    }

                    if (response.page.hasMore) {
                        val at = response.page.nextBeforeAt
                        val seq = response.page.nextBeforeSeq
                        if (at == null || seq == null || MessagePosition(at, seq) >= before) {
                            update { MessageWindowLogic.failOlderLoad(it, generation,
                                "Message history cursor did not advance") }
                            return OlderLoadOutcome.Stopped(OlderLoadOutcome.StopReason.CursorDidNotAdvance)
                        }
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
                    withContext(NonCancellable) {
                        update {
                            if (it.olderGeneration == generation) MessageWindowLogic.cancelOlderLoad(it) else it
                        }
                    }
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
     * One gap-recovery step for a session message window (web
     * `recoverWindowAfterGapResume`).
     *
     * A resumed-with-gap connection (`resume: 'gap'`) cannot prove
     * continuity, and in-place row updates (merged tool-call ticks) keep the
     * row's original cursor position, so a plain cursor sync re-delivers new
     * rows but never the merged content of rows the window already holds.
     * Flag the window and let the next tail sync run the full recovery: the
     * cursor catch-up pulls every row the window missed, then an
     * authoritative latest page is applied as an upsert — rows present in the
     * page are replaced by id while already-loaded rows older than the latest
     * page and the hasMore/oldest cursor survive. A failed catch-up keeps the
     * flag and the original cursor, so the next sync retries the whole
     * recovery. Cold or structurally invalidated windows have nothing to
     * preserve and keep the plain reset choreography.
     */
    suspend fun recoverAfterGapResume() {
        val previous = _state.value
        if (previous.requiresLatestReset || previous.newestPosition == null || previous.epoch == null) {
            return syncTail()
        }
        update { it.copy(pendingGapRecovery = true) }
        syncTail()
    }

    /**
     * Queued-state recovery after a `resume: 'gap'` reconnect (port of
     * `web/src/lib/queued-state-reconciliation.ts`): tail-sync to the drain,
     * collect candidates, ask the hub for the verdict in ≤1000-id batches,
     * stamp invoked rows like `messages-consumed`, drop deleted candidates.
     * The window's gap recovery ([recoverAfterGapResume]) is a separate step
     * the sync-target layer runs first (web wires the two the same way).
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
            val next = transform(_state.value).copy(historyRetentionLimit = historyRetentionLimit)
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

        /** Gap recovery refreshes at most this many retained non-terminal
         *  tool-call rows through the message-context endpoint (newest
         *  first). Live calls are a handful; the bound keeps a pathological
         *  window from fanning out requests. */
        const val GAP_ROW_REFRESH_LIMIT = 20
    }

    /** A cached tool-call row that can still be enriched in place: its
     *  payload is a live `tool-call` whose merged status has not reached a
     *  terminal tier. Terminal rows are done; unknown or missing status
     *  reads as pending. */
    private fun isNonTerminalToolCallRow(message: WindowMessage): Boolean {
        val envelope = message.wire.content as? JsonObject ?: return false
        if ((envelope["role"] as? JsonPrimitive)?.contentOrNull != "agent") return false
        val payload = envelope["content"] as? JsonObject ?: return false
        if ((payload["type"] as? JsonPrimitive)?.contentOrNull != AGENT_MESSAGE_PAYLOAD_TYPE) return false
        val data = payload["data"] as? JsonObject ?: return false
        if ((data["type"] as? JsonPrimitive)?.contentOrNull != "tool-call") return false
        val status = (data["status"] as? JsonPrimitive)?.contentOrNull
        return status != "completed" && status != "failed"
    }
}
