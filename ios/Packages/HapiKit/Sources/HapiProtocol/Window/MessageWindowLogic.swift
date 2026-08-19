import Foundation

/// Pure state transitions of the message window — a function-for-function
/// port of `web/src/lib/message-window-store.ts` (with the async
/// orchestration stripped out; `HapiClient`'s `MessageWindowController`
/// re-adds it), matching the Android reference port
/// (`window/MessageWindowLogic.kt`) one-to-one. Every function takes the
/// previous ``MessageWindowState`` and returns the next one; nothing here
/// touches clocks, I/O, or tasks, so the whole surface is fixture-comparable.
public enum MessageWindowLogic {

    public enum TrimMode: Sendable {
        case append
        case prepend
    }

    public static func createState(sessionId: String) -> MessageWindowState {
        MessageWindowState(sessionId: sessionId)
    }

    // MARK: - Helpers

    /// Web `buildState`: swap the messages list, re-derive seq bounds, bump
    /// the version. Every call site passes a freshly-built array (the web
    /// counterpart always builds a new array instance too), so the version
    /// bumps unconditionally.
    private static func settingMessages(
        _ previous: MessageWindowState,
        _ messages: [WindowMessage]
    ) -> MessageWindowState {
        var oldestSeq: Int?
        var newestSeq: Int?
        for message in messages {
            guard let seq = message.seq else { continue }
            oldestSeq = oldestSeq.map { min($0, seq) } ?? seq
            newestSeq = newestSeq.map { max($0, seq) } ?? seq
        }
        var next = previous
        next.messages = messages
        next.oldestSeq = oldestSeq
        next.newestSeq = newestSeq
        next.messagesVersion = previous.messagesVersion + 1
        return next
    }

    /// A row's compound position; rows without a server `seq` have none.
    public static func messagePosition(_ message: WindowMessage) -> MessagePosition? {
        guard let seq = message.seq else { return nil }
        return MessagePosition(at: message.positionAt, seq: seq)
    }

    public enum PositionEnd: Sendable {
        case oldest
        case newest
    }

    public static func derivePosition(
        _ messages: [WindowMessage],
        _ end: PositionEnd
    ) -> MessagePosition? {
        var selected: MessagePosition?
        for message in messages {
            guard let candidate = messagePosition(message) else { continue }
            guard let current = selected else {
                selected = candidate
                continue
            }
            if (end == .oldest && candidate < current) || (end == .newest && candidate > current) {
                selected = candidate
            }
        }
        return selected
    }

    /// Pairwise page cursor (`pagePosition` in the web): both halves or nothing.
    public static func pagePosition(at: Int?, seq: Int?) -> MessagePosition? {
        guard let at, let seq else { return nil }
        return MessagePosition(at: at, seq: seq)
    }

    private static func maxPosition(_ a: MessagePosition?, _ b: MessagePosition?) -> MessagePosition? {
        switch (a, b) {
        case (nil, let b): return b
        case (let a, nil): return a
        case (let a?, let b?): return a >= b ? a : b
        }
    }

    // MARK: - Trims

    private struct Trim {
        let kept: [WindowMessage]
        let dropped: [WindowMessage]
    }

    private static func sliceForTrim(
        _ items: [WindowMessage],
        limit: Int,
        mode: TrimMode
    ) -> Trim {
        if items.count <= limit { return Trim(kept: items, dropped: []) }
        if limit <= 0 { return Trim(kept: [], dropped: items) }
        switch mode {
        case .prepend:
            return Trim(
                kept: Array(items[..<limit]),
                dropped: Array(items[limit...])
            )
        case .append:
            return Trim(
                kept: Array(items[(items.count - limit)...]),
                dropped: Array(items[..<(items.count - limit)])
            )
        }
    }

    /// Codex background-agent trace rows (`agent-run-*`) get their own trim
    /// bucket so long traces do not evict chat (web `isCodexAgentRunMessage`).
    public static func isCodexAgentRunMessage(_ message: WindowMessage) -> Bool {
        guard let outer = message.content.objectValue,
              outer["role"]?.stringValue == "agent",
              let payload = outer["content"]?.objectValue,
              payload["type"]?.stringValue == "codex",
              let data = payload["data"]?.objectValue
        else { return false }
        let type = data["type"]?.stringValue
        return type == "agent-run-start" || type == "agent-run-update" || type == "agent-run-trace"
    }

    /// Web `getReasoningStreamId`: the stream a reasoning row belongs to, or
    /// `nil` for anything else. Unrecognised shapes read as `nil`, which means
    /// "keep it".
    private static func reasoningStreamId(_ message: WindowMessage) -> String? {
        guard let outer = message.content.objectValue,
              outer["role"]?.stringValue == "agent",
              let payload = outer["content"]?.objectValue,
              payload["type"]?.stringValue == "codex",
              let data = payload["data"]?.objectValue,
              data["type"]?.stringValue == "reasoning",
              let id = data["id"]?.stringValue,
              !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return id
    }

    /// Web `dropSupersededReasoningSnapshots`: collapse a reasoning stream to
    /// the one snapshot that still says something. The CLI re-sends a growing
    /// buffer under a stable stream id every few hundred milliseconds and the
    /// timeline folds those rows into a single block, so spending window
    /// budget on the older ones is what pushes the surrounding conversation
    /// out of reach. Rows with no stream id are left alone.
    private static func dropSupersededReasoningSnapshots(
        _ messages: [WindowMessage]
    ) -> [WindowMessage] {
        var newestByStream: [String: WindowMessage] = [:]
        for message in messages {
            guard let streamId = reasoningStreamId(message) else { continue }
            guard let incumbent = newestByStream[streamId] else {
                newestByStream[streamId] = message
                continue
            }
            // Fall back to arrival order when either row predates seq
            // numbering: `messages` is kept in display order, so later still
            // means newer.
            let newer: Bool
            if let challengerAt = messagePosition(message),
               let incumbentAt = messagePosition(incumbent) {
                newer = !(challengerAt < incumbentAt)
            } else {
                newer = true
            }
            if newer { newestByStream[streamId] = message }
        }
        if newestByStream.isEmpty { return messages }
        let survivors = Set(newestByStream.values.map(\.id))
        return messages.filter { reasoningStreamId($0) == nil || survivors.contains($0.id) }
    }

    /// Trim to `regularLimit` while never dropping queued rows: superseded
    /// reasoning snapshots are collapsed first, the regular budget shrinks by
    /// the queued count, `agent-run-*` rows trim against their own bucket
    /// (`agentRunWindowSize`), and queued rows are re-merged afterwards (web
    /// `trimPreservingQueued`).
    private static func trimPreservingQueued(
        _ incoming: [WindowMessage],
        regularLimit: Int,
        mode: TrimMode
    ) -> Trim {
        let messages = dropSupersededReasoningSnapshots(incoming)
        let queued = messages.filter(\.isQueuedForInvocation)
        let queuedIds = Set(queued.map(\.id))
        let nonQueued = messages.filter { !queuedIds.contains($0.id) }
        let agentRuns = nonQueued.filter { isCodexAgentRunMessage($0) }
        let regular = nonQueued.filter { !isCodexAgentRunMessage($0) }
        let regularTrim = sliceForTrim(regular, limit: max(0, regularLimit - queued.count), mode: mode)
        let agentRunTrim = sliceForTrim(
            agentRuns,
            limit: MessageWindowConstants.agentRunWindowSize,
            mode: mode
        )
        return Trim(
            kept: MessageMerge.mergeMessages(regularTrim.kept + agentRunTrim.kept, queued),
            dropped: regularTrim.dropped + agentRunTrim.dropped
        )
    }

    // MARK: - Retention

    /// Web `shouldRetainWindowMessage`: queued, or renderable by the chat
    /// pipeline.
    public static func shouldRetainWindowMessage(_ message: WindowMessage) -> Bool {
        message.isQueuedForInvocation || MessageRetention.isRenderable(message.content)
    }

    /// How many of `incoming` would add a NEW renderable row (not already
    /// represented by id or localId) — feeds the `applied` older-load outcome.
    public static func countNewRenderableMessages(
        _ previous: MessageWindowState,
        incoming: [WindowMessage]
    ) -> Int {
        var representedIds = Set(previous.messages.map(\.id))
        var representedLocalIds = Set(previous.messages.compactMap(\.localId))
        var count = 0
        for message in incoming {
            guard shouldRetainWindowMessage(message) else { continue }
            if representedIds.contains(message.id) { continue }
            if let localId = message.localId, representedLocalIds.contains(localId) { continue }
            count += 1
            representedIds.insert(message.id)
            if let localId = message.localId { representedLocalIds.insert(localId) }
        }
        return count
    }

    // MARK: - Merge

    /// Merge `incoming` into the window, trim per mode/limit, and repair
    /// cursors/flags on overflow (web `mergeIntoWindow`): an append-side trim
    /// flips `hasMore` and recomputes the older cursor from the oldest kept
    /// row; a prepend-side trim drops tail rows, so the window no longer
    /// reaches the live bottom — flag `requiresLatestReset` and pull the
    /// newest cursor back to the newest kept row.
    public static func mergeIntoWindow(
        _ previous: MessageWindowState,
        incoming: [WindowMessage],
        mode: TrimMode? = nil,
        regularLimit: Int? = nil,
        advanceTailRevision: Bool = false
    ) -> MessageWindowState {
        let retainedIncoming = incoming.filter { shouldRetainWindowMessage($0) }
        if retainedIncoming.isEmpty {
            return previous
        }
        let effectiveMode = mode
            ?? (previous.viewMode == .history ? .prepend : .append)
        let effectiveLimit = regularLimit
            ?? (previous.viewMode == .history
                ? MessageWindowConstants.historyWindowSize
                : MessageWindowConstants.visibleWindowSize)
        let merged = MessageMerge.mergeMessages(previous.messages, retainedIncoming)
        let trim = trimPreservingQueued(merged, regularLimit: effectiveLimit, mode: effectiveMode)
        var next = settingMessages(previous, trim.kept)
        if advanceTailRevision {
            next.tailRevision = previous.tailRevision + 1
        }
        if trim.dropped.isEmpty {
            return next
        }
        if effectiveMode == .append {
            let oldest = derivePosition(trim.kept, .oldest)
            next.hasMore = true
            next.oldestPosition = oldest ?? next.oldestPosition
            return next
        }
        next.requiresLatestReset = true
        next.newestPosition = derivePosition(trim.kept, .newest)
        return next
    }

    // MARK: - Latest replace

    /// Apply a `latest` page (cold start, activation refresh, or a reset
    /// response). With `replaceServerRows` the page is authoritative: every
    /// server row captured in `requestBaseline` (by **instance identity**) is
    /// discarded, while optimistic rows and rows that changed since the
    /// request left (concurrent SSE) survive the swap (web
    /// `applyLatestResponse`).
    public static func applyLatestResponse(
        _ previous: MessageWindowState,
        responseMessages: [WindowMessage],
        page: MessagesPage,
        replaceServerRows: Bool,
        requestBaseline: [String: WindowMessage]
    ) -> MessageWindowState {
        let retainedResponseMessages = responseMessages.filter { shouldRetainWindowMessage($0) }
        let concurrentServerRows = previous.messages.filter { message in
            !message.isOptimistic && requestBaseline[message.id] !== message
        }
        let preserved = replaceServerRows
            ? previous.messages.filter { message in
                message.isOptimistic || requestBaseline[message.id] !== message
            }
            : previous.messages
        let authoritative = MessageMerge.mergeMessages(preserved, retainedResponseMessages)
        let incoming = MessageMerge.mergeMessages(authoritative, concurrentServerRows)
        let trim = trimPreservingQueued(
            incoming,
            regularLimit: MessageWindowConstants.visibleWindowSize,
            mode: .append
        )
        let snapshotHead = pagePosition(at: page.snapshotHeadAt, seq: page.snapshotHeadSeq)
            ?? derivePosition(responseMessages, .newest)
        let newestKept = derivePosition(trim.kept, .newest)
        let newest = maxPosition(snapshotHead, newestKept)
        let responseOldest = pagePosition(at: page.nextBeforeAt, seq: page.nextBeforeSeq)
        let oldest: MessagePosition?
        if !trim.dropped.isEmpty {
            oldest = derivePosition(trim.kept, .oldest)
        } else if replaceServerRows {
            oldest = responseOldest
        } else {
            oldest = responseOldest ?? previous.oldestPosition
        }
        var next = settingMessages(previous, trim.kept)
        next.hasMore = page.hasMore || (!replaceServerRows && previous.hasMore) || !trim.dropped.isEmpty
        next.epoch = page.epoch
        next.oldestPosition = oldest
        next.newestPosition = newest
        next.tailRevision = previous.tailRevision + 1
        next.requiresLatestReset = false
        next.isLoadingMore = replaceServerRows ? false : previous.isLoadingMore
        next.olderGeneration = replaceServerRows ? previous.olderGeneration + 1 : previous.olderGeneration
        next.warning = nil
        return next
    }

    // MARK: - Tail sync

    /// Web `beginTailSync`: claim a new sync generation. The older generation
    /// bumps too — an older-page response captured before this point must not
    /// commit while the tail request is in flight, or a reset can mistake it
    /// for concurrent SSE.
    public static func beginTailSync(_ previous: MessageWindowState) -> MessageWindowState {
        var next = previous
        next.syncGeneration = previous.syncGeneration + 1
        next.olderGeneration = previous.olderGeneration + 1
        next.isSyncingTail = true
        next.isLoadingMore = false
        next.warning = nil
        return next
    }

    public static func finishTailSync(
        _ previous: MessageWindowState,
        generation: Int,
        warning: String?
    ) -> MessageWindowState {
        guard previous.syncGeneration == generation else { return previous }
        var next = previous
        next.isSyncingTail = false
        next.warning = warning
        return next
    }

    /// Loop body of the after-cursor catch-up (web `runTailSync` inner
    /// updater): merge the page, adopt its epoch, and advance the newest
    /// cursor to `max(current, nextAfter)` — unless a prepend-side trim just
    /// flagged a latest reset, in which case the cursor stays pulled back.
    public static func applyAfterPage(
        _ previous: MessageWindowState,
        responseMessages: [WindowMessage],
        page: MessagesPage,
        nextAfter: MessagePosition?
    ) -> MessageWindowState {
        var merged = mergeIntoWindow(previous, incoming: responseMessages, advanceTailRevision: true)
        if merged.requiresLatestReset {
            merged.epoch = page.epoch
            merged.warning = nil
            return merged
        }
        merged.epoch = page.epoch
        merged.newestPosition = maxPosition(nextAfter, merged.newestPosition)
        merged.warning = nil
        return merged
    }

    // MARK: - View mode

    /// Re-enter tail mode (web `enterTailMode`): trim to the visible window;
    /// when a history overflow flagged `requiresLatestReset`, drop epoch and
    /// newest cursor so the next tail sync fetches a fresh latest page.
    /// The flag itself is deliberately NOT cleared here (web quirk, pinned) —
    /// `applyLatestResponse` clears it when the fresh page lands.
    public static func enterTailMode(_ previous: MessageWindowState) -> MessageWindowState {
        let trim = trimPreservingQueued(
            previous.messages,
            regularLimit: MessageWindowConstants.visibleWindowSize,
            mode: .append
        )
        let forceLatest = previous.requiresLatestReset
        let oldest = !trim.dropped.isEmpty
            ? derivePosition(trim.kept, .oldest)
            : previous.oldestPosition
        var next = settingMessages(previous, trim.kept)
        next.hasMore = previous.hasMore || !trim.dropped.isEmpty
        next.viewMode = .tail
        next.epoch = forceLatest ? nil : previous.epoch
        next.oldestPosition = oldest
        next.newestPosition = forceLatest ? nil : previous.newestPosition
        return next
    }

    public static func setViewMode(
        _ previous: MessageWindowState,
        mode: MessageViewMode
    ) -> MessageWindowState {
        if previous.viewMode == mode { return previous }
        if mode == .history {
            var next = previous
            next.viewMode = .history
            return next
        }
        return enterTailMode(previous)
    }

    public struct Activation {
        public let state: MessageWindowState
        public let requestedLatest: Bool
    }

    /// Session (re-)activation (web `activateMessageWindow`): trim back to
    /// the visible window, and when a usable persisted cursor exists, flag
    /// `preferLatestOnActivation` — another client may have advanced the
    /// session by many pages, so the next tail sync fetches the current tail
    /// first and reconciles it through the reset-preservation path.
    public static func activate(_ previous: MessageWindowState) -> Activation {
        let trim = trimPreservingQueued(
            previous.messages,
            regularLimit: MessageWindowConstants.visibleWindowSize,
            mode: .append
        )
        let forceLatest = previous.requiresLatestReset
        let hasUsableCursor = previous.newestPosition != nil && previous.epoch != nil && !forceLatest
        let preferLatestOnActivation = hasUsableCursor && !trim.kept.isEmpty
        let requestedLatest = preferLatestOnActivation && !previous.preferLatestOnActivation
        let invalidateRunningSync = requestedLatest && previous.isSyncingTail

        func withActivationUpdates(_ state: MessageWindowState) -> MessageWindowState {
            guard preferLatestOnActivation else { return state }
            var flagged = state
            flagged.preferLatestOnActivation = true
            if invalidateRunningSync {
                flagged.syncGeneration += 1
                flagged.olderGeneration += 1
            }
            return flagged
        }

        if previous.viewMode == .tail
            && trim.kept.count == previous.messages.count
            && !forceLatest {
            let state = preferLatestOnActivation ? withActivationUpdates(previous) : previous
            return Activation(state: state, requestedLatest: requestedLatest)
        }
        let next = enterTailMode(previous)
        let state = preferLatestOnActivation ? withActivationUpdates(next) : next
        return Activation(state: state, requestedLatest: requestedLatest)
    }

    // MARK: - Older pages

    public enum OlderPrecheck {
        case proceed(before: MessagePosition)
        case stop(OlderLoadOutcome.StopReason)
    }

    public static func olderLoadPrecheck(_ state: MessageWindowState) -> OlderPrecheck {
        let before = state.oldestPosition
        if state.isSyncingTail || state.isLoadingMore {
            return .stop(.busy)
        }
        if !state.hasMore {
            return .stop(.exhausted)
        }
        guard let before else {
            return .stop(.unavailable)
        }
        return .proceed(before: before)
    }

    public static func beginOlderLoad(
        _ previous: MessageWindowState,
        generation: Int
    ) -> MessageWindowState {
        var next = previous
        next.olderGeneration = generation
        next.isLoadingMore = true
        next.warning = nil
        return next
    }

    /// An older page answered with a different epoch: every cursor is
    /// meaningless. Drop epoch + newest cursor and flag the latest reset;
    /// the caller then runs a tail sync and reports `stopped/epoch-reset`.
    public static func applyOlderEpochMismatch(
        _ previous: MessageWindowState,
        generation: Int
    ) -> MessageWindowState {
        guard previous.olderGeneration == generation else { return previous }
        var next = previous
        next.isLoadingMore = false
        next.epoch = nil
        next.newestPosition = nil
        next.requiresLatestReset = true
        return next
    }

    /// The `onBeforeApply` veto path: invalidate this load, keep the window.
    public static func rejectOlderApply(_ previous: MessageWindowState) -> MessageWindowState {
        var next = previous
        next.olderGeneration = previous.olderGeneration + 1
        next.isLoadingMore = false
        next.warning = nil
        return next
    }

    public static func applyOlderResponse(
        _ previous: MessageWindowState,
        responseMessages: [WindowMessage],
        page: MessagesPage,
        historyVersion: Int
    ) -> MessageWindowState {
        var merged = mergeIntoWindow(
            previous,
            incoming: responseMessages,
            mode: .prepend,
            regularLimit: MessageWindowConstants.olderLoadWindowSize
        )
        merged.hasMore = page.hasMore
        merged.epoch = page.epoch
        merged.oldestPosition = pagePosition(at: page.nextBeforeAt, seq: page.nextBeforeSeq)
        merged.isLoadingMore = false
        merged.historyVersion = historyVersion
        merged.warning = nil
        return merged
    }

    public static func failOlderLoad(
        _ previous: MessageWindowState,
        generation: Int,
        warning: String
    ) -> MessageWindowState {
        guard previous.olderGeneration == generation else { return previous }
        var next = previous
        next.isLoadingMore = false
        next.warning = warning
        return next
    }

    public static func cancelOlderLoad(_ previous: MessageWindowState) -> MessageWindowState {
        guard previous.isLoadingMore else { return previous }
        var next = previous
        next.olderGeneration = previous.olderGeneration + 1
        next.isLoadingMore = false
        next.warning = nil
        return next
    }

    // MARK: - Live rows

    /// SSE `message-received` ingest (web `ingestIncomingMessages`): merge,
    /// then — when an epoch is cached and no reset is pending — advance the
    /// newest cursor past the incoming rows' positions, **including rows the
    /// pipeline hides**, so a later tail sync does not refetch them.
    public static func ingestIncoming(
        _ previous: MessageWindowState,
        incoming: [WindowMessage]
    ) -> MessageWindowState {
        if incoming.isEmpty { return previous }
        var merged = mergeIntoWindow(previous, incoming: incoming, advanceTailRevision: true)
        if merged.epoch == nil || merged.requiresLatestReset {
            return merged
        }
        let incomingNewest = derivePosition(incoming, .newest)
        let currentNewest = merged.newestPosition
        if let incomingNewest, currentNewest == nil || incomingNewest > currentNewest! {
            merged.newestPosition = incomingNewest
        }
        return merged
    }

    /// Optimistic append (web `appendOptimisticMessage`): never advances the
    /// newest cursor.
    public static func appendOptimistic(
        _ previous: MessageWindowState,
        message: WindowMessage
    ) -> MessageWindowState {
        mergeIntoWindow(
            previous,
            incoming: [message],
            mode: previous.viewMode == .history ? .prepend : .append,
            advanceTailRevision: true
        )
    }

    public static func updateStatus(
        _ previous: MessageWindowState,
        localId: String,
        status: MessageStatus
    ) -> MessageWindowState {
        if localId.isEmpty { return previous }
        var changed = false
        let messages = previous.messages.map { message -> WindowMessage in
            if message.localId != localId || message.status == status {
                return message
            }
            changed = true
            return message.withStatus(status)
        }
        return changed ? settingMessages(previous, messages) : previous
    }

    public static func markIndeterminate(
        _ previous: MessageWindowState,
        localIds: [String]
    ) -> MessageWindowState {
        if localIds.isEmpty { return previous }
        let idSet = Set(localIds)
        var changed = false
        let messages = previous.messages.map { message -> WindowMessage in
            guard let localId = message.localId, idSet.contains(localId), message.status != .indeterminate else {
                return message
            }
            changed = true
            return message.withStatus(.indeterminate)
        }
        return changed ? settingMessages(previous, messages) : previous
    }

    public static func markRequeued(
        _ previous: MessageWindowState,
        localIds: [String]
    ) -> MessageWindowState {
        if localIds.isEmpty { return previous }
        let idSet = Set(localIds)
        var changed = false
        let messages = previous.messages.map { message -> WindowMessage in
            guard let localId = message.localId, idSet.contains(localId), message.status == .indeterminate else {
                return message
            }
            changed = true
            return message.withStatus(.queued)
        }
        return changed ? settingMessages(previous, messages) : previous
    }

    /// `message-cancelled` / optimistic DELETE removal: matches localId OR
    /// id; idempotent.
    public static func removeByLocalIdOrId(
        _ previous: MessageWindowState,
        localId: String
    ) -> MessageWindowState {
        if localId.isEmpty { return previous }
        let messages = previous.messages.filter { $0.localId != localId && $0.id != localId }
        return messages.count == previous.messages.count
            ? previous
            : settingMessages(previous, messages)
    }

    /// SSE `messages-consumed` (web `markMessagesConsumed`): stamp
    /// `invokedAt` and flip status to `sent` on matching rows — including
    /// server rows without a client status (web quirk, pinned) — skip
    /// `failed`, then re-sort: the row moves from its enqueue position to its
    /// invocation position. Never advances the newest cursor.
    public static func markConsumed(
        _ previous: MessageWindowState,
        localIds: [String],
        invokedAt: Int
    ) -> MessageWindowState {
        if localIds.isEmpty { return previous }
        let idSet = Set(localIds)
        var changed = false
        let updated = previous.messages.map { message -> WindowMessage in
            guard let localId = message.localId, idSet.contains(localId), message.status != .failed else {
                return message
            }
            let needsStatus = message.status != .sent
            let needsInvokedAt = message.hasExplicitNullInvokedAt
            if !needsStatus && !needsInvokedAt { return message }
            changed = true
            var next = message
            if needsStatus { next = next.withStatus(.sent) }
            if needsInvokedAt { next = next.withInvokedAt(invokedAt) }
            return next
        }
        if !changed { return previous }
        var next = settingMessages(previous, MessageMerge.mergeMessages([], updated))
        next.tailRevision = previous.tailRevision + 1
        return next
    }

    // MARK: - Queued reconciliation

    /// Web `isQueuedReconcileCandidate`.
    private static func isQueuedReconcileCandidate(_ message: WindowMessage) -> Bool {
        guard message.localId != nil, message.isQueuedForInvocation else { return false }
        if !message.isOptimistic { return true }
        return message.status == .queued || message.status == .sent
    }

    /// Candidate localIds for the queued-state round trip, in window order.
    public static func queuedReconcileCandidateLocalIds(_ state: MessageWindowState) -> [String] {
        var seen = Set<String>()
        var localIds: [String] = []
        for message in state.messages where isQueuedReconcileCandidate(message) {
            let localId = message.localId!
            if seen.insert(localId).inserted {
                localIds.append(localId)
            }
        }
        return localIds
    }

    /// Apply the queued-state verdict (web `reconcileQueuedLocalIds`): drop
    /// candidates that are in neither the still-queued list nor (post
    /// `markConsumed`) invoked — they were deleted server-side.
    public static func reconcileQueuedLocalIds(
        _ previous: MessageWindowState,
        candidateLocalIds: [String],
        queuedLocalIds: [String]
    ) -> MessageWindowState {
        if candidateLocalIds.isEmpty { return previous }
        let candidates = Set(candidateLocalIds)
        let queued = Set(queuedLocalIds)
        let messages = previous.messages.filter { message in
            guard let localId = message.localId, candidates.contains(localId) else { return true }
            return queued.contains(localId) || !isQueuedReconcileCandidate(message)
        }
        return messages.count == previous.messages.count
            ? previous
            : settingMessages(previous, messages)
    }

    // MARK: - Persistence

    /// Web `shouldPersistState`.
    public static func shouldPersist(_ state: MessageWindowState) -> Bool {
        !state.messages.isEmpty
            || state.hasMore
            || state.epoch != nil
            || state.oldestPosition != nil
            || state.newestPosition != nil
    }

    public static func toPersisted(_ state: MessageWindowState) -> PersistedMessageWindow {
        PersistedMessageWindow(
            messages: state.messages,
            hasMore: state.hasMore,
            oldestPositionAt: state.oldestPosition?.at,
            oldestPositionSeq: state.oldestPosition?.seq,
            newestPositionAt: state.newestPosition?.at,
            newestPositionSeq: state.newestPosition?.seq,
            epoch: state.epoch
        )
    }

    /// Rebuild a state from a persisted snapshot (web `hydrateState`):
    /// interrupted `sending` rows restore to `queued`/`sent`, and a snapshot
    /// with rows but no usable cursor/epoch starts flagged for a latest
    /// reset.
    public static func hydrate(
        sessionId: String,
        persisted: PersistedMessageWindow
    ) -> MessageWindowState {
        let restored = persisted.messages.map { message -> WindowMessage in
            guard message.status == .sending else { return message }
            return message.withStatus(message.hasExplicitNullInvokedAt ? .queued : .sent)
        }
        let oldest = pagePosition(at: persisted.oldestPositionAt, seq: persisted.oldestPositionSeq)
        let newest = pagePosition(at: persisted.newestPositionAt, seq: persisted.newestPositionSeq)
        let epoch = persisted.epoch.flatMap { $0 >= 0 ? $0 : nil }
        var next = settingMessages(
            createState(sessionId: sessionId),
            MessageMerge.mergeMessages([], restored)
        )
        next.hasMore = persisted.hasMore
        next.oldestPosition = oldest
        next.newestPosition = newest
        next.epoch = epoch
        next.requiresLatestReset = !persisted.messages.isEmpty && (newest == nil || epoch == nil)
        return next
    }

    // MARK: - Seed

    /// Seed a fresh window from another session's (web
    /// `seedMessageWindowFromSession`) — resume/reopen may hand back a
    /// different session id; the old rows render instantly while
    /// `requiresLatestReset` forces a fresh latest page underneath. Cursor
    /// epoch and newest position are NOT carried over.
    public static func seededState(
        source: MessageWindowState,
        target: MessageWindowState
    ) -> MessageWindowState {
        var next = settingMessages(createState(sessionId: target.sessionId), source.messages)
        next.hasMore = source.hasMore
        next.tailRevision = source.tailRevision
        next.oldestPosition = source.oldestPosition
        next.requiresLatestReset = true
        next.syncGeneration = target.syncGeneration + 1
        next.olderGeneration = target.olderGeneration + 1
        return next
    }
}
