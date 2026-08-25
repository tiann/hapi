import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Transcribes the Android reference suite (`SessionStoreTest.kt`): REST
/// refresh, the full-session / strict-patch / REST-fallback event paths with
/// their divergent version gates, keep-alive identity preservation,
/// optimistic pin/archive, and the cold-start snapshot.
@MainActor
@Suite("SessionListStore")
struct SessionListStoreTests {

    private func makeStore(
        snapshotDirectory: URL? = nil
    ) throws -> (performer: RecordingPerformer, store: SessionListStore) {
        let performer = RecordingPerformer()
        let api = try makeStoreAPIClient(performer: performer)
        let store = SessionListStore(
            api: api,
            snapshotDirectory: snapshotDirectory,
            refreshBatch: .milliseconds(1)
        )
        return (performer, store)
    }

    // MARK: - refresh

    @Test func refreshReplacesTheListWithTheSortedServerResponse() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(
            storeSummary("old-inactive", updatedAt: 1_000),
            storeSummary("pinned", updatedAt: 500, pinned: true),
            storeSummary("active", active: true, updatedAt: 100)
        ))
        try await store.refresh()
        #expect(store.sessions.map(\.id) == ["pinned", "active", "old-inactive"])
    }

    @Test func refreshFailureThrowsAndKeepsPreviousState() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(storeSummary("s1")))
        try await store.refresh()
        await performer.enqueue(status: 500, json: "{\"error\":\"boom\"}")
        var thrown = false
        do {
            try await store.refresh()
        } catch {
            thrown = true
        }
        #expect(thrown, "refresh over a 500 must throw")
        #expect(store.sessions.map(\.id) == ["s1"])
    }

    // MARK: - Event: full session

    @Test func fullSessionEventReplacesTheDetailAndUpsertsTheSummary() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(
            storeSummary("s1", updatedAt: 100, futureScheduledMessageCount: 2, nextScheduledAt: 999)
        ))
        try await store.refresh()

        let full = storeSession("s1", updatedAt: 5_000, agentStateVersion: 9)
        store.applySessionEvent(try sessionUpdatedEvent("s1", dataJSON: fullSessionJSON(full)))

        #expect(store.detail(for: "s1") == full)
        let row = try #require(store.sessions.first)
        #expect(store.sessions.count == 1)
        #expect(row.updatedAt == 5_000)
        #expect(row.agentStateVersion == 9)
        // Hub-computed fields the projection cannot derive are preserved.
        #expect(row.futureScheduledMessageCount == 2)
        #expect(row.nextScheduledAt == 999)
    }

    @Test func fullSessionEventWithMismatchedIdFallsBackToListRefetch() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(storeSummary("s1", updatedAt: 100)))
        try await store.refresh()
        // The refetch triggered by the mismatching payload:
        await performer.enqueue(json: try sessionsResponseJSON(
            storeSummary("s1", updatedAt: 100),
            storeSummary("s2", updatedAt: 50)
        ))

        store.applySessionEvent(
            try sessionUpdatedEvent("s2", dataJSON: fullSessionJSON(storeSession("other-id")))
        )
        #expect(store.detail(for: "s2") == nil)
        try await expectEventually { store.sessions.contains { $0.id == "s2" } }
    }

    // MARK: - Event: patch

    @Test func staleVersionedPatchLeavesDetailAndSummaryUntouched() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(
            storeSummary("s1", updatedAt: 100, agentStateVersion: 5)
        ))
        try await store.refresh()
        store.applySessionEvent(
            try sessionUpdatedEvent("s1", dataJSON: fullSessionJSON(storeSession("s1", agentStateVersion: 5)))
        )

        let revisionBefore = store.listRevision
        store.applySessionEvent(try sessionUpdatedEvent(
            "s1",
            dataJSON: "{\"agentState\":{\"version\":4,\"value\":{\"requests\":{\"r1\":{\"tool\":\"Bash\"}}}}}"
        ))
        #expect(store.detail(for: "s1")?.agentStateVersion == 5)
        #expect(store.detail(for: "s1")?.agentState == nil)
        #expect(store.sessions.count == 1)
        #expect(store.sessions.first?.pendingRequestsCount == 0)
        // Stale patch must keep the list identity (no revision bump).
        #expect(store.listRevision == revisionBefore)
    }

    @Test func equalVersionPatchAppliesToTheSummaryButNotTheDetail() async throws {
        // The replicated web divergence: summary path >= vs detail path >.
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(
            storeSummary("s1", updatedAt: 100, agentStateVersion: 5)
        ))
        try await store.refresh()
        store.applySessionEvent(
            try sessionUpdatedEvent("s1", dataJSON: fullSessionJSON(storeSession("s1", agentStateVersion: 5)))
        )

        store.applySessionEvent(try sessionUpdatedEvent(
            "s1",
            dataJSON: "{\"agentState\":{\"version\":5,\"value\":{\"requests\":{\"r1\":{\"tool\":\"Bash\"}}}}}"
        ))
        #expect(store.detail(for: "s1")?.agentState == nil, "detail gates strictly greater")
        let row = try #require(store.sessions.first)
        #expect(row.pendingRequestsCount == 1)
        #expect(row.pendingRequestKinds == [.permission])
    }

    @Test func newerVersionedPatchAppliesToBothCachesAndResorts() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(
            storeSummary("s1", active: true, updatedAt: 100, agentStateVersion: 5),
            storeSummary("s2", active: true, updatedAt: 200)
        ))
        try await store.refresh()
        #expect(store.sessions.map(\.id) == ["s2", "s1"])
        store.applySessionEvent(
            try sessionUpdatedEvent("s1", dataJSON: fullSessionJSON(storeSession("s1", agentStateVersion: 5)))
        )

        store.applySessionEvent(try sessionUpdatedEvent(
            "s1",
            dataJSON: "{\"updatedAt\":300,\"agentState\":{\"version\":6,\"value\":{\"requests\":{\"r1\":{\"tool\":\"Bash\"}}}}}"
        ))
        let detail = store.detail(for: "s1")
        #expect(detail?.agentStateVersion == 6)
        #expect(detail?.agentState?.requests?["r1"]?.tool == "Bash")
        // Pending requests push the active session ahead of the newer one.
        #expect(store.sessions.map(\.id) == ["s1", "s2"])
        #expect(store.sessions.first?.pendingRequestsCount == 1)
    }

    @Test func keepAliveActiveAtOnlyPatchKeepsTheListIdentity() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(
            storeSummary("s1", active: true, updatedAt: 100, activeAt: 1_000)
        ))
        try await store.refresh()
        let revisionBefore = store.listRevision
        store.applySessionEvent(
            try sessionUpdatedEvent("s1", dataJSON: "{\"active\":true,\"activeAt\":11000}")
        )
        #expect(store.listRevision == revisionBefore)
    }

    @Test func patchForAnUnlistedSessionFallsBackToAListRefetch() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(storeSummary("brand-new", updatedAt: 10)))
        store.applySessionEvent(try sessionUpdatedEvent("brand-new", dataJSON: "{\"updatedAt\":10}"))
        try await expectEventually { store.sessions.contains { $0.id == "brand-new" } }
    }

    @Test func unparseableDataRefetchesListAndCachedDetail() async throws {
        // Detail + list refetch run concurrently — route by path, not FIFO.
        let performer = RoutingPerformer()
        let api = try makeStoreAPIClient(performer: performer)
        let store = SessionListStore(api: api, refreshBatch: .milliseconds(1))

        await performer.setRoutes([
            (pathPrefix: "/api/sessions", json: try sessionsResponseJSON(storeSummary("s1", updatedAt: 100))),
        ])
        try await store.refresh()
        store.applySessionEvent(
            try sessionUpdatedEvent("s1", dataJSON: fullSessionJSON(storeSession("s1", updatedAt: 100)))
        )

        await performer.setRoutes([
            (pathPrefix: "/api/sessions/s1", json: try sessionResponseJSON(storeSession("s1", updatedAt: 900))),
            (pathPrefix: "/api/sessions", json: try sessionsResponseJSON(storeSummary("s1", updatedAt: 900))),
        ])
        // `data` present but neither a Session nor a strict patch.
        store.applySessionEvent(try sessionUpdatedEvent("s1", dataJSON: "{\"unknownKey\":1}"))
        try await expectEventually { store.sessions.contains { $0.updatedAt == 900 } }
        try await expectEventually { store.detail(for: "s1")?.updatedAt == 900 }
    }

    @Test func emptyObjectPatchTakesTheRestFallback() async throws {
        // `{}` decodes as an all-nil strict patch, but the web's
        // `getSessionPatch` rejects empty objects — the store must refetch
        // instead of treating it as an applied no-op.
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(storeSummary("s1", updatedAt: 100)))
        try await store.refresh()
        await performer.enqueue(json: try sessionsResponseJSON(storeSummary("s1", updatedAt: 700)))

        store.applySessionEvent(try sessionUpdatedEvent("s1", dataJSON: "{}"))
        try await expectEventually { store.sessions.first?.updatedAt == 700 }
    }

    // MARK: - Event: removal / add

    @Test func sessionRemovedDropsTheRowAndTheDetail() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(storeSummary("s1"), storeSummary("s2")))
        try await store.refresh()
        store.applySessionEvent(
            try sessionUpdatedEvent("s1", dataJSON: fullSessionJSON(storeSession("s1")))
        )

        store.applySessionEvent(try sessionRemovedEvent("s1"))
        #expect(store.sessions.map(\.id) == ["s2"])
        #expect(store.detail(for: "s1") == nil)
    }

    @Test func sessionAddedWithAFullSessionInsertsANewRow() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(storeSummary("s1", updatedAt: 500)))
        try await store.refresh()
        store.applySessionEvent(
            try sessionAddedEvent("s2", dataJSON: fullSessionJSON(storeSession("s2", updatedAt: 900)))
        )
        #expect(store.sessions.map(\.id) == ["s2", "s1"])
    }

    // MARK: - Pin / archive

    @Test func setPinModeFlipsFlagsOptimisticallyAndResorts() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(
            storeSummary("s1", updatedAt: 900),
            storeSummary("s2", updatedAt: 100)
        ))
        try await store.refresh()

        await performer.enqueue(json: "{\"ok\":true}") // PUT pin
        try await store.setPinMode(sessionId: "s2", mode: .project)
        #expect(store.sessions.map(\.id) == ["s2", "s1"])
        #expect(store.sessions.first?.pinned == true)
        #expect(store.sessions.first?.globalPinned == false)

        await performer.enqueue(json: "{\"ok\":true}")
        try await store.setPinMode(sessionId: "s2", mode: .global)
        #expect(store.sessions.first?.pinned == false)
        #expect(store.sessions.first?.globalPinned == true)

        await performer.enqueue(json: "{\"ok\":true}")
        try await store.setPinMode(sessionId: "s2", mode: .none)
        #expect(store.sessions.map(\.id) == ["s1", "s2"])
    }

    @Test func setPinModeFailureRollsForwardToServerTruth() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(
            storeSummary("s1", updatedAt: 900),
            storeSummary("s2", updatedAt: 100)
        ))
        try await store.refresh()
        await performer.enqueue(status: 500, json: "{\"error\":\"boom\"}") // PUT pin fails
        await performer.enqueue(json: try sessionsResponseJSON(
            storeSummary("s1", updatedAt: 900),
            storeSummary("s2", updatedAt: 100)
        ))

        var thrown = false
        do {
            try await store.setPinMode(sessionId: "s2", mode: .project)
        } catch {
            thrown = true
        }
        #expect(thrown, "failed pin must rethrow")
        try await expectEventually {
            store.sessions.map(\.id) == ["s1", "s2"] && !store.sessions.contains { $0.pinned == true }
        }
    }

    @Test func archiveRemovesOptimisticallyAndRestoresOnFailure() async throws {
        let (performer, store) = try makeStore()
        await performer.enqueue(json: try sessionsResponseJSON(
            storeSummary("s1", updatedAt: 900),
            storeSummary("s2", updatedAt: 100)
        ))
        try await store.refresh()

        await performer.enqueue(json: "{\"ok\":true}")
        try await store.archiveSession(sessionId: "s2")
        #expect(store.sessions.map(\.id) == ["s1"])

        await performer.enqueue(status: 409, json: "{\"error\":\"session_inactive\"}")
        var thrown = false
        do {
            try await store.archiveSession(sessionId: "s1")
        } catch {
            thrown = true
        }
        #expect(thrown, "failed archive must rethrow")
        #expect(store.sessions.map(\.id) == ["s1"], "failed archive restores the row")
    }

    // MARK: - Snapshot

    @Test func summariesRoundTripThroughTheSnapshotIntoAColdStore() async throws {
        let directory = makeTempDirectory()
        let (performer, store) = try makeStore(snapshotDirectory: directory)
        await performer.enqueue(json: try sessionsResponseJSON(
            storeSummary("pinned", updatedAt: 100, pinned: true),
            storeSummary("recent", updatedAt: 900)
        ))
        try await store.refresh()
        await store.flushPersistence()

        let (_, cold) = try makeStore(snapshotDirectory: directory)
        #expect(cold.sessions.map(\.id) == ["pinned", "recent"])
        #expect(cold.sessions.first?.pinned == true)
        let file = directory.appendingPathComponent("sessions.json")
        #expect(FileManager.default.fileExists(atPath: file.path))
    }
}
