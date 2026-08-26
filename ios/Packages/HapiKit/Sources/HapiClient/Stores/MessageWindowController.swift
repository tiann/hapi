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

    private var stateValue: MessageWindowState
    private var observers: [UUID: AsyncStream<MessageWindowState>.Continuation] = [:]

    // MARK: - Lifecycle

    public init(
        sessionId: String,
        provider: any MessagesProviding,
        snapshots: WindowSnapshotStore? = nil,
        initialState: MessageWindowState? = nil
    ) {
        self.sessionId = sessionId
        self.provider = provider
        self.snapshots = snapshots
        self.stateValue = initialState ?? MessageWindowLogic.createState(sessionId: sessionId)
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
        let next = transform(previous)
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
    private var trailingRequested = false
    /// Bumped by ``clear()``/``seedFrom(_:)`` so a finished run stops
    /// chaining trailing runs (web: controller replacement).
    private var controllerEpoch = 0

    /// Run (or join) a tail sync (web `syncTailMessages`). With
    /// `ensureAfterCurrent` the call drains: if a run is already in flight, a
    /// trailing run is requested and awaited, so the caller returns only
    /// after a sync that STARTED at or after this call.
    public func syncTail(ensureAfterCurrent: Bool = false) async {
        guard let running = runningTask, let runningId = runningRunId else {
            await startTailSync().value
            return
        }
        if stateValue.preferLatestOnActivation {
            if runningPrefersLatest {
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

    private func startTailSync() -> Task<Void, Never> {
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
            await self.runTailSync(generation: generation)
            // Completion bookkeeping is the run's LAST actor-isolated act, so
            // anyone resuming from `await task.value` observes the trailing
            // handoff already done (web: `finish` runs via .then before
            // external awaiters).
            await self.tailSyncRunCompleted(runId: runId, epoch: epoch)
        }
        runningTask = task
        runningRunId = runId
        runningPrefersLatest = prefersLatest
        return task
    }

    private func tailSyncRunCompleted(runId: Int, epoch: Int) {
        guard controllerEpoch == epoch, runningRunId == runId else { return }
        runningTask = nil
        runningRunId = nil
        runningPrefersLatest = false
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
    private func runTailSync(generation: Int) async {
        do {
            let initial = stateValue
            let initialCursor = initial.newestPosition
            let preferLatestOnActivation = initial.preferLatestOnActivation
            let canIncrement = initialCursor != nil
                && initial.epoch != nil
                && !initial.requiresLatestReset
                && !preferLatestOnActivation

            if !canIncrement {
                let requestBaseline = baseline()
                let response = try await provider.messages(
                    sessionId: sessionId,
                    query: .latest(limit: MessageWindowConstants.pageSize)
                )
                guard isCurrentTailSync(generation) else { return }
                update { previous in
                    guard previous.syncGeneration == generation else { return previous }
                    var next = MessageWindowLogic.applyLatestResponse(
                        previous,
                        responseMessages: windowMessages(response),
                        page: response.page,
                        replaceServerRows: initial.requiresLatestReset
                            || preferLatestOnActivation
                            || response.page.reset,
                        requestBaseline: requestBaseline
                    )
                    next.preferLatestOnActivation = false
                    return next
                }
                finishTailSync(generation: generation, warning: nil)
                return
            }

            var after = initialCursor!
            var until: MessagePosition?
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
                        return MessageWindowLogic.applyLatestResponse(
                            previous,
                            responseMessages: windowMessages(response),
                            page: response.page,
                            replaceServerRows: true,
                            requestBaseline: requestBaseline
                        )
                    }
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

                if let epoch = initial.epoch, response.page.epoch != epoch {
                    update { MessageWindowLogic.applyOlderEpochMismatch($0, generation: generation) }
                    await syncTail(ensureAfterCurrent: true)
                    return .stopped(.epochReset)
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

    /// Queued-state recovery after a `resume: 'gap'` reconnect (port of
    /// `web/src/lib/queued-state-reconciliation.ts`): tail-sync to the drain,
    /// collect candidates, ask the hub for the verdict in ≤1000-id batches,
    /// stamp invoked rows like `messages-consumed`, drop deleted candidates.
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
