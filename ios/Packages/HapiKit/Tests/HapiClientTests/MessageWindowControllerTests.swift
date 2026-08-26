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

    // MARK: - Tail sync

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

/// Provider whose responses are released manually, so tests control the
/// interleaving between transport round-trips and controller mutations.
actor GatedMessagesProvider: MessagesProviding {
    private(set) var requests: [MessagesPageQuery] = []
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

    /// Answer the oldest parked request, or buffer for the next one.
    func release(_ response: MessagesResponse) {
        if pending.isEmpty {
            buffered.append(response)
        } else {
            pending.removeFirst().resume(returning: response)
        }
    }

    /// Suspends until at least `threshold` requests have been issued.
    func waitForRequests(_ threshold: Int) async {
        if requests.count >= threshold { return }
        await withCheckedContinuation { continuation in
            requestWaiters.append((threshold, continuation))
        }
    }
}
