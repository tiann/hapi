import HapiClient
import Observation
import XCTest
@testable import Hapi
@testable import HapiProtocol

@MainActor
final class SessionListFilterTests: XCTestCase {
    func testEmptyAndSingleMachineHaveNoFilterAffordance() {
        let sessions = HomeFilterTestSessions()
        let model = HomeFilterTestData.model(sessions: sessions)
        XCTAssertFalse(model.showsFilterMenu)
        XCTAssertFalse(model.filters.isActive)
        sessions.sessions = [HomeFilterTestData.summary("a", machine: "mac")]
        model.selectMachine("mac")
        XCTAssertFalse(model.showsFilterMenu)
        XCTAssertNil(model.activeMachineFilter)
        XCTAssertNil(model.filterSummary)
        XCTAssertEqual(model.rows.count, 1)
        XCTAssertEqual(model.rows.first?.meta, "workspace/hapi")
    }

    func testNamesCountsAndStableOrderIncludeHistoricalMachines() {
        let sessions = HomeFilterTestSessions([
            HomeFilterTestData.summary("1", machine: "mac-1111"),
            HomeFilterTestData.summary("2", machine: "mac-2222"),
            HomeFilterTestData.summary("3", machine: "debian"),
            HomeFilterTestData.summary("4", machine: "529e6566-history"),
            HomeFilterTestData.summary("5", machine: nil),
        ])
        let machines = HomeFilterTestMachines([
            HomeFilterTestData.machine("mac-1111", host: "old-host", name: " Mac "),
            HomeFilterTestData.machine("mac-2222", host: "Mac"),
            HomeFilterTestData.machine("debian", host: "debian", name: "  \n"),
            HomeFilterTestData.machine("unused", host: "No sessions"),
        ])
        let model = HomeFilterTestData.model(sessions: sessions, machines: machines)
        let options = model.machineFilters
        XCTAssertEqual(options.map(\.id), ["debian", "mac-1111", "mac-2222", "529e6566-history", unknownMachineFilterId])
        XCTAssertEqual(options.map(\.label), ["debian", "Mac · mac-1111", "Mac · mac-2222", "Machine · 529e6566", "Unknown machine"])
        sessions.sessions.reverse()
        sessions.sessions += (0..<1600).map { HomeFilterTestData.summary("extra-\($0)", machine: "mac-2222") }
        XCTAssertEqual(model.machineFilters.map(\.id), options.map(\.id))
        XCTAssertEqual(model.machineFilters.first { $0.id == "mac-2222" }?.sessionCount, 1601)
    }

    func testSingleSelectionIsIdempotentAndCountsStayUnfiltered() {
        let sessions = HomeFilterTestSessions([
            HomeFilterTestData.summary("a", machine: "mac"),
            HomeFilterTestData.summary("b", machine: "debian"),
            HomeFilterTestData.summary("c", machine: nil),
        ])
        let model = HomeFilterTestData.model(sessions: sessions)
        let options = model.machineFilters
        XCTAssertTrue(model.rows.allSatisfy { $0.meta?.contains(" · ") == true })
        model.selectMachine("mac")
        XCTAssertTrue(model.filters.isActive)
        XCTAssertEqual(model.rows.map(\.id), ["a"])
        XCTAssertEqual(model.rows.first?.meta, "workspace/hapi")
        XCTAssertEqual(model.filterSummary, "Machine: Machine · mac")
        model.selectMachine("mac")
        XCTAssertEqual(model.activeMachineFilter, "mac")
        XCTAssertEqual(model.machineFilters, options)
        model.selectMachine(unknownMachineFilterId)
        XCTAssertEqual(model.rows.map(\.id), ["c"])
        model.selectMachine(nil)
        XCTAssertNil(model.filterSummary)
        XCTAssertEqual(model.rows.count, 3)
        model.selectMachine("debian")
        model.clearFilters()
        XCTAssertEqual(model.filters, SessionListFilters())
    }

    func testMachineGoingOfflineDoesNotRemoveHistoricalFilter() {
        let sessions = HomeFilterTestSessions([
            HomeFilterTestData.summary("a", machine: "mac"),
            HomeFilterTestData.summary("b", machine: "debian"),
        ])
        let machines = HomeFilterTestMachines([HomeFilterTestData.machine("mac", host: "MacBook")])
        let model = HomeFilterTestData.model(sessions: sessions, machines: machines)
        model.selectMachine("mac")
        XCTAssertEqual(model.filterSummary, "Machine: MacBook")
        machines.machines = []
        model.reconcileFilters()
        XCTAssertEqual(model.activeMachineFilter, "mac")
        XCTAssertEqual(model.rows.map(\.id), ["a"])
        XCTAssertEqual(model.filterSummary, "Machine: Machine · mac")
    }

    func testVanishedSelectionDoesNotResurrectAndNewHomeStartsUnfiltered() {
        let a = HomeFilterTestData.summary("a", machine: "mac")
        let sessions = HomeFilterTestSessions([a, HomeFilterTestData.summary("b", machine: "debian")])
        let model = HomeFilterTestData.model(sessions: sessions)
        model.selectMachine("mac")
        XCTAssertFalse(HomeFilterTestData.model(sessions: sessions).filters.isActive)
        sessions.sessions.removeFirst()
        XCTAssertNil(model.activeMachineFilter)
        model.reconcileFilters()
        XCTAssertFalse(model.filters.isActive)
        sessions.sessions.append(a)
        XCTAssertNil(model.activeMachineFilter)
        model.selectMachine("not-a-session-group")
        XCTAssertFalse(model.filters.isActive)
        model.selectMachine("mac")
        sessions.sessions.removeAll { $0.id == "b" }
        model.reconcileFilters()
        XCTAssertFalse(model.filters.isActive, "One remaining group no longer needs a filter")
    }

    func testRefreshReadingAndExistingActionsStillUseTheSameStores() async throws {
        let sessions = HomeFilterTestSessions([
            HomeFilterTestData.summary("a", machine: "mac"),
            HomeFilterTestData.summary("b", machine: "debian"),
        ])
        let machines = HomeFilterTestMachines()
        let seen = LastSeenStore()
        let model = SessionListModel(sessionStore: sessions, machineStore: machines, lastSeenStore: seen, hubUrl: "test")
        await model.refresh()
        XCTAssertEqual(sessions.refreshCount, 1)
        XCTAssertEqual(machines.refreshCount, 1)
        XCTAssertTrue(model.hasLoaded)
        XCTAssertTrue(model.rows.allSatisfy { !$0.unread })
        sessions.sessions[0].updatedAt += 1
        model.onSessionOpened("a")
        XCTAssertEqual(seen.lastSeenAt("a"), sessions.sessions[0].updatedAt)
        model.setPinMode(sessionId: "b", mode: .global)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(model.rows.first?.id, "b")
        XCTAssertEqual(SessionListModel.pinnedCount(of: model.rows), 1)
        model.archiveSession(sessionId: "b")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(model.rows.map(\.id), ["a"])
        sessions.failRefresh = true
        await model.refresh()
        XCTAssertTrue(model.isOffline)
        XCTAssertEqual(model.rows.count, 1)
    }

    func testConnectionNoticeHasOneMessageAndHealthyStateIsEmpty() {
        XCTAssertNil(SessionConnectionNotice(state: .connected, showsCachedSessions: false).message)
        XCTAssertEqual(SessionConnectionNotice(state: .backoff(attempt: 2), showsCachedSessions: false).message, "Reconnecting…")
        XCTAssertEqual(SessionConnectionNotice(state: .backoff(attempt: 2), showsCachedSessions: true).message, "Offline — showing cached sessions")
        XCTAssertEqual(SessionConnectionNotice(state: .connected, showsCachedSessions: true).message, "Offline — showing cached sessions")
        let states: [SSEConnectionState] = [.idle, .connecting, .suspended]
        for state in states {
            XCTAssertNotNil(SessionConnectionNotice(state: state, showsCachedSessions: false).message)
        }
    }
}

/// In-memory observable stores: no networking, Keychain or disk snapshots.
@MainActor @Observable
final class HomeFilterTestSessions: SessionListStoring {
    var sessions: [SessionSummary]
    var refreshCount = 0
    var failRefresh = false
    init(_ sessions: [SessionSummary] = []) { self.sessions = sessions }
    func refresh() async throws {
        refreshCount += 1
        if failRefresh { throw URLError(.notConnectedToInternet) }
    }
    func scheduleRefresh() {}
    func fullResync() async throws { try await refresh() }
    func applySessionEvent(_ event: SyncEvent) {}
    func setPinMode(sessionId: String, mode: SessionPinMode) async throws {
        guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
        sessions[index].pinned = mode == .project
        sessions[index].globalPinned = mode == .global
        sessions = sortSessionSummaries(sessions)
    }
    func archiveSession(sessionId: String) async throws { sessions.removeAll { $0.id == sessionId } }
}

@MainActor @Observable
final class HomeFilterTestMachines: MachineListStoring {
    var machines: [Machine]
    var refreshCount = 0
    init(_ machines: [Machine] = []) { self.machines = machines }
    func refresh() async throws { refreshCount += 1 }
    func scheduleRefresh() {}
    func applyMachineEvent(machineId: String, data: MachineUpdatedData?) {}
}

@MainActor
enum HomeFilterTestData {
    static func model(sessions: HomeFilterTestSessions, machines: HomeFilterTestMachines = HomeFilterTestMachines()) -> SessionListModel {
        SessionListModel(sessionStore: sessions, machineStore: machines, lastSeenStore: LastSeenStore(), hubUrl: "test")
    }

    static func summary(_ id: String, machine: String?) -> SessionSummary {
        SessionSummary(id: id, active: true, thinking: false, activeAt: 1000, updatedAt: 1000,
                       metadata: SessionSummaryMetadata(name: "Review \(id)", path: "/workspace/hapi", machineId: machine, flavor: "codex"),
                       metadataVersion: 1, agentStateVersion: 1, todosUpdatedAt: 0, pendingRequestsCount: 0)
    }

    static func machine(_ id: String, host: String, name: String? = nil) -> Machine {
        Machine(id: id, namespace: "test", seq: 1, createdAt: 0, updatedAt: 0, active: true, activeAt: 0,
                metadata: MachineMetadata(host: host, platform: "darwin", happyCliVersion: "test", displayName: name),
                metadataVersion: 1, runnerStateVersion: 0)
    }
}
