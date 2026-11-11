import Foundation
import HapiProtocol

/// What the chat screen renders — mirror of the web `useMessages` return
/// shape (and the Android port's `MessageWindowUiState`); cursor/generation
/// internals stay off the render path. `Equatable` compares rows by identity
/// (see ``WindowMessage``), which is exactly the change signal the web uses.
public struct MessageWindowUIState: Equatable, Sendable {
    public let messages: [WindowMessage]
    public let hasMore: Bool
    public let isSyncingTail: Bool
    public let isLoadingMore: Bool
    public let warning: String?
    public let viewMode: MessageViewMode
    public let messagesVersion: Int
    public let historyVersion: Int
    public let tailRevision: Int
}

extension MessageWindowState {
    public var uiState: MessageWindowUIState {
        MessageWindowUIState(
            messages: messages,
            hasMore: hasMore,
            isSyncingTail: isSyncingTail,
            isLoadingMore: isLoadingMore,
            warning: warning,
            viewMode: viewMode,
            messagesVersion: messagesVersion,
            historyVersion: historyVersion,
            tailRevision: tailRevision
        )
    }
}

/// Non-transport failure of the tail-sync loop.
struct MessageWindowSyncError: Error, LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }

    /// Protocol violation guard: `nextAfter` did not advance past the cursor.
    static let cursorDidNotAdvance = MessageWindowSyncError(
        message: "Message tail cursor did not advance"
    )
}

/// Per-session message window orchestration — the async half of the web
/// reference `web/src/lib/message-window-store.ts`, driving the pure
/// transitions in `MessageWindowLogic` over actor-isolated state. Mirrors
/// the Android port's `MessageWindowStore` (`core/data/.../store/`).
///
/// Concurrency model: the web store is single-threaded JS whose interleaving
/// points are its `await`s; here every synchronous read-modify-write segment
/// between transport calls runs on the actor, and the generation counters +
/// request-baseline identity checks (ported as-is) handle whatever
/// interleaves across the provider calls — which suspend the actor. Tail
/// syncs are single-flight per session with an optional trailing re-run,
/// exactly like the web `TailSyncController`.
public actor MessageWindowController {
    /// Immutable and Sendable — same-module callers may read it without
    /// `await` (SE-0306); cross-module callers go through the actor.
    public let sessionId: String
    private let provider: any MessagesProviding
    private let snapshots: WindowSnapshotStore?
    private let historyRetentionLimit: Int

    private var stateValue: MessageWindowState
    private var observers: [UUID: AsyncStream<MessageWindowState>.Continuation] = [:]

    // MARK: - Lifecycle

    public init(
        sessionId: String,
        provider: any MessagesProviding,
        snapshots: WindowSnapshotStore? = nil,
        initialState: MessageWindowState? = nil,
        historyRetentionLimit: Int = MessageWindowConstants.historyWindowSize
    ) {
        self.sessionId = sessionId
        self.provider = provider
        self.snapshots = snapshots
        self.historyRetentionLimit = historyRetentionLimit
        self.stateValue = initialState ?? MessageWindowLogic.createState(sessionId: sessionId)
        self.stateValue.historyRetentionLimit = historyRetentionLimit
    }

    /// The full window state (UI projects what it needs; see
    /// ``MessageWindowState/uiState``).
    public var state: MessageWindowState { stateValue }

    /// Stream of state changes, starting with the current state. Change
    /// detection is instance-based (identity-`Equatable` rows), like the
    /// web's `next !== previous` publication gate.
    public func states() -> AsyncStream<MessageWindowState> {
        let (stream, continuation) = AsyncStream.makeStream(of: MessageWindowState.self)
        let id = UUID()
        observers[id] = continuation
        continuation.yield(stateValue)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeObserver(id) }
        }
        return stream
    }

    private func removeObserver(_ id: UUID) {
        observers.removeValue(forKey: id)
    }

    @discardableResult
    private func update(
        _ transform: (MessageWindowState) -> MessageWindowState
    ) -> MessageWindowState {
        let previous = stateValue
        var next = transform(previous)
        next.historyRetentionLimit = historyRetentionLimit
        stateValue = next
        if next != previous {
            for continuation in observers.values {
                continuation.yield(next)
            }
        }
        return next
    }

    // MARK: - Tail controller

    private var runSerial = 0
    private var runningTask: Task<Void, Never>?
    private var runningRunId: Int?
    private var runningPrefersLatest = false
    private var runningPendingRecovery = false
    private var trailingRequested = false
    /// Bumped by ``clear()``/``seedFrom(_:)`` so a finished run stops
    /// chaining trailing runs (web: controller replacement).
    private var controllerEpoch = 0

    /// Run (or join) a tail sync (web `syncTailMessages`). With
    /// `ensureAfterCurrent` the call drains: if a run is already in flight, a
    /// trailing run is requested and awaited, so the caller returns only
    /// after a sync that STARTED at or after this call.
    public func syncTail(ensureAfterCurrent: Bool = false, allowingHistoryReset: Bool = false) async {
        if allowingHistoryReset {
            let epoch = controllerEpoch
            if let runningTask { await runningTask.value }
            guard epoch == controllerEpoch, !Task.isCancelled else { return }
            await startTailSync(allowingHistoryReset: true).value
            return
        }
        guard let running = runningTask, let runningId = runningRunId else {
            await startTailSync().value
            return
        }
        if stateValue.preferLatestOnActivation || stateValue.pendingGapRecovery {
            // A running sync snapshotted its mode at start; a newly requested
            // latest reconciliation (cached re-entry or gap recovery) must not
            // let that older run commit a plain cursor merge or a full
            // replacement over it.
            if runningPrefersLatest && !stateValue.pendingGapRecovery {
                await running.value
                return
            }
            if runningPendingRecovery && stateValue.pendingGapRecovery {
                await running.value
                return
            }
            trailingRequested = false
            await startTailSync().value
            return
        }
        guard ensureAfterCurrent else {
            await running.value
            return
        }
        trailingRequested = true
        await drainTailSync(observedRunId: runningId, observed: running)
    }

    private var defersHistoryReset: Bool {
        stateValue.viewMode == .history && stateValue.requiresLatestReset && stateValue.epoch != nil
    }

    private func startTailSync(allowingHistoryReset: Bool = false) -> Task<Void, Never> {
        runSerial += 1
        let runId = runSerial
        let epoch = controllerEpoch
        let prefersLatest = stateValue.preferLatestOnActivation
        // Synchronous generation bump: the web executes `runTailSync` to its
        // first true suspension (the api call) before `startTailSync`
        // returns, and the Android port replicates that with an UNDISPATCHED
        // coroutine start. Here `beginTailSync` lands before the Task is even
        // created, so an in-flight run this one replaces can never commit
        // another page in between.
        update { MessageWindowLogic.beginTailSync($0) }
        let generation = stateValue.syncGeneration
        let task = Task { [weak self] in
            guard let self else { return }
            await self.runTailSync(generation: generation, allowingHistoryReset: allowingHistoryReset)
            // Completion bookkeeping is the run's LAST actor-isolated act, so
            // anyone resuming from `await task.value` observes the trailing
            // handoff already done (web: `finish` runs via .then before
            // external awaiters).
            await self.tailSyncRunCompleted(runId: runId, epoch: epoch)
        }
        runningTask = task
        runningRunId = runId
        runningPrefersLatest = prefersLatest
        runningPendingRecovery = stateValue.pendingGapRecovery
        return task
    }

    private func tailSyncRunCompleted(runId: Int, epoch: Int) {
        guard controllerEpoch == epoch, runningRunId == runId else { return }
        runningTask = nil
        runningRunId = nil
        runningPrefersLatest = false
        runningPendingRecovery = false
        guard trailingRequested else { return }
        trailingRequested = false
        _ = startTailSync()
    }

    /// Web `waitForTailSyncDrain`: follow the chain until no newer run exists.
    private func drainTailSync(observedRunId: Int, observed: Task<Void, Never>) async {
        let epoch = controllerEpoch
        var currentId = observedRunId
        var current = observed
        while true {
            await current.value
            guard controllerEpoch == epoch else { return }
            guard let nextTask = runningTask, let nextId = runningRunId, nextId != currentId else {
                return
            }
            currentId = nextId
            current = nextTask
        }
    }

    private func isCurrentTailSync(_ generation: Int) -> Bool {
        stateValue.syncGeneration == generation
    }

    /// Body of one tail sync (web `runTailSync`, minus `beginTailSync`,
    /// which ``startTailSync()`` already executed synchronously).
    private func runTailSync(generation: Int, allowingHistoryReset: Bool) async {
        do {
            let initial = stateValue
            let initialCursor = initial.newestPosition
            let preferLatestOnActivation = initial.preferLatestOnActivation
            let pendingGapRecovery = initial.pendingGapRecovery
            let canIncrement = initialCursor != nil
                && initial.epoch != nil
                && !initial.requiresLatestReset
                // A pending gap recovery must run its cursor catch-up even
                // when a cached activation asked for a direct latest page: the
                // activation shortcut fetches only the newest rows and leaves
                // the interval between the cached tail and the page
                // unreachable below the advanced newest cursor.
                && (!preferLatestOnActivation || pendingGapRecovery)

            if canIncrement && preferLatestOnActivation {
                // The recovery's catch-up + latest-page reconciliation
                // subsumes the cached-activation refresh. Defer the activation
                // shortcut for this run: left set, it would force-break the
                // catch-up loop after its first chunk.
                update { previous in
                    guard previous.syncGeneration == generation else { return previous }
                    var next = previous
                    next.preferLatestOnActivation = false
                    return next
                }
            }

            if !canIncrement {
                let requestBaseline = baseline()
                let latestPageSize = initial.requiresLatestReset || pendingGapRecovery || initialCursor != nil
                    ? MessageWindowConstants.pageSize
                    : MessageWindowConstants.initialPageSize
                let response = try await provider.messages(
                    sessionId: sessionId,
                    query: .latest(limit: latestPageSize)
                )
                guard isCurrentTailSync(generation) else { return }
                // A replay gap may have hidden messages-invalidated. Keep a
                // truncated reading window only after checking the server's
                // epoch, never by skipping the request (or its trailing run).
                if !allowingHistoryReset, defersHistoryReset,
                   !response.page.reset, response.page.epoch == stateValue.epoch {
                    finishTailSync(generation: generation, warning: nil)
                    return
                }
                update { previous in
                    guard previous.syncGeneration == generation else { return previous }
                    var next = MessageWindowLogic.applyLatestResponse(
                        previous,
                        responseMessages: windowMessages(response),
                        page: response.page,
                        replaceServerRows: initial.requiresLatestReset
                            || (preferLatestOnActivation && !pendingGapRecovery)
                            || response.page.reset,
                        requestBaseline: requestBaseline
                    )
                    next.preferLatestOnActivation = false
                    next.pendingGapRecovery = false
                    return next
                }
                finishTailSync(generation: generation, warning: nil)
                return
            }

            var after = initialCursor!
            var until: MessagePosition?
            var catchUpReset = false
            while true {
                let requestBaseline = baseline()
                let response = try await provider.messages(
                    sessionId: sessionId,
                    query: .after(
                        afterAt: after.at,
                        afterSeq: after.seq,
                        untilAt: until?.at,
                        untilSeq: until?.seq,
                        epoch: initial.epoch!,
                        limit: MessageWindowConstants.pageSize
                    )
                )
                guard isCurrentTailSync(generation) else { return }

                if response.page.reset || response.page.direction == .latest {
                    update { previous in
                        guard previous.syncGeneration == generation else { return previous }
                        var next = MessageWindowLogic.applyLatestResponse(
                            previous,
                            responseMessages: windowMessages(response),
                            page: response.page,
                            replaceServerRows: true,
                            requestBaseline: requestBaseline
                        )
                        next.pendingGapRecovery = false
                        next.preferLatestOnActivation = false
                        return next
                    }
                    catchUpReset = true
                    break
                }

                let nextAfter = MessageWindowLogic.pagePosition(
                    at: response.page.nextAfterAt,
                    seq: response.page.nextAfterSeq
                )
                let snapshotHead = MessageWindowLogic.pagePosition(
                    at: response.page.snapshotHeadAt,
                    seq: response.page.snapshotHeadSeq
                )
                if until == nil {
                    until = snapshotHead
                }

                update { previous in
                    guard previous.syncGeneration == generation else { return previous }
                    return MessageWindowLogic.applyAfterPage(
                        previous,
                        responseMessages: windowMessages(response),
                        page: response.page,
                        nextAfter: nextAfter
                    )
                }

                let current = stateValue
                if current.requiresLatestReset
                    || current.preferLatestOnActivation
                    || !response.page.hasMore
                    || nextAfter == nil {
                    break
                }
                if nextAfter! <= after {
                    throw MessageWindowSyncError.cursorDidNotAdvance
                }
                after = nextAfter!
            }

            if pendingGapRecovery {
                if catchUpReset {
                    // A reset verdict already replaced the window
                    // authoritatively under the server's epoch; there is
                    // nothing left to refresh.
                    update { previous in
                        guard previous.syncGeneration == generation else { return previous }
                        var next = previous
                        next.pendingGapRecovery = false
                        next.preferLatestOnActivation = false
                        return next
                    }
                } else if stateValue.requiresLatestReset {
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
                    // newest cursor. On a catch-up failure the catch below
                    // skips this block, the original cursor and the flag
                    // survive, and the next sync retries the whole recovery.
                    let requestBaseline = baseline()
                    let response = try await provider.messages(
                        sessionId: sessionId,
                        query: .latest(limit: MessageWindowConstants.pageSize)
                    )
                    guard isCurrentTailSync(generation) else { return }
                    update { previous in
                        guard previous.syncGeneration == generation else { return previous }
                        // The trim honors the window's loaded history budget
                        // (web `4d1d9e2025`): a no-news reconnect never evicts
                        // rows the reader already had.
                        let trimLimit = min(
                            MessageWindowConstants.olderLoadWindowSize,
                            max(MessageWindowConstants.visibleWindowSize, previous.messages.count)
                        )
                        var next = MessageWindowLogic.applyLatestResponse(
                            previous,
                            responseMessages: windowMessages(response),
                            page: response.page,
                            replaceServerRows: response.page.reset
                                || (previous.epoch != nil && response.page.epoch != previous.epoch),
                            requestBaseline: requestBaseline,
                            trimLimit: trimLimit
                        )
                        next.pendingGapRecovery = false
                        next.preferLatestOnActivation = false
                        return next
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
                    let pageOldest = MessageWindowLogic.pagePosition(
                        at: response.page.nextBeforeAt,
                        seq: response.page.nextBeforeSeq
                    )
                    if let pageOldest {
                        let candidates = stateValue.messages.compactMap { message -> (position: MessagePosition, message: WindowMessage)? in
                            guard let position = MessageWindowLogic.messagePosition(message) else { return nil }
                            if position >= pageOldest { return nil }
                            if let initialCursor, position > initialCursor { return nil }
                            guard isNonTerminalToolCallRow(message) else { return nil }
                            return (position, message)
                        }
                        .sorted { $0.position > $1.position }
                        .prefix(MessageWindowConstants.gapRowRefreshLimit)
                        for (_, candidate) in candidates {
                            // A failed refresh propagates to the catch below
                            // and surfaces the usual warning; the row stays
                            // as is and the next sync retries the sweep.
                            let context = try await provider.messageContext(
                                sessionId: sessionId,
                                messageId: candidate.id
                            )
                            guard isCurrentTailSync(generation) else { return }
                            let refreshed = context?.messages.first(where: { $0.id == candidate.id })
                            if refreshed == nil {
                                // The row is no longer reachable through the
                                // context endpoint: leave it as is and finish
                                // the run's bookkeeping — an early return
                                // here would leave the window marked
                                // syncing.
                                finishTailSync(generation: generation, warning: "Failed to refresh a merged tool call")
                                return
                            }
                            if context!.page.epoch != stateValue.epoch {
                                // The refresh answered under a different
                                // epoch: server rows may have been deleted
                                // since the page was fetched. Mark the window
                                // for the authoritative replacement instead
                                // of reconciling against a stale snapshot,
                                // and finish the run's bookkeeping.
                                update { previous in
                                    guard previous.syncGeneration == generation else { return previous }
                                    var next = previous
                                    next.requiresLatestReset = true
                                    return next
                                }
                                finishTailSync(generation: generation, warning: "Failed to refresh a merged tool call")
                                return
                            }
                            update { previous in
                                guard previous.syncGeneration == generation else { return previous }
                                return MessageWindowLogic.mergeRefreshedRow(previous, WindowMessage(wire: refreshed!))
                            }
                        }
                    }
                }
            }

            finishTailSync(generation: generation, warning: nil)
        } catch {
            guard isCurrentTailSync(generation) else { return }
            finishTailSync(
                generation: generation,
                warning: Self.warningMessage(error, fallback: "Failed to synchronize messages")
            )
        }
    }

    private func finishTailSync(generation: Int, warning: String?) {
        update { MessageWindowLogic.finishTailSync($0, generation: generation, warning: warning) }
        persist()
    }

    // MARK: - Older pages

    /// Load one older page (web `fetchOlderMessages`). On an epoch mismatch
    /// the window is invalidated and a full tail sync (`ensureAfterCurrent`)
    /// runs before the `stopped/epoch-reset` outcome is returned.
    /// `onBeforeApply` runs synchronously inside the state transition (mirror
    /// of the web's synchronous updater) — it must not call back into this
    /// controller.
    public func fetchOlder(
        onBeforeApply: (@Sendable (Int) -> Bool)? = nil
    ) async -> OlderLoadOutcome {
        let initial = stateValue
        switch MessageWindowLogic.olderLoadPrecheck(initial) {
        case .stop(let reason):
            return .stopped(reason)
        case .proceed(let before):
            let generation = initial.olderGeneration + 1
            update { MessageWindowLogic.beginOlderLoad($0, generation: generation) }
            do {
                let response = try await provider.messages(
                    sessionId: sessionId,
                    query: .before(
                        beforeAt: before.at,
                        beforeSeq: before.seq,
                        limit: MessageWindowConstants.pageSize
                    )
                )
                guard stateValue.olderGeneration == generation else {
                    return .stopped(.invalidated)
                }
                guard !Task.isCancelled else {
                    update { MessageWindowLogic.cancelOlderLoad($0) }
                    return .stopped(.invalidated)
                }

                if let epoch = initial.epoch, response.page.epoch != epoch {
                    update { MessageWindowLogic.applyOlderEpochMismatch($0, generation: generation) }
                    await syncTail(ensureAfterCurrent: true)
                    return .stopped(.epochReset)
                }

                if response.page.hasMore {
                    let at = response.page.nextBeforeAt
                    let seq = response.page.nextBeforeSeq
                    guard let at, let seq, MessagePosition(at: at, seq: seq) < before else {
                        update { MessageWindowLogic.failOlderLoad($0, generation: generation,
                            warning: "Message history cursor did not advance") }
                        return .stopped(.cursorDidNotAdvance)
                    }
                }
                var historyVersion = 0
                var addedRenderableCount = 0
                var applyRejected = false
                update { previous in
                    guard previous.olderGeneration == generation else { return previous }
                    let incoming = windowMessages(response)
                    addedRenderableCount = MessageWindowLogic.countNewRenderableMessages(
                        previous,
                        incoming: incoming
                    )
                    let nextHistoryVersion = previous.historyVersion + 1
                    if let onBeforeApply, !onBeforeApply(nextHistoryVersion) {
                        applyRejected = true
                        return MessageWindowLogic.rejectOlderApply(previous)
                    }
                    historyVersion = nextHistoryVersion
                    return MessageWindowLogic.applyOlderResponse(
                        previous,
                        responseMessages: incoming,
                        page: response.page,
                        historyVersion: nextHistoryVersion
                    )
                }
                if applyRejected || historyVersion == 0 {
                    return .stopped(.invalidated)
                }
                persist()
                return .applied(
                    historyVersion: historyVersion,
                    hasMore: response.page.hasMore,
                    addedRenderableCount: addedRenderableCount
                )
            } catch {
                guard stateValue.olderGeneration == generation else {
                    return .stopped(.invalidated)
                }
                if Task.isCancelled || error is CancellationError {
                    update { MessageWindowLogic.cancelOlderLoad($0) }
                    return .stopped(.invalidated)
                }
                update {
                    MessageWindowLogic.failOlderLoad(
                        $0,
                        generation: generation,
                        warning: Self.warningMessage(error, fallback: "Failed to load older messages")
                    )
                }
                return .failed(error)
            }
        }
    }

    public func cancelOlderLoad() {
        update { MessageWindowLogic.cancelOlderLoad($0) }
    }

    // MARK: - SSE ingest

    /// Route one message-stream SSE event into this window. The caller
    /// routes per session already; the guard is defensive — a foreign
    /// session's rows must never corrupt this window.
    /// `messages-invalidated` clears the window and starts a fresh tail
    /// sync; `scheduled-matured` re-syncs so the released row (and its
    /// consumption) lands even if the `message-received` frame was missed.
    public func onMessageEvent(_ event: SyncEvent) {
        switch event {
        case .messageReceived(_, let eventSessionId, let message) where eventSessionId == sessionId:
            ingestSSEMessages([WindowMessage(wire: message)])
        case .messagesConsumed(_, let eventSessionId, let localIds, let invokedAt)
            where eventSessionId == sessionId:
            markConsumed(localIds: localIds, invokedAt: invokedAt)
        case .messagesIndeterminate(_, let eventSessionId, let localIds)
            where eventSessionId == sessionId:
            markIndeterminate(localIds: localIds)
        case .messagesRequeued(_, let eventSessionId, let localIds)
            where eventSessionId == sessionId:
            markRequeued(localIds: localIds)
        case .messageCancelled(_, let eventSessionId, let messageId, _) where eventSessionId == sessionId:
            removeMessage(localIdOrId: messageId)
        case .messagesInvalidated(_, let eventSessionId) where eventSessionId == sessionId:
            clear()
            Task { await self.syncTail() }
        case .scheduledMatured(_, let eventSessionId) where eventSessionId == sessionId:
            Task { await self.syncTail(ensureAfterCurrent: true) }
        default:
            break
        }
    }

    /// SSE `message-received` ingest (web `ingestIncomingMessages`).
    public func ingestSSEMessages(_ messages: [WindowMessage]) {
        guard !messages.isEmpty else { return }
        update { MessageWindowLogic.ingestIncoming($0, incoming: messages) }
        persist()
    }

    /// SSE `messages-consumed` (web `markMessagesConsumed`).
    public func markConsumed(localIds: [String], invokedAt: Int) {
        guard !localIds.isEmpty else { return }
        update { MessageWindowLogic.markConsumed($0, localIds: localIds, invokedAt: invokedAt) }
        persist()
    }

    public func markIndeterminate(localIds: [String]) {
        update { MessageWindowLogic.markIndeterminate($0, localIds: localIds) }
        persist()
    }

    public func markRequeued(localIds: [String]) {
        update { MessageWindowLogic.markRequeued($0, localIds: localIds) }
        persist()
    }

    /// SSE `message-cancelled` / optimistic DELETE removal
    /// (web `removeOptimisticMessage`).
    public func removeMessage(localIdOrId: String) {
        update { MessageWindowLogic.removeByLocalIdOrId($0, localId: localIdOrId) }
        persist()
    }

    // MARK: - Optimistic sends

    /// Append a pre-built optimistic row (web `appendOptimisticMessage`).
    public func appendOptimistic(_ message: WindowMessage) {
        update { MessageWindowLogic.appendOptimistic($0, message: message) }
        persist()
    }

    /// Append the standard optimistic row for a send
    /// (`useSendMessage.createOptimisticMessage`): status `sending` until the
    /// POST settles, then ``updateStatus(localId:status:)`` to
    /// `queued`/`sent`/`failed`.
    public func appendOptimistic(
        localId: String,
        text: String,
        attachments: [AttachmentMetadata]? = nil,
        scheduledAt: Int? = nil,
        deliveryMode: String = "queue",
        createdAt: Int = Int(Date().timeIntervalSince1970 * 1000)
    ) {
        appendOptimistic(
            buildOptimisticMessage(
                localId: localId,
                text: text,
                createdAt: createdAt,
                attachments: attachments,
                scheduledAt: scheduledAt,
                deliveryMode: deliveryMode,
                status: .sending
            )
        )
    }

    public func updateStatus(localId: String, status: MessageStatus) {
        update { MessageWindowLogic.updateStatus($0, localId: localId, status: status) }
        persist()
    }

    /// A cancel DELETE answered `{"status":"invoked"}` — too late, the agent
    /// consumed the row. Remove the queued snapshot and ingest the returned
    /// authoritative row as `sent` (web `useCancelQueuedMessage`).
    public func applyCancelInvoked(localId: String, message: WindowMessage) {
        removeMessage(localIdOrId: localId)
        appendOptimistic(message.withStatus(.sent))
    }

    // MARK: - Queued reconciliation

    public func queuedReconcileCandidateLocalIds() -> [String] {
        MessageWindowLogic.queuedReconcileCandidateLocalIds(stateValue)
    }

    public func reconcileQueuedLocalIds(candidateLocalIds: [String], queuedLocalIds: [String]) {
        update {
            MessageWindowLogic.reconcileQueuedLocalIds(
                $0,
                candidateLocalIds: candidateLocalIds,
                queuedLocalIds: queuedLocalIds
            )
        }
        persist()
    }

    /// One gap-recovery step for a session message window (web
    /// `recoverWindowAfterGapResume`).
    ///
    /// A resumed-with-gap connection (`resume: 'gap'`) cannot prove
    /// continuity, and in-place row updates (merged tool-call ticks) keep the
    /// row's original cursor position, so a plain cursor sync re-delivers new
    /// rows but never the merged content of rows the window already holds.
    /// Flag the window and let the next tail sync run the full recovery: the
    /// cursor catch-up pulls every row the window missed, then an
    /// authoritative latest page is applied as an upsert — rows present in
    /// the page are replaced by id while already-loaded rows older than the
    /// latest page and the hasMore/oldest cursor survive. A failed catch-up
    /// keeps the flag and the original cursor, so the next sync retries the
    /// whole recovery. Cold or structurally invalidated windows have nothing
    /// to preserve and keep the plain reset choreography.
    public func recoverAfterGapResume() async {
        let previous = stateValue
        if previous.requiresLatestReset || previous.newestPosition == nil || previous.epoch == nil {
            await syncTail()
            return
        }
        update { state in
            var next = state
            next.pendingGapRecovery = true
            return next
        }
        await syncTail()
    }

    /// Queued-state recovery after a `resume: 'gap'` reconnect (port of
    /// `web/src/lib/queued-state-reconciliation.ts`): tail-sync to the drain,
    /// collect candidates, ask the hub for the verdict in ≤1000-id batches,
    /// stamp invoked rows like `messages-consumed`, drop deleted candidates.
    /// The window's gap recovery (``recoverAfterGapResume()``) is a separate
    /// step the session layer runs first (web wires the two the same way).
    public func reconcileQueuedState() async throws {
        await syncTail(ensureAfterCurrent: true)
        let candidateLocalIds = queuedReconcileCandidateLocalIds()
        guard !candidateLocalIds.isEmpty else { return }
        var queuedLocalIds: [String] = []
        var indeterminateLocalIds: [String] = []
        var invokedLocalMessages: [(localId: String, invokedAt: Int)] = []
        var start = 0
        while start < candidateLocalIds.count {
            let end = min(start + Self.queuedStateBatchSize, candidateLocalIds.count)
            let batch = Array(candidateLocalIds[start..<end])
            let response = try await provider.queuedState(sessionId: sessionId, localIds: batch)
            queuedLocalIds += response.queuedLocalIds
            indeterminateLocalIds += response.indeterminateLocalIds ?? []
            invokedLocalMessages += response.invokedLocalMessages.map { ($0.localId, $0.invokedAt) }
            start = end
        }
        var timestamps: [Int] = []
        var localIdsByTimestamp: [Int: [String]] = [:]
        for (localId, invokedAt) in invokedLocalMessages {
            if localIdsByTimestamp[invokedAt] == nil { timestamps.append(invokedAt) }
            localIdsByTimestamp[invokedAt, default: []].append(localId)
        }
        for invokedAt in timestamps {
            markConsumed(localIds: localIdsByTimestamp[invokedAt]!, invokedAt: invokedAt)
        }
        markIndeterminate(localIds: indeterminateLocalIds)
        reconcileQueuedLocalIds(candidateLocalIds: candidateLocalIds, queuedLocalIds: queuedLocalIds + indeterminateLocalIds)
    }

    // MARK: - Lifecycle transitions

    /// Switch view mode (web `setMessageViewMode`); tail re-entry trims.
    public func setViewMode(_ mode: MessageViewMode) {
        update { MessageWindowLogic.setViewMode($0, mode: mode) }
        persist()
    }

    /// Session (re-)activation (web `activateMessageWindow`): trims back to
    /// the visible window and, with usable persisted state, requests a
    /// fresh-latest trailing run from an in-flight sync.
    public func activate() {
        var requestedLatest = false
        update { previous in
            let activation = MessageWindowLogic.activate(previous)
            requestedLatest = activation.requestedLatest
            return activation.state
        }
        if requestedLatest, runningTask != nil {
            trailingRequested = true
        }
    }

    /// Web `clearMessageWindow`: forget everything but keep generations
    /// poisoned so in-flight work cannot commit.
    public func clear() {
        controllerEpoch += 1
        runningTask = nil
        runningRunId = nil
        runningPrefersLatest = false
        trailingRequested = false
        snapshots?.delete(sessionId: sessionId)
        update { previous in
            var next = MessageWindowLogic.createState(sessionId: sessionId)
            next.syncGeneration = previous.syncGeneration + 1
            next.olderGeneration = previous.olderGeneration + 1
            return next
        }
    }

    /// Seed this window from another session's (web
    /// `seedMessageWindowFromSession`) — resume/reopen can hand back a new
    /// session id; the old rows render instantly and `requiresLatestReset`
    /// forces a fresh latest page underneath.
    public func seedFrom(_ source: MessageWindowController) async {
        guard source.sessionId != sessionId else { return }
        controllerEpoch += 1
        runningTask = nil
        runningRunId = nil
        runningPrefersLatest = false
        trailingRequested = false
        let sourceState = await source.state
        update { MessageWindowLogic.seededState(source: sourceState, target: $0) }
        persist()
    }

    // MARK: - Internals

    private static let queuedStateBatchSize = 1000

    /// Identity baseline of the current rows, keyed by id
    /// (web `requestBaseline`; duplicate ids cannot occur post-merge, but a
    /// JS `Map` keeps the last insertion — mirrored here).
    private func baseline() -> [String: WindowMessage] {
        Dictionary(
            stateValue.messages.map { ($0.id, $0) },
            uniquingKeysWith: { _, last in last }
        )
    }

    private nonisolated func windowMessages(_ response: MessagesResponse) -> [WindowMessage] {
        response.messages.map { WindowMessage(wire: $0) }
    }

    /// A cached tool-call row that can still be enriched in place: its
    /// payload is a live `tool-call` whose merged status has not reached a
    /// terminal tier. Terminal rows are done; unknown or missing status
    /// reads as pending.
    private nonisolated func isNonTerminalToolCallRow(_ message: WindowMessage) -> Bool {
        guard case .object(let envelope) = message.content else { return false }
        guard case .string(let role) = envelope["role"] ?? .null, role == "agent" else { return false }
        guard case .object(let payload) = envelope["content"] ?? .null else { return false }
        guard case .string(let payloadType) = payload["type"] ?? .null,
              payloadType == agentMessagePayloadType else { return false }
        guard case .object(let data) = payload["data"] ?? .null else { return false }
        guard case .string(let dataType) = data["type"] ?? .null, dataType == "tool-call" else { return false }
        guard case .string(let status) = data["status"] ?? .null else { return true }
        return status != "completed" && status != "failed"
    }

    private func persist() {
        guard let snapshots else { return }
        let state = stateValue
        if MessageWindowLogic.shouldPersist(state) {
            snapshots.save(sessionId: sessionId, snapshot: MessageWindowLogic.toPersisted(state))
        } else {
            snapshots.delete(sessionId: sessionId)
        }
    }

    private static func warningMessage(_ error: any Error, fallback: String) -> String {
        (error as? LocalizedError)?.errorDescription ?? fallback
    }
}
