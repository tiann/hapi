import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Targeted coverage for what the pagination fixtures cannot reach:
/// tail-sync single-flight/trailing behavior, concurrent-ingest preservation
/// across a reset replace (identity baseline), the cursor-no-advance guard,
/// snapshot round-trips + LRU, and seed-on-resume — the essentials of the
/// Android `MessageWindowStoreTest`.
@Suite("MessageWindowController")
struct MessageWindowControllerTests {

    // MARK: - Response builders

    private func agentRow(id: String, seq: Int, at: Int) -> DecryptedMessage {
        DecryptedMessage(
            id: id,
            seq: seq,
            content: [
                "role": "agent",
                "content": [
                    "type": "codex",
                    "data": ["type": "message", "message": .string(id)],
                ],
            ],
            createdAt: at,
            invokedAt: at
        )
    }

    private func latestPage(
        _ messages: [DecryptedMessage],
        epoch: Int,
        reset: Bool = false,
        hasMore: Bool = false
    ) -> MessagesResponse {
        let newest = messages.last
        let oldest = messages.first
        return MessagesResponse(
            messages: messages,
            page: MessagesPage(
                direction: .latest,
                limit: 200,
                epoch: epoch,
                reset: reset,
                nextBeforeSeq: oldest?.seq,
                nextBeforeAt: oldest.map { $0.invokedAt ?? $0.createdAt },
                nextAfterSeq: nil,
                nextAfterAt: nil,
                snapshotHeadSeq: newest?.seq,
                snapshotHeadAt: newest.map { $0.invokedAt ?? $0.createdAt },
                hasMore: hasMore
            )
        )
    }

    private func afterPage(
        _ messages: [DecryptedMessage],
        epoch: Int,
        nextAfter: (at: Int, seq: Int)?,
        hasMore: Bool
    ) -> MessagesResponse {
        MessagesResponse(
            messages: messages,
            page: MessagesPage(
                direction: .after,
                limit: 200,
                epoch: epoch,
                reset: false,
                nextBeforeSeq: nil,
                nextBeforeAt: nil,
                nextAfterSeq: nextAfter?.seq,
                nextAfterAt: nextAfter?.at,
                snapshotHeadSeq: nextAfter?.seq,
                snapshotHeadAt: nextAfter?.at,
                hasMore: hasMore
            )
        )
    }

    /// Hub-merged tool-call row: the hub folds the streamed tool-call and its
    /// result into one row keyed by the call id, keeping the row's original
    /// cursor position.
    private func toolCallRow(id: String, seq: Int, at: Int, status: String) -> DecryptedMessage {
        DecryptedMessage(
            id: id,
            seq: seq,
            content: [
                "role": "agent",
                "content": [
                    "type": "codex",
                    "data": [
                        "type": "tool-call",
                        "callId": "call-1",
                        "name": "Bash",
                        "input": ["command": "ls"],
                        "status": .string(status),
                    ],
                ],
            ],
            createdAt: at,
            invokedAt: at
        )
    }

    /// Warm tail window: rows r-1..r-9 plus a merged tool-call row at seq 10.
    private func warmRecoveryWindow(id: String, callStatus: String) -> MessageWindowState {
        var state = MessageWindowState(sessionId: id)
        state.messages = (1...9).map { WindowMessage(wire: agentRow(id: "r-\($0)", seq: $0, at: $0 * 1000)) }
            + [WindowMessage(wire: toolCallRow(id: "call-row", seq: 10, at: 10_000, status: callStatus))]
        state.epoch = 1
        state.hasMore = true
        state.oldestPosition = MessagePosition(at: 1000, seq: 1)
        state.newestPosition = MessagePosition(at: 10_000, seq: 10)
        return state
    }

    // MARK: - Tail sync

    @Test func coldSyncRequestsTheInitialPageSize() async {
        let provider = GatedMessagesProvider()
        let controller = MessageWindowController(sessionId: "s", provider: provider)

        let sync = Task { await controller.syncTail() }
        await provider.waitForRequests(1)

        let requests = await provider.requests
        guard case .latest(let limit) = requests[0] else {
            Issue.record("cold sync should request the latest page, got \(requests[0])")
            return
        }
        #expect(limit == MessageWindowConstants.initialPageSize)

        await provider.release(latestPage([agentRow(id: "a-1", seq: 1, at: 1000)], epoch: 0))
        await sync.value
    }

    @Test func resetAndCachedCursorSyncsKeepTheFullPageSize() async {
        let provider = GatedMessagesProvider()

        var resetState = MessageWindowState(sessionId: "reset")
        resetState.requiresLatestReset = true
        let resetController = MessageWindowController(
            sessionId: "reset",
            provider: provider,
            initialState: resetState
        )
        let resetSync = Task { await resetController.syncTail() }
        await provider.waitForRequests(1)
        let resetRequests = await provider.requests
        guard case .latest(let resetLimit) = resetRequests[0] else {
            Issue.record("reset sync should request the latest page, got \(resetRequests[0])")
            return
        }
        #expect(resetLimit == MessageWindowConstants.pageSize)
        await provider.release(latestPage([agentRow(id: "reset-1", seq: 1, at: 1000)], epoch: 1))
        await resetSync.value

        var cachedState = MessageWindowState(sessionId: "cached")
        cachedState.messages = [WindowMessage(wire: agentRow(id: "cached-1", seq: 1, at: 1000))]
        cachedState.hasMore = true
        cachedState.epoch = 1
        cachedState.oldestPosition = MessagePosition(at: 1000, seq: 1)
        cachedState.newestPosition = MessagePosition(at: 1000, seq: 1)
        cachedState.preferLatestOnActivation = true
        let cachedController = MessageWindowController(
            sessionId: "cached",
            provider: provider,
            initialState: cachedState
        )
        let cachedSync = Task { await cachedController.syncTail() }
        await provider.waitForRequests(2)
        let cachedRequests = await provider.requests
        guard case .latest(let cachedLimit) = cachedRequests[1] else {
            Issue.record("cached re-entry should request the latest page, got \(cachedRequests[1])")
            return
        }
        #expect(cachedLimit == MessageWindowConstants.pageSize)
        await provider.release(latestPage([agentRow(id: "cached-2", seq: 2, at: 2000)], epoch: 1))
        await cachedSync.value
    }

    @Test func cancellingHistoryDoesNotPublishAnOfflineWarning() async {
        let provider = GatedMessagesProvider()
        var initial = MessageWindowState(sessionId: "history")
        initial.hasMore = true
        initial.epoch = 1
        initial.oldestPosition = MessagePosition(at: 1000, seq: 1)
        let controller = MessageWindowController(sessionId: "history", provider: provider, initialState: initial)
        let task = Task { await controller.fetchOlder() }
        await provider.waitForRequests(1)
        task.cancel()
        await provider.failPending(CancellationError())
        guard case .stopped(.invalidated) = await task.value else {
            Issue.record("Cancellation must not appear as a failed network request")
            return
        }
        let state = await controller.state
        #expect(!state.isLoadingMore)
        #expect(state.warning == nil)
        #expect(state.hasMore)
    }

    @Test func nativeHistoryRetainsThePrependBudgetAcrossSSEAndReset() async throws {
        var initial = MessageWindowState(sessionId: "history")
        initial.messages = (1...800).map { WindowMessage(wire: agentRow(id: "a-\($0)", seq: $0, at: $0 * 1000)) }
        initial.epoch = 1
        initial.viewMode = .history
        let provider = GatedMessagesProvider()
        let controller = MessageWindowController(sessionId: "history", provider: provider,
                                                 initialState: initial, historyRetentionLimit: 800)
        await controller.ingestSSEMessages([WindowMessage(wire: agentRow(id: "new", seq: 801, at: 801000))])
        let history = await controller.state
        #expect(history.messages.count == 800)
        #expect(history.messages.first?.id == "a-1")
        #expect(history.requiresLatestReset)
        await provider.release(latestPage([agentRow(id: "new", seq: 801, at: 801000)], epoch: 1))
        try await controller.reconcileQueuedState()
        let afterReconnect = await controller.state
        #expect(await provider.requests == [.latest(limit: 200)])
        #expect(afterReconnect.messages == history.messages)
        #expect(afterReconnect.oldestPosition == history.oldestPosition)
        #expect(afterReconnect.newestPosition == history.newestPosition)
        #expect(afterReconnect.hasMore == history.hasMore)
        #expect(afterReconnect.historyVersion == history.historyVersion)
        #expect(afterReconnect.syncGeneration == history.syncGeneration + 1)
        #expect(afterReconnect.requiresLatestReset)
        #expect(!afterReconnect.isSyncingTail)
        await controller.setViewMode(.tail)
        let tail = await controller.state
        #expect(tail.messages.count == 400)
        #expect(tail.epoch == nil)
        await controller.clear()
        let cleared = await controller.state
        #expect(cleared.historyRetentionLimit == 800)
    }

    @Test(arguments: [false, true])
    func gapRecoveryReplacesTruncatedHistoryOnEpochChangeOrExplicitReset(reset: Bool) async throws {
        let provider = GatedMessagesProvider()
        var initial = MessageWindowState(sessionId: "history")
        initial.messages = [WindowMessage(wire: agentRow(id: "obsolete", seq: 1, at: 1000))]
        initial.epoch = 1
        initial.viewMode = .history
        initial.requiresLatestReset = true
        initial.hasMore = true
        initial.oldestPosition = MessagePosition(at: 1000, seq: 1)
        initial.newestPosition = initial.oldestPosition
        let controller = MessageWindowController(sessionId: "history", provider: provider, initialState: initial)
        let epoch = reset ? 1 : 2
        // Empty authoritative latest also covers deleted history.
        await provider.release(latestPage([], epoch: epoch, reset: reset))
        try await controller.reconcileQueuedState()
        #expect(await provider.requests.count == 1)
        let state = await controller.state
        #expect(state.epoch == epoch)
        #expect(state.messages.isEmpty)
        #expect(!state.requiresLatestReset)
        #expect(!state.hasMore)
    }

    @Test func gapRecoveryDrainsAFreshEpochCheckDuringTruncatedHistorySync() async throws {
        let provider = GatedMessagesProvider()
        var initial = MessageWindowState(sessionId: "history")
        initial.messages = [WindowMessage(wire: agentRow(id: "obsolete", seq: 1, at: 1000))]
        initial.epoch = 1
        initial.viewMode = .history
        initial.requiresLatestReset = true
        let controller = MessageWindowController(sessionId: "history", provider: provider, initialState: initial)
        let first = Task { await controller.syncTail() }
        await provider.waitForRequests(1)
        let recovery = Task { try await controller.reconcileQueuedState() }
        // Let recovery join the parked run before releasing its old snapshot.
        try await Task.sleep(for: .milliseconds(20))
        await provider.release(latestPage([], epoch: 1))
        await first.value
        await provider.waitForRequests(2)
        #expect(await provider.requests == [.latest(limit: 200), .latest(limit: 200)])
        #expect(await controller.state.messages.map(\.id) == ["obsolete"])
        await provider.release(latestPage([agentRow(id: "replacement", seq: 2, at: 2000)], epoch: 2))
        try await recovery.value
        #expect(await controller.state.epoch == 2)
        #expect(await controller.state.messages.map(\.id) == ["replacement"])
    }

    @Test func gapRecoveryCatchesUpMissedRowsAndReconcilesMergedRowsFromTheLatestPage() async {
        let provider = GatedMessagesProvider()
        let controller = MessageWindowController(
            sessionId: "gap-upsert",
            provider: provider,
            initialState: warmRecoveryWindow(id: "gap-upsert", callStatus: "in_progress")
        )
        await provider.release(afterPage(
            [agentRow(id: "r-11", seq: 11, at: 11_000), agentRow(id: "r-12", seq: 12, at: 12_000)],
            epoch: 1, nextAfter: (12_000, 12), hasMore: false
        ))
        let page = (1...9).map { agentRow(id: "r-\($0)", seq: $0, at: $0 * 1000) }
            + [toolCallRow(id: "call-row", seq: 10, at: 10_000, status: "completed")]
            + [agentRow(id: "r-11", seq: 11, at: 11_000), agentRow(id: "r-12", seq: 12, at: 12_000)]
        await provider.release(latestPage(page, epoch: 1))

        await controller.recoverAfterGapResume()

        // Catch-up first (newer rows only), then the authoritative latest
        // page applied as an upsert: rows present in the page are replaced by
        // id — the merged tool-call row's content converges — while rows the
        // page cannot reach and the hasMore/oldest cursor survive.
        let requests = await provider.requests
        guard requests.count == 2, case .after = requests[0] else {
            Issue.record("recovery must catch up first, got \(requests)")
            return
        }
        guard case .latest(let limit) = requests[1] else {
            Issue.record("recovery must reconcile the latest page, got \(requests[1])")
            return
        }
        #expect(limit == MessageWindowConstants.pageSize)
        let state = await controller.state
        #expect(state.messages.map(\.id) == (1...9).map { "r-\($0)" } + ["call-row", "r-11", "r-12"])
        #expect(state.messages.first(where: { $0.id == "call-row" })?.content
            == toolCallRow(id: "call-row", seq: 10, at: 10_000, status: "completed").content)
        #expect(state.newestPosition?.seq == 12)
        #expect(state.oldestPosition?.seq == 1)
        #expect(state.hasMore)
        #expect(state.warning == nil)
    }

    @Test func failedCatchUpStopsBeforeTheLatestPageAndTheNextRecoveryRetries() async {
        let provider = GatedMessagesProvider()
        let controller = MessageWindowController(
            sessionId: "gap-retry",
            provider: provider,
            initialState: warmRecoveryWindow(id: "gap-retry", callStatus: "in_progress")
        )

        let recovery = Task { await controller.recoverAfterGapResume() }
        await provider.waitForRequests(1)
        await provider.failPending(GapSyncFailure())
        await recovery.value

        // The failed catch-up leaves the failure warning, keeps the original
        // cursor, and never advances to the latest page.
        let requests = await provider.requests
        guard requests.count == 1, case .after = requests[0] else {
            Issue.record("failed catch-up must stop before the latest page, got \(requests)")
            return
        }
        let failed = await controller.state
        #expect(failed.warning != nil)
        #expect(failed.messages.map(\.id) == (1...9).map { "r-\($0)" } + ["call-row"])
        #expect(failed.newestPosition == MessagePosition(at: 10_000, seq: 10))

        // The next recovery retries the whole recovery: catch-up, then the
        // latest-page upsert that converges the merged row.
        await provider.release(afterPage(
            [agentRow(id: "r-11", seq: 11, at: 11_000), agentRow(id: "r-12", seq: 12, at: 12_000)],
            epoch: 1, nextAfter: (12_000, 12), hasMore: false
        ))
        let page = (1...9).map { agentRow(id: "r-\($0)", seq: $0, at: $0 * 1000) }
            + [toolCallRow(id: "call-row", seq: 10, at: 10_000, status: "completed")]
            + [agentRow(id: "r-11", seq: 11, at: 11_000), agentRow(id: "r-12", seq: 12, at: 12_000)]
        await provider.release(latestPage(page, epoch: 1))
        await controller.recoverAfterGapResume()

        let retried = await provider.requests
        // provider.requests is cumulative: the failed first catch-up, then
        // the retry's catch-up and latest page.
        guard retried.count == 3 else {
            Issue.record("retry must run exactly catch-up + latest page, got \(retried)")
            return
        }
        guard case .after = retried[1] else {
            Issue.record("retry must run its catch-up, got \(retried[1])")
            return
        }
        guard case .latest = retried[2] else {
            Issue.record("retry must reconcile the latest page, got \(retried[2])")
            return
        }
        let state = await controller.state
        #expect(state.messages.first(where: { $0.id == "call-row" })?.content
            == toolCallRow(id: "call-row", seq: 10, at: 10_000, status: "completed").content)
        #expect(state.warning == nil)
    }

    @Test func recoveryCatchUpOverflowingTheHistoryBudgetStaysResetMarked() async {
        let provider = GatedMessagesProvider()
        var initial = MessageWindowState(sessionId: "gap-overflow")
        initial.viewMode = .history
        initial.epoch = 1
        initial.hasMore = true
        initial.oldestPosition = MessagePosition(at: 1000, seq: 1)
        initial.newestPosition = MessagePosition(at: 600_000, seq: 600)
        initial.messages = (1...600).map { WindowMessage(wire: agentRow(id: "r-\($0)", seq: $0, at: $0 * 1000)) }
        let controller = MessageWindowController(sessionId: "gap-overflow", provider: provider, initialState: initial)
        await provider.release(afterPage(
            (601...800).map { agentRow(id: "r-\($0)", seq: $0, at: $0 * 1000) },
            epoch: 1, nextAfter: (800_000, 800), hasMore: true
        ))
        await provider.release(latestPage(
            (901...1100).map { agentRow(id: "r-\($0)", seq: $0, at: $0 * 1000) },
            epoch: 1
        ))

        await controller.recoverAfterGapResume()

        // The catch-up page overflowed the 600-row history budget: the
        // prepend trim kept rows 1-600, dropped the caught-up 601-800, and
        // marked the window for a reset. The recovery must not reconcile the
        // latest page on top — rows 601-900 would sit between the two
        // cursors, unreachable from either — and must not consume the
        // recovery flags.
        let overflowed = await controller.state
        #expect(overflowed.messages.map(\.id) == (1...600).map { "r-\($0)" })
        #expect(overflowed.requiresLatestReset)
        #expect(overflowed.pendingGapRecovery)
        #expect(overflowed.warning == nil)

        // Returning to the tail view applies the authoritative replacement
        // and closes the hole.
        await controller.setViewMode(.tail)
        await controller.syncTail()

        let replaced = await controller.state
        #expect(replaced.messages.map(\.id) == (901...1100).map { "r-\($0)" })
        #expect(!replaced.requiresLatestReset)
        #expect(!replaced.pendingGapRecovery)
        #expect(replaced.oldestPosition?.seq == 901)
        #expect(replaced.warning == nil)
    }

    @Test func noNewsRecoveryKeepsTheLoadedOlderCursor() async {
        let provider = GatedMessagesProvider()
        var initial = MessageWindowState(sessionId: "gap-cursor")
        initial.epoch = 1
        initial.hasMore = true
        initial.oldestPosition = MessagePosition(at: 1000, seq: 1)
        initial.newestPosition = MessagePosition(at: 800_000, seq: 800)
        initial.messages = (1...800).map { WindowMessage(wire: agentRow(id: "r-\($0)", seq: $0, at: $0 * 1000)) }
        let controller = MessageWindowController(sessionId: "gap-cursor", provider: provider, initialState: initial)
        await provider.release(afterPage([], epoch: 1, nextAfter: (800_000, 800), hasMore: false))
        await provider.release(latestPage(
            (601...800).map { agentRow(id: "r-\($0)", seq: $0, at: $0 * 1000) },
            epoch: 1, hasMore: true
        ))

        await controller.recoverAfterGapResume()

        // The latest page excludes the held rows 1-600: the older-paging
        // cursor must stay at the window edge (row 1) instead of jumping to
        // the page's own bound (row 600), like the web keeps it.
        let state = await controller.state
        #expect(state.messages.count == 800)
        #expect(state.oldestPosition?.seq == 1)
        #expect(state.hasMore)
    }

    @Test func gapRecoveryRefreshesARetainedNonTerminalToolCallRowTheLatestPageCannotReach() async {
        let provider = GatedMessagesProvider()
        let controller = MessageWindowController(
            sessionId: "gap-sweep",
            provider: provider,
            initialState: warmRecoveryWindow(id: "gap-sweep", callStatus: "in_progress")
        )
        await provider.release(afterPage(
            (11...310).map { agentRow(id: "r-\($0)", seq: $0, at: $0 * 1000) },
            epoch: 1, nextAfter: (310_000, 310), hasMore: false
        ))
        await provider.release(latestPage(
            (111...310).map { agentRow(id: "r-\($0)", seq: $0, at: $0 * 1000) },
            epoch: 1
        ))
        await provider.releaseContext(MessageContextResponse(
            messages: [toolCallRow(id: "call-row", seq: 10, at: 10_000, status: "completed")],
            targetMessageId: "call-row",
            page: MessageContextPage(
                epoch: 1, nextBeforeSeq: 1, nextBeforeAt: 1000,
                snapshotHeadSeq: 310, snapshotHeadAt: 310_000, hasMore: false
            )
        ))

        await controller.recoverAfterGapResume()

        // The call was enriched while disconnected and 300 newer rows pushed
        // it beyond the latest page: only a by-id context refresh can
        // converge the cached card.
        #expect(await provider.contextRequests == ["call-row"])
        let state = await controller.state
        #expect(state.messages.first(where: { $0.id == "call-row" })?.content
            == toolCallRow(id: "call-row", seq: 10, at: 10_000, status: "completed").content)
        #expect(state.messages.count == 310)
        #expect(state.newestPosition?.seq == 310)
        #expect(state.warning == nil)
    }

    @Test func gapRecoveryFinishesTheRunWithAWarningWhenTheContextRefreshFindsNoRow() async {
        let provider = GatedMessagesProvider()
        let controller = MessageWindowController(
            sessionId: "gap-sweep-missing",
            provider: provider,
            initialState: warmRecoveryWindow(id: "gap-sweep-missing", callStatus: "in_progress")
        )
        await provider.release(afterPage(
            (11...310).map { agentRow(id: "r-\($0)", seq: $0, at: $0 * 1000) },
            epoch: 1, nextAfter: (310_000, 310), hasMore: false
        ))
        await provider.release(latestPage(
            (111...310).map { agentRow(id: "r-\($0)", seq: $0, at: $0 * 1000) },
            epoch: 1
        ))

        await controller.recoverAfterGapResume()

        // The context endpoint no longer knows the row: the sweep leaves it
        // as is, surfaces the warning, and finishes the run's bookkeeping
        // instead of leaving the window marked syncing.
        #expect(await provider.contextRequests == ["call-row"])
        let state = await controller.state
        #expect(state.messages.first(where: { $0.id == "call-row" })?.content
            == toolCallRow(id: "call-row", seq: 10, at: 10_000, status: "in_progress").content)
        #expect(state.warning != nil)
        #expect(!state.isSyncingTail)
    }

    @Test func stalledOlderCursorDoesNotApplyOrPretendHistoryIsExhausted() async {
        let provider = GatedMessagesProvider()
        var initial = MessageWindowState(sessionId: "history")
        initial.hasMore = true
        initial.epoch = 1
        initial.oldestPosition = MessagePosition(at: 1000, seq: 1)
        await provider.release(MessagesResponse(messages: [], page: MessagesPage(
            direction: .before, limit: 200, epoch: 1, reset: false,
            nextBeforeSeq: 1, nextBeforeAt: 1000, nextAfterSeq: nil, nextAfterAt: nil,
            snapshotHeadSeq: nil, snapshotHeadAt: nil, hasMore: true
        )))
        let controller = MessageWindowController(sessionId: "history", provider: provider, initialState: initial)
        let outcome = await controller.fetchOlder()
        guard case .stopped(.cursorDidNotAdvance) = outcome else { Issue.record("Expected a stalled cursor"); return }
        let state = await controller.state
        #expect(state.hasMore)
        #expect(!state.isLoadingMore)
        #expect(state.historyVersion == 0)
    }

    @Test func readerReversalVetoesAnInflightPrepend() async {
        let provider = GatedMessagesProvider()
        var initial = MessageWindowState(sessionId: "history")
        initial.hasMore = true
        initial.epoch = 1
        initial.oldestPosition = MessagePosition(at: 1000, seq: 1)
        let controller = MessageWindowController(sessionId: "history", provider: provider, initialState: initial)
        let gate = ChatHistoryRequestGate()
        let request = Task { await controller.fetchOlder(onBeforeApply: { _ in gate.allowsApply }) }
        await provider.waitForRequests(1)
        gate.invalidate()
        await provider.release(MessagesResponse(messages: [agentRow(id: "older", seq: 0, at: 0)], page: MessagesPage(
            direction: .before, limit: 200, epoch: 1, reset: false,
            nextBeforeSeq: 0, nextBeforeAt: 0, nextAfterSeq: nil, nextAfterAt: nil,
            snapshotHeadSeq: nil, snapshotHeadAt: nil, hasMore: false
        )))
        let outcome = await request.value
        guard case .stopped(.invalidated) = outcome else { Issue.record("Stale page was applied"); return }
        let state = await controller.state
        #expect(state.messages.isEmpty)
        #expect(state.historyVersion == 0)
    }

    @Test func concurrentSyncTailCallsCoalesceIntoASingleRun() async {
        let provider = GatedMessagesProvider()
        let controller = MessageWindowController(sessionId: "s", provider: provider)

        let first = Task { await controller.syncTail() }
        await provider.waitForRequests(1)

        let second = Task { await controller.syncTail() }
        // Settle: same-priority actor jobs run FIFO in practice, so two
        // round-trips put `second` past its join decision before we release.
        _ = await controller.state
        _ = await controller.state

        // Safety net so a mis-scheduled `second` fails fast instead of
        // hanging: an after-page is buffered for the run it would start.
        await provider.release(latestPage([agentRow(id: "a-1", seq: 1, at: 1000)], epoch: 0))
        await provider.release(afterPage([], epoch: 0, nextAfter: (at: 1000, seq: 1), hasMore: false))

        await first.value
        await second.value

        let requests = await provider.requests
        #expect(requests.count == 1, "second caller should have joined the in-flight run")
        let state = await controller.state
        #expect(state.messages.map(\.id) == ["a-1"])
    }

    @Test func ensureAfterCurrentRequestsATrailingRunAndDrainsIt() async {
        let provider = GatedMessagesProvider()
        let controller = MessageWindowController(sessionId: "s", provider: provider)

        let first = Task { await controller.syncTail() }
        await provider.waitForRequests(1)

        let drain = Task { await controller.syncTail(ensureAfterCurrent: true) }

        await provider.release(latestPage([agentRow(id: "a-1", seq: 1, at: 1000)], epoch: 0))
        await first.value

        // Whether `drain` joined the first run (trailing) or started after it
        // (fresh run), the guaranteed observable is a SECOND, after-cursor
        // request before `drain` returns.
        await provider.waitForRequests(2)
        let requestsMidway = await provider.requests
        guard case .after = requestsMidway[1] else {
            Issue.record("second request should be an after-cursor catch-up, got \(requestsMidway[1])")
            return
        }
        await provider.release(afterPage([], epoch: 0, nextAfter: (at: 1000, seq: 1), hasMore: false))
        await drain.value

        let requests = await provider.requests
        #expect(requests.count == 2)
        let warning = await controller.state.warning
        #expect(warning == nil)
    }

    @Test func resetReplacePreservesRowsThatArrivedWhileTheRequestWasInFlight() async {
        let provider = GatedMessagesProvider()
        let controller = MessageWindowController(sessionId: "s", provider: provider)

        // Seed epoch + cursor with a completed latest sync.
        let seed = Task { await controller.syncTail() }
        await provider.waitForRequests(1)
        await provider.release(latestPage([agentRow(id: "a-1", seq: 1, at: 1000)], epoch: 0))
        await seed.value

        // Second sync goes down the after-cursor path and parks on the provider.
        let sync = Task { await controller.syncTail() }
        await provider.waitForRequests(2)
        let requests = await provider.requests
        guard case .after = requests[1] else {
            Issue.record("expected an after-cursor request, got \(requests[1])")
            return
        }

        // A live SSE row lands while the request is in flight.
        await controller.ingestSSEMessages([WindowMessage(wire: agentRow(id: "b-2", seq: 2, at: 2000))])

        // The server answers with a reset page that does not contain b-2.
        await provider.release(latestPage([agentRow(id: "c-3", seq: 3, at: 3000)], epoch: 1, reset: true))
        await sync.value

        let state = await controller.state
        // a-1 (captured in the request baseline) was replaced; the concurrent
        // b-2 and the authoritative c-3 both survive.
        #expect(state.messages.map(\.id) == ["b-2", "c-3"])
        #expect(state.epoch == 1)
        #expect(state.newestPosition == MessagePosition(at: 3000, seq: 3))
    }

    @Test func aTailCursorThatDoesNotAdvanceAbortsWithAWarningInsteadOfSpinning() async {
        let provider = GatedMessagesProvider()
        let controller = MessageWindowController(sessionId: "s", provider: provider)

        let seed = Task { await controller.syncTail() }
        await provider.waitForRequests(1)
        await provider.release(latestPage([agentRow(id: "a-1", seq: 1, at: 1000)], epoch: 0))
        await seed.value

        let sync = Task { await controller.syncTail() }
        await provider.waitForRequests(2)
        // hasMore with a non-advancing nextAfter is a protocol violation.
        await provider.release(afterPage(
            [agentRow(id: "b-2", seq: 2, at: 2000)],
            epoch: 0,
            nextAfter: (at: 1000, seq: 1),
            hasMore: true
        ))
        await sync.value

        let state = await controller.state
        #expect(state.warning == "Message tail cursor did not advance")
        #expect(!state.isSyncingTail)
        let requestCount = await provider.requests.count
        #expect(requestCount == 2)
    }

    // MARK: - Snapshots

    @Test func snapshotRoundTripRestoresInterruptedSendsAndFlagsStaleSnapshots() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("hapi-window-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let snapshots = WindowSnapshotStore(directory: directory)

        let queuedSending = buildOptimisticMessage(
            localId: "local-1",
            text: "hello",
            createdAt: 1000,
            status: .sending
        )
        let fresh = PersistedMessageWindow(
            messages: [queuedSending, WindowMessage(wire: agentRow(id: "a-1", seq: 1, at: 500))],
            hasMore: true,
            oldestPositionAt: 500,
            oldestPositionSeq: 1,
            newestPositionAt: 500,
            newestPositionSeq: 1,
            epoch: 3
        )
        snapshots.save(sessionId: "session-a", snapshot: fresh)

        let loaded = try #require(snapshots.load(sessionId: "session-a"))
        let hydrated = MessageWindowLogic.hydrate(sessionId: "session-a", persisted: loaded)
        // Interrupted `sending` on a queued row restores to `queued`.
        let restored = try #require(hydrated.messages.first(where: { $0.id == "local-1" }))
        #expect(restored.status == .queued)
        #expect(restored.hasExplicitNullInvokedAt, "tri-state null must survive the disk round-trip")
        #expect(hydrated.epoch == 3)
        #expect(!hydrated.requiresLatestReset)
        #expect(hydrated.newestPosition == MessagePosition(at: 500, seq: 1))

        // A snapshot without a usable epoch hydrates flagged for a latest reset.
        var stale = fresh
        stale.epoch = nil
        snapshots.save(sessionId: "session-b", snapshot: stale)
        let staleLoaded = try #require(snapshots.load(sessionId: "session-b"))
        let staleHydrated = MessageWindowLogic.hydrate(sessionId: "session-b", persisted: staleLoaded)
        #expect(staleHydrated.requiresLatestReset)
        #expect(staleHydrated.epoch == nil)
    }

    @Test func snapshotsAreLRUCappedAtTenSessions() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("hapi-window-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let snapshots = WindowSnapshotStore(directory: directory)

        for index in 0..<12 {
            snapshots.save(
                sessionId: "session-\(index)",
                snapshot: PersistedMessageWindow(
                    messages: [WindowMessage(wire: agentRow(id: "a-\(index)", seq: 1, at: 1000))]
                )
            )
        }
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasSuffix(".window.json") }
        #expect(files.count == 10)
    }

    // MARK: - Seed

    @Test func seedFromCarriesRowsAndOlderCursorButForcesALatestReset() async {
        let provider = GatedMessagesProvider()
        let source = MessageWindowController(sessionId: "old-session", provider: provider)
        let seed = Task { await source.syncTail() }
        await provider.waitForRequests(1)
        await provider.release(latestPage(
            [agentRow(id: "a-1", seq: 1, at: 1000)],
            epoch: 5,
            hasMore: true
        ))
        await seed.value

        let target = MessageWindowController(sessionId: "new-session", provider: provider)
        await target.seedFrom(source)

        let state = await target.state
        #expect(state.sessionId == "new-session")
        #expect(state.messages.map(\.id) == ["a-1"])
        #expect(state.hasMore)
        #expect(state.requiresLatestReset)
        #expect(state.epoch == nil)
        #expect(state.newestPosition == nil)
        #expect(state.oldestPosition == MessagePosition(at: 1000, seq: 1))
    }
}

// MARK: - Gated transport

/// Non-cancellation transport failure for the gap-recovery tests.
private struct GapSyncFailure: Error {}

/// Provider whose responses are released manually, so tests control the
/// interleaving between transport round-trips and controller mutations.
actor GatedMessagesProvider: MessagesProviding {
    private(set) var requests: [MessagesPageQuery] = []
    private(set) var contextRequests: [String] = []
    private var contextResponses: [MessageContextResponse?] = []
    private var buffered: [MessagesResponse] = []
    private var pending: [CheckedContinuation<MessagesResponse, any Error>] = []
    private var requestWaiters: [(threshold: Int, continuation: CheckedContinuation<Void, Never>)] = []

    func messages(sessionId: String, query: MessagesPageQuery) async throws -> MessagesResponse {
        requests.append(query)
        let reached = requests.count
        var remaining: [(threshold: Int, continuation: CheckedContinuation<Void, Never>)] = []
        for waiter in requestWaiters {
            if waiter.threshold <= reached {
                waiter.continuation.resume()
            } else {
                remaining.append(waiter)
            }
        }
        requestWaiters = remaining
        if !buffered.isEmpty {
            return buffered.removeFirst()
        }
        return try await withCheckedThrowingContinuation { continuation in
            pending.append(continuation)
        }
    }

    func queuedState(sessionId: String, localIds: [String]) async throws -> QueuedStateResponse {
        QueuedStateResponse(queuedLocalIds: [], invokedLocalMessages: [])
    }

    func messageContext(sessionId: String, messageId: String) async throws -> MessageContextResponse? {
        contextRequests.append(messageId)
        if contextResponses.isEmpty { return nil }
        return contextResponses.removeFirst()
    }

    /// Queue a message-context response for the recovery sweep.
    func releaseContext(_ response: MessageContextResponse?) {
        contextResponses.append(response)
    }

    /// Answer the oldest parked request, or buffer for the next one.
    func release(_ response: MessagesResponse) {
        if pending.isEmpty {
            buffered.append(response)
        } else {
            pending.removeFirst().resume(returning: response)
        }
    }

    func failPending(_ error: any Error) {
        pending.removeFirst().resume(throwing: error)
    }

    /// Suspends until at least `threshold` requests have been issued.
    func waitForRequests(_ threshold: Int) async {
        if requests.count >= threshold { return }
        await withCheckedContinuation { continuation in
            requestWaiters.append((threshold, continuation))
        }
    }
}
