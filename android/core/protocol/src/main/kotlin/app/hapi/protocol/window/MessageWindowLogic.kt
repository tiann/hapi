package app.hapi.protocol.window

import app.hapi.protocol.wire.MessagesPage
import app.hapi.protocol.wire.hasExplicitNullInvokedAt
import app.hapi.protocol.wire.stringOrNull
import kotlinx.serialization.json.JsonObject

/**
 * Pure state transitions of the message window — a function-for-function port
 * of `web/src/lib/message-window-store.ts` (with the async orchestration
 * stripped out; `:core:data`'s `MessageWindowStore` re-adds it). Every
 * function takes the previous [MessageWindowState] and returns the next one;
 * nothing here touches clocks, I/O, or coroutines, so the whole surface is
 * fixture-comparable.
 */
object MessageWindowLogic {

    enum class TrimMode { Append, Prepend }

    fun createState(sessionId: String): MessageWindowState = MessageWindowState(sessionId = sessionId)

    // -------------------------------------------------------------- helpers --

    /** Web `buildState`: swap the messages list, re-derive seq bounds, bump the version on identity change. */
    private fun MessageWindowState.withMessages(messages: List<WindowMessage>): MessageWindowState {
        if (messages === this.messages) return this
        var oldestSeq: Long? = null
        var newestSeq: Long? = null
        for (message in messages) {
            val seq = message.seq ?: continue
            oldestSeq = if (oldestSeq == null) seq else minOf(oldestSeq, seq)
            newestSeq = if (newestSeq == null) seq else maxOf(newestSeq, seq)
        }
        return copy(
            messages = messages,
            oldestSeq = oldestSeq,
            newestSeq = newestSeq,
            messagesVersion = messagesVersion + 1,
        )
    }

    /** A row's compound position; rows without a server `seq` have none. */
    fun messagePosition(message: WindowMessage): MessagePosition? {
        val seq = message.seq ?: return null
        return MessagePosition(at = message.positionAt, seq = seq)
    }

    enum class PositionEnd { Oldest, Newest }

    fun derivePosition(messages: List<WindowMessage>, end: PositionEnd): MessagePosition? {
        var selected: MessagePosition? = null
        for (message in messages) {
            val candidate = messagePosition(message) ?: continue
            val current = selected
            if (current == null) {
                selected = candidate
                continue
            }
            val comparison = candidate.compareTo(current)
            if ((end == PositionEnd.Oldest && comparison < 0) || (end == PositionEnd.Newest && comparison > 0)) {
                selected = candidate
            }
        }
        return selected
    }

    /** Pairwise page cursor (`pagePosition` in the web): both halves or nothing. */
    fun pagePosition(at: Long?, seq: Long?): MessagePosition? =
        if (at != null && seq != null) MessagePosition(at, seq) else null

    private fun maxPosition(a: MessagePosition?, b: MessagePosition?): MessagePosition? = when {
        a == null -> b
        b == null -> a
        a >= b -> a
        else -> b
    }

    // ---------------------------------------------------------------- trims --

    private data class Trim(val kept: List<WindowMessage>, val dropped: List<WindowMessage>)

    private fun sliceForTrim(items: List<WindowMessage>, limit: Int, mode: TrimMode): Trim {
        if (items.size <= limit) return Trim(items, emptyList())
        if (limit <= 0) return Trim(emptyList(), items)
        return when (mode) {
            TrimMode.Prepend -> Trim(items.subList(0, limit).toList(), items.subList(limit, items.size).toList())
            TrimMode.Append -> Trim(
                items.subList(items.size - limit, items.size).toList(),
                items.subList(0, items.size - limit).toList(),
            )
        }
    }

    /**
     * Codex background-agent trace rows (`agent-run-*`) get their own trim
     * bucket so long traces do not evict chat (web `isCodexAgentRunMessage`).
     */
    fun isCodexAgentRunMessage(message: WindowMessage): Boolean {
        val outer = message.wire.content as? JsonObject ?: return false
        if (outer["role"].stringOrNull != "agent") return false
        val content = outer["content"] as? JsonObject ?: return false
        if (content["type"].stringOrNull != "codex") return false
        val data = content["data"] as? JsonObject ?: return false
        val type = data["type"].stringOrNull
        return type == "agent-run-start" || type == "agent-run-update" || type == "agent-run-trace"
    }

    /**
     * Web `getReasoningStreamId`: the stream a reasoning row belongs to, or
     * null for anything else. Unrecognised shapes read as null, which means
     * "keep it".
     */
    private fun reasoningStreamId(message: WindowMessage): String? {
        val outer = message.wire.content as? JsonObject ?: return null
        if (outer["role"].stringOrNull != "agent") return null
        val content = outer["content"] as? JsonObject ?: return null
        if (content["type"].stringOrNull != "codex") return null
        val data = content["data"] as? JsonObject ?: return null
        if (data["type"].stringOrNull != "reasoning") return null
        val id = data["id"].stringOrNull ?: return null
        return id.takeIf { it.isNotBlank() }
    }

    /**
     * Web `dropSupersededReasoningSnapshots`: collapse a reasoning stream to
     * the one snapshot that still says something. The CLI re-sends a growing
     * buffer under a stable stream id every few hundred milliseconds and the
     * timeline folds those rows into a single block, so spending window budget
     * on the older ones is what pushes the surrounding conversation out of
     * reach. Rows with no stream id are left alone.
     */
    private fun dropSupersededReasoningSnapshots(messages: List<WindowMessage>): List<WindowMessage> {
        val newestByStream = LinkedHashMap<String, WindowMessage>()
        for (message in messages) {
            val streamId = reasoningStreamId(message) ?: continue
            val incumbent = newestByStream[streamId]
            if (incumbent == null) {
                newestByStream[streamId] = message
                continue
            }
            // Fall back to arrival order when either row predates seq
            // numbering: `messages` is kept in display order, so later still
            // means newer.
            val challengerAt = messagePosition(message)
            val incumbentAt = messagePosition(incumbent)
            val newer = if (challengerAt != null && incumbentAt != null) {
                challengerAt >= incumbentAt
            } else {
                true
            }
            if (newer) newestByStream[streamId] = message
        }
        if (newestByStream.isEmpty()) return messages
        val survivors = newestByStream.values.mapTo(HashSet()) { it.id }
        return messages.filter { reasoningStreamId(it) == null || it.id in survivors }
    }

    /**
     * Trim to [regularLimit] while never dropping queued rows: superseded
     * reasoning snapshots are collapsed first, the regular budget shrinks by
     * the queued count, `agent-run-*` rows trim against their own
     * [AGENT_RUN_WINDOW_SIZE] bucket, and queued rows are re-merged afterwards
     * (web `trimPreservingQueued`).
     */
    private fun trimPreservingQueued(incoming: List<WindowMessage>, regularLimit: Int, mode: TrimMode): Trim {
        val messages = dropSupersededReasoningSnapshots(incoming)
        val queued = messages.filter { it.isQueuedForInvocation }
        val queuedIds = queued.mapTo(HashSet()) { it.id }
        val nonQueued = messages.filter { it.id !in queuedIds }
        val agentRuns = nonQueued.filter { isCodexAgentRunMessage(it) }
        val regular = nonQueued.filter { !isCodexAgentRunMessage(it) }
        val regularTrim = sliceForTrim(regular, maxOf(0, regularLimit - queued.size), mode)
        val agentRunTrim = sliceForTrim(agentRuns, AGENT_RUN_WINDOW_SIZE, mode)
        return Trim(
            kept = MessageMerge.mergeMessages(regularTrim.kept + agentRunTrim.kept, queued),
            dropped = regularTrim.dropped + agentRunTrim.dropped,
        )
    }

    // ------------------------------------------------------------ retention --

    /** Web `shouldRetainWindowMessage`: queued, or renderable by the chat pipeline. */
    fun shouldRetainWindowMessage(message: WindowMessage): Boolean =
        message.isQueuedForInvocation || MessageRetention.isRenderable(message.wire.content)

    /**
     * How many of [incoming] would add a NEW renderable row (not already
     * represented by id or localId) — feeds the `applied` older-load outcome.
     */
    fun countNewRenderableMessages(previous: MessageWindowState, incoming: List<WindowMessage>): Int {
        val representedIds = previous.messages.mapTo(HashSet()) { it.id }
        val representedLocalIds = previous.messages.mapNotNullTo(HashSet()) { it.localId }
        var count = 0
        for (message in incoming) {
            if (!shouldRetainWindowMessage(message)) continue
            if (message.id in representedIds) continue
            val localId = message.localId
            if (localId != null && localId in representedLocalIds) continue
            count += 1
            representedIds.add(message.id)
            if (localId != null) representedLocalIds.add(localId)
        }
        return count
    }

    // ---------------------------------------------------------------- merge --

    /**
     * Merge [incoming] into the window, trim per mode/limit, and repair
     * cursors/flags on overflow (web `mergeIntoWindow`): an append-side trim
     * flips `hasMore` and recomputes the older cursor from the oldest kept
     * row; a prepend-side trim drops tail rows, so the window no longer
     * reaches the live bottom — flag `requiresLatestReset` and pull the
     * newest cursor back to the newest kept row.
     */
    fun mergeIntoWindow(
        previous: MessageWindowState,
        incoming: List<WindowMessage>,
        mode: TrimMode? = null,
        regularLimit: Int? = null,
        advanceTailRevision: Boolean = false,
    ): MessageWindowState {
        val retainedIncoming = incoming.filter { shouldRetainWindowMessage(it) }
        if (retainedIncoming.isEmpty()) {
            return previous
        }
        val effectiveMode = mode
            ?: if (previous.viewMode == MessageViewMode.History) TrimMode.Prepend else TrimMode.Append
        val effectiveLimit = regularLimit
            ?: if (previous.viewMode == MessageViewMode.History) HISTORY_WINDOW_SIZE else VISIBLE_WINDOW_SIZE
        val merged = MessageMerge.mergeMessages(previous.messages, retainedIncoming)
        val (kept, dropped) = trimPreservingQueued(merged, effectiveLimit, effectiveMode).let { it.kept to it.dropped }
        var next = previous.withMessages(kept)
        if (advanceTailRevision) {
            next = next.copy(tailRevision = previous.tailRevision + 1)
        }
        if (dropped.isEmpty()) {
            return next
        }
        if (effectiveMode == TrimMode.Append) {
            val oldest = derivePosition(kept, PositionEnd.Oldest)
            return next.copy(
                hasMore = true,
                oldestPosition = oldest ?: next.oldestPosition,
            )
        }
        val newest = derivePosition(kept, PositionEnd.Newest)
        return next.copy(
            requiresLatestReset = true,
            newestPosition = newest,
        )
    }

    // -------------------------------------------------------- latest replace --

    /**
     * Apply a `latest` page (cold start, activation refresh, or a reset
     * response). With [replaceServerRows] the page is authoritative: every
     * server row captured in [requestBaseline] (by **reference**) is
     * discarded, while optimistic rows and rows that changed since the
     * request left (concurrent SSE) survive the swap (web
     * `applyLatestResponse`).
     */
    fun applyLatestResponse(
        previous: MessageWindowState,
        responseMessages: List<WindowMessage>,
        page: MessagesPage,
        replaceServerRows: Boolean,
        requestBaseline: Map<String, WindowMessage>,
    ): MessageWindowState {
        val retainedResponseMessages = responseMessages.filter { shouldRetainWindowMessage(it) }
        val concurrentServerRows = previous.messages.filter { message ->
            !message.isOptimistic && requestBaseline[message.id] !== message
        }
        val preserved = if (replaceServerRows) {
            previous.messages.filter { message ->
                message.isOptimistic || requestBaseline[message.id] !== message
            }
        } else {
            previous.messages
        }
        val authoritative = MessageMerge.mergeMessages(preserved, retainedResponseMessages)
        val incoming = MessageMerge.mergeMessages(authoritative, concurrentServerRows)
        val (kept, dropped) = trimPreservingQueued(incoming, VISIBLE_WINDOW_SIZE, TrimMode.Append)
            .let { it.kept to it.dropped }
        val snapshotHead = pagePosition(page.snapshotHeadAt, page.snapshotHeadSeq)
            ?: derivePosition(responseMessages, PositionEnd.Newest)
        val newestKept = derivePosition(kept, PositionEnd.Newest)
        val newest = maxPosition(snapshotHead, newestKept)
        val responseOldest = pagePosition(page.nextBeforeAt, page.nextBeforeSeq)
        val oldest = when {
            dropped.isNotEmpty() -> derivePosition(kept, PositionEnd.Oldest)
            replaceServerRows -> responseOldest
            else -> responseOldest ?: previous.oldestPosition
        }
        return previous.withMessages(kept).copy(
            hasMore = page.hasMore || (!replaceServerRows && previous.hasMore) || dropped.isNotEmpty(),
            epoch = page.epoch,
            oldestPosition = oldest,
            newestPosition = newest,
            tailRevision = previous.tailRevision + 1,
            requiresLatestReset = false,
            isLoadingMore = if (replaceServerRows) false else previous.isLoadingMore,
            olderGeneration = if (replaceServerRows) previous.olderGeneration + 1 else previous.olderGeneration,
            warning = null,
        )
    }

    // ------------------------------------------------------------ tail sync --

    /**
     * Web `beginTailSync`: claim a new sync generation. The older generation
     * bumps too — an older-page response captured before this point must not
     * commit while the tail request is in flight, or a reset can mistake it
     * for concurrent SSE.
     */
    fun beginTailSync(previous: MessageWindowState): MessageWindowState = previous.copy(
        syncGeneration = previous.syncGeneration + 1,
        olderGeneration = previous.olderGeneration + 1,
        isSyncingTail = true,
        isLoadingMore = false,
        warning = null,
    )

    fun finishTailSync(previous: MessageWindowState, generation: Long, warning: String?): MessageWindowState =
        if (previous.syncGeneration != generation) {
            previous
        } else {
            previous.copy(isSyncingTail = false, warning = warning)
        }

    /**
     * Loop body of the after-cursor catch-up (web `runTailSync` inner
     * updater): merge the page, adopt its epoch, and advance the newest
     * cursor to `max(current, nextAfter)` — unless a prepend-side trim just
     * flagged a latest reset, in which case the cursor stays pulled back.
     */
    fun applyAfterPage(
        previous: MessageWindowState,
        responseMessages: List<WindowMessage>,
        page: MessagesPage,
        nextAfter: MessagePosition?,
    ): MessageWindowState {
        val merged = mergeIntoWindow(previous, responseMessages, advanceTailRevision = true)
        if (merged.requiresLatestReset) {
            return merged.copy(epoch = page.epoch, warning = null)
        }
        val newest = maxPosition(nextAfter, merged.newestPosition)
        return merged.copy(
            epoch = page.epoch,
            newestPosition = newest,
            warning = null,
        )
    }

    // ------------------------------------------------------------ view mode --

    /**
     * Re-enter tail mode (web `enterTailMode`): trim to the visible window;
     * when a history overflow flagged `requiresLatestReset`, drop epoch and
     * newest cursor so the next tail sync fetches a fresh latest page.
     */
    fun enterTailMode(previous: MessageWindowState): MessageWindowState {
        val trim = trimPreservingQueued(previous.messages, VISIBLE_WINDOW_SIZE, TrimMode.Append)
        val forceLatest = previous.requiresLatestReset
        val oldest = if (trim.dropped.isNotEmpty()) {
            derivePosition(trim.kept, PositionEnd.Oldest)
        } else {
            previous.oldestPosition
        }
        return previous.withMessages(trim.kept).copy(
            hasMore = previous.hasMore || trim.dropped.isNotEmpty(),
            viewMode = MessageViewMode.Tail,
            epoch = if (forceLatest) null else previous.epoch,
            oldestPosition = oldest,
            newestPosition = if (forceLatest) null else previous.newestPosition,
        )
    }

    fun setViewMode(previous: MessageWindowState, mode: MessageViewMode): MessageWindowState = when {
        previous.viewMode == mode -> previous
        mode == MessageViewMode.History -> previous.copy(viewMode = MessageViewMode.History)
        else -> enterTailMode(previous)
    }

    data class Activation(val state: MessageWindowState, val requestedLatest: Boolean)

    /**
     * Session (re-)activation (web `activateMessageWindow`): trim back to the
     * visible window, and when a usable persisted cursor exists, flag
     * `preferLatestOnActivation` — another client may have advanced the
     * session by many pages, so the next tail sync fetches the current tail
     * first and reconciles it through the reset-preservation path.
     */
    fun activate(previous: MessageWindowState): Activation {
        val trim = trimPreservingQueued(previous.messages, VISIBLE_WINDOW_SIZE, TrimMode.Append)
        val forceLatest = previous.requiresLatestReset
        val hasUsableCursor = previous.newestPosition != null && previous.epoch != null && !forceLatest
        val preferLatestOnActivation = hasUsableCursor && trim.kept.isNotEmpty()
        val requestedLatest = preferLatestOnActivation && !previous.preferLatestOnActivation
        val invalidateRunningSync = requestedLatest && previous.isSyncingTail

        fun MessageWindowState.withActivationUpdates(): MessageWindowState {
            if (!preferLatestOnActivation) return this
            val flagged = copy(preferLatestOnActivation = true)
            return if (invalidateRunningSync) {
                flagged.copy(
                    syncGeneration = flagged.syncGeneration + 1,
                    olderGeneration = flagged.olderGeneration + 1,
                )
            } else {
                flagged
            }
        }

        if (
            previous.viewMode == MessageViewMode.Tail
            && trim.kept.size == previous.messages.size
            && !forceLatest
        ) {
            val state = if (preferLatestOnActivation) previous.withActivationUpdates() else previous
            return Activation(state, requestedLatest)
        }
        val next = enterTailMode(previous)
        val state = if (preferLatestOnActivation) next.withActivationUpdates() else next
        return Activation(state, requestedLatest)
    }

    // ---------------------------------------------------------- older pages --

    sealed interface OlderPrecheck {
        data class Proceed(val before: MessagePosition) : OlderPrecheck
        data class Stop(val reason: OlderLoadOutcome.StopReason) : OlderPrecheck
    }

    fun olderLoadPrecheck(state: MessageWindowState): OlderPrecheck {
        val before = state.oldestPosition
        if (state.isSyncingTail || state.isLoadingMore) {
            return OlderPrecheck.Stop(OlderLoadOutcome.StopReason.Busy)
        }
        if (!state.hasMore) {
            return OlderPrecheck.Stop(OlderLoadOutcome.StopReason.Exhausted)
        }
        if (before == null) {
            return OlderPrecheck.Stop(OlderLoadOutcome.StopReason.Unavailable)
        }
        return OlderPrecheck.Proceed(before)
    }

    fun beginOlderLoad(previous: MessageWindowState, generation: Long): MessageWindowState =
        previous.copy(olderGeneration = generation, isLoadingMore = true, warning = null)

    /**
     * An older page answered with a different epoch: every cursor is
     * meaningless. Drop epoch + newest cursor and flag the latest reset; the
     * caller then runs a tail sync and reports `stopped/epoch-reset`.
     */
    fun applyOlderEpochMismatch(previous: MessageWindowState, generation: Long): MessageWindowState =
        if (previous.olderGeneration != generation) {
            previous
        } else {
            previous.copy(
                isLoadingMore = false,
                epoch = null,
                newestPosition = null,
                requiresLatestReset = true,
            )
        }

    /** The `onBeforeApply` veto path: invalidate this load, keep the window. */
    fun rejectOlderApply(previous: MessageWindowState): MessageWindowState = previous.copy(
        olderGeneration = previous.olderGeneration + 1,
        isLoadingMore = false,
        warning = null,
    )

    fun applyOlderResponse(
        previous: MessageWindowState,
        responseMessages: List<WindowMessage>,
        page: MessagesPage,
        historyVersion: Long,
    ): MessageWindowState {
        val merged = mergeIntoWindow(
            previous,
            responseMessages,
            mode = TrimMode.Prepend,
            regularLimit = OLDER_LOAD_WINDOW_SIZE,
        )
        return merged.copy(
            hasMore = page.hasMore,
            epoch = page.epoch,
            oldestPosition = pagePosition(page.nextBeforeAt, page.nextBeforeSeq),
            isLoadingMore = false,
            historyVersion = historyVersion,
            warning = null,
        )
    }

    fun failOlderLoad(previous: MessageWindowState, generation: Long, warning: String): MessageWindowState =
        if (previous.olderGeneration != generation) {
            previous
        } else {
            previous.copy(isLoadingMore = false, warning = warning)
        }

    fun cancelOlderLoad(previous: MessageWindowState): MessageWindowState =
        if (!previous.isLoadingMore) {
            previous
        } else {
            previous.copy(
                olderGeneration = previous.olderGeneration + 1,
                isLoadingMore = false,
                warning = null,
            )
        }

    // ------------------------------------------------------------ live rows --

    /**
     * SSE `message-received` ingest (web `ingestIncomingMessages`): merge,
     * then — when an epoch is cached and no reset is pending — advance the
     * newest cursor past the incoming rows' positions, **including rows the
     * pipeline hides**, so a later tail sync does not refetch them.
     */
    fun ingestIncoming(previous: MessageWindowState, incoming: List<WindowMessage>): MessageWindowState {
        if (incoming.isEmpty()) return previous
        val merged = mergeIntoWindow(previous, incoming, advanceTailRevision = true)
        if (merged.epoch == null || merged.requiresLatestReset) {
            return merged
        }
        val incomingNewest = derivePosition(incoming, PositionEnd.Newest)
        val currentNewest = merged.newestPosition
        val newest = if (incomingNewest != null && (currentNewest == null || incomingNewest > currentNewest)) {
            incomingNewest
        } else {
            currentNewest
        }
        return merged.copy(newestPosition = newest)
    }

    /** Optimistic append (web `appendOptimisticMessage`): never advances the newest cursor. */
    fun appendOptimistic(previous: MessageWindowState, message: WindowMessage): MessageWindowState =
        mergeIntoWindow(
            previous,
            listOf(message),
            mode = if (previous.viewMode == MessageViewMode.History) TrimMode.Prepend else TrimMode.Append,
            advanceTailRevision = true,
        )

    fun updateStatus(previous: MessageWindowState, localId: String, status: MessageStatus): MessageWindowState {
        if (localId.isEmpty()) return previous
        var changed = false
        val messages = previous.messages.map { message ->
            if (message.localId != localId || message.status == status) {
                message
            } else {
                changed = true
                message.copy(status = status)
            }
        }
        return if (changed) previous.withMessages(messages) else previous
    }

    /** Mark a row's native delivery outcome as unknown without invoking it. */
    fun markIndeterminate(previous: MessageWindowState, localIds: List<String>): MessageWindowState {
        if (localIds.isEmpty()) return previous
        val ids = localIds.toSet()
        var changed = false
        val messages = previous.messages.map { message ->
            if (message.localId == null || message.localId !in ids || message.status == MessageStatus.Indeterminate) {
                message
            } else {
                changed = true
                message.copy(status = MessageStatus.Indeterminate)
            }
        }
        return if (changed) previous.withMessages(messages) else previous
    }

    fun markRequeued(previous: MessageWindowState, localIds: List<String>): MessageWindowState {
        if (localIds.isEmpty()) return previous
        val ids = localIds.toSet()
        var changed = false
        val messages = previous.messages.map { message ->
            if (message.localId == null || message.localId !in ids || message.status != MessageStatus.Indeterminate) {
                message
            } else {
                changed = true
                message.copy(status = MessageStatus.Queued)
            }
        }
        return if (changed) previous.withMessages(messages) else previous
    }

    /** `message-cancelled` / optimistic DELETE removal: matches localId OR id; idempotent. */
    fun removeByLocalIdOrId(previous: MessageWindowState, localId: String): MessageWindowState {
        if (localId.isEmpty()) return previous
        val messages = previous.messages.filter { it.localId != localId && it.id != localId }
        return if (messages.size == previous.messages.size) previous else previous.withMessages(messages)
    }

    /**
     * SSE `messages-consumed` (web `markMessagesConsumed`): stamp `invokedAt`
     * and flip status to `sent` on matching rows (skip `failed`), then
     * re-sort — the row moves from its enqueue position to its invocation
     * position. Never advances the newest cursor.
     */
    fun markConsumed(previous: MessageWindowState, localIds: List<String>, invokedAt: Long): MessageWindowState {
        if (localIds.isEmpty()) return previous
        val idSet = localIds.toSet()
        var changed = false
        val updated = previous.messages.map { message ->
            val localId = message.localId
            if (localId == null || localId !in idSet || message.status == MessageStatus.Failed) {
                return@map message
            }
            val needsStatus = message.status != MessageStatus.Sent
            val needsInvokedAt = message.wire.hasExplicitNullInvokedAt
            if (!needsStatus && !needsInvokedAt) return@map message
            changed = true
            var next = message
            if (needsStatus) next = next.copy(status = MessageStatus.Sent)
            if (needsInvokedAt) next = next.withInvokedAt(invokedAt)
            next
        }
        if (!changed) return previous
        return previous
            .withMessages(MessageMerge.mergeMessages(emptyList(), updated))
            .copy(tailRevision = previous.tailRevision + 1)
    }

    // -------------------------------------------------- queued reconciliation --

    /** Web `isQueuedReconcileCandidate`. */
    private fun isQueuedReconcileCandidate(message: WindowMessage): Boolean {
        if (message.localId == null || !message.isQueuedForInvocation) return false
        if (!message.isOptimistic) return true
        return message.status == MessageStatus.Queued || message.status == MessageStatus.Sent
    }

    /** Candidate localIds for the queued-state round trip, in window order. */
    fun queuedReconcileCandidateLocalIds(state: MessageWindowState): List<String> {
        val localIds = LinkedHashSet<String>()
        for (message in state.messages) {
            if (isQueuedReconcileCandidate(message)) {
                localIds.add(message.localId!!)
            }
        }
        return localIds.toList()
    }

    /**
     * Apply the queued-state verdict (web `reconcileQueuedLocalIds`): drop
     * candidates that are in neither the still-queued list nor (post
     * `markConsumed`) invoked — they were deleted server-side.
     */
    fun reconcileQueuedLocalIds(
        previous: MessageWindowState,
        candidateLocalIds: List<String>,
        queuedLocalIds: List<String>,
    ): MessageWindowState {
        if (candidateLocalIds.isEmpty()) return previous
        val candidates = candidateLocalIds.toSet()
        val queued = queuedLocalIds.toSet()
        val messages = previous.messages.filter { message ->
            val localId = message.localId
            if (localId == null || localId !in candidates) return@filter true
            localId in queued || !isQueuedReconcileCandidate(message)
        }
        return if (messages.size == previous.messages.size) previous else previous.withMessages(messages)
    }

    // ---------------------------------------------------------- persistence --

    /** Web `shouldPersistState`. */
    fun shouldPersist(state: MessageWindowState): Boolean =
        state.messages.isNotEmpty()
            || state.hasMore
            || state.epoch != null
            || state.oldestPosition != null
            || state.newestPosition != null

    fun toPersisted(state: MessageWindowState): PersistedMessageWindow = PersistedMessageWindow(
        messages = state.messages,
        hasMore = state.hasMore,
        oldestPositionAt = state.oldestPosition?.at,
        oldestPositionSeq = state.oldestPosition?.seq,
        newestPositionAt = state.newestPosition?.at,
        newestPositionSeq = state.newestPosition?.seq,
        epoch = state.epoch,
    )

    /**
     * Rebuild a state from a persisted snapshot (web `hydrateState`):
     * interrupted `sending` rows restore to `queued`/`sent`, and a snapshot
     * with rows but no usable cursor/epoch starts flagged for a latest reset.
     */
    fun hydrate(sessionId: String, persisted: PersistedMessageWindow): MessageWindowState {
        val restored = persisted.messages.map { message ->
            if (message.status != MessageStatus.Sending) {
                message
            } else {
                message.copy(
                    status = if (message.wire.hasExplicitNullInvokedAt) MessageStatus.Queued else MessageStatus.Sent,
                )
            }
        }
        val oldest = pagePosition(persisted.oldestPositionAt, persisted.oldestPositionSeq)
        val newest = pagePosition(persisted.newestPositionAt, persisted.newestPositionSeq)
        val epoch = persisted.epoch?.takeIf { it >= 0 }
        return createState(sessionId)
            .withMessages(MessageMerge.mergeMessages(emptyList(), restored))
            .copy(
                hasMore = persisted.hasMore,
                oldestPosition = oldest,
                newestPosition = newest,
                epoch = epoch,
                requiresLatestReset = persisted.messages.isNotEmpty() && (newest == null || epoch == null),
            )
    }

    // ---------------------------------------------------------------- seed --

    /**
     * Seed a fresh window from another session's (web
     * `seedMessageWindowFromSession`) — resume/reopen may hand back a
     * different session id; the old rows render instantly while
     * `requiresLatestReset` forces a fresh latest page underneath. Cursor
     * epoch and newest position are NOT carried over.
     */
    fun seededState(source: MessageWindowState, target: MessageWindowState): MessageWindowState =
        createState(target.sessionId)
            .withMessages(source.messages.toList())
            .copy(
                hasMore = source.hasMore,
                tailRevision = source.tailRevision,
                oldestPosition = source.oldestPosition,
                requiresLatestReset = true,
                syncGeneration = target.syncGeneration + 1,
                olderGeneration = target.olderGeneration + 1,
            )
}
