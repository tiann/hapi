import Foundation
import HapiClient
import HapiProtocol
import Testing

@MainActor
@Suite("LastSeenStore")
struct LastSeenStoreTests {
    @Test func markSeenPersistsRevisionAndOutboxBeforeReturning() async {
        let directory = makeTempDirectory()
        let store = LastSeenStore(snapshotDirectory: directory, namespace: "alice")
        await store.markSeen(sessionId: "s1", revision: 7)
        await store.markSeen(sessionId: "s1", revision: 3)
        let cold = LastSeenStore(snapshotDirectory: directory, namespace: "alice")
        #expect(cold.lastSeenAt("s1") == 7)
        #expect(cold.state.pending["s1"]?.request.readRevision == 7)
        #expect(LastSeenStore(snapshotDirectory: directory, namespace: "bob").lastSeenAt("s1") == 0)
        #expect(LastSeenStore(snapshotDirectory: makeTempDirectory(), namespace: "alice").lastSeenAt("s1") == 0)
    }

    @Test func unreadIgnoresMetadataAndIncludesRunningOutput() async {
        let store = LastSeenStore()
        var row = storeSummary("s1", updatedAt: 999_999)
        #expect(!LastSeenStore.isUnread(row, state: store.state))
        row.contentRevision = 2
        #expect(LastSeenStore.isUnread(row, state: store.state))
        row.active = true
        row.thinking = true
        #expect(LastSeenStore.isUnread(row, state: store.state))
        row.active = false
        #expect(LastSeenStore.isUnread(row, state: store.state))
        await store.markSeen(sessionId: "s1", revision: 1)
        #expect(LastSeenStore.isUnread(row, state: store.state))
        row.readState = SessionReadState(readRevision: 2, version: 1)
        #expect(!LastSeenStore.isUnread(row, state: store.state))
        row.readState = SessionReadState(readRevision: 2, manualUnread: true, version: 2)
        #expect(LastSeenStore.isUnread(row, state: store.state))
    }

    @Test func followedTailHidesOnlyOrdinaryUnread() async {
        let store = LastSeenStore()
        var row = storeSummary("s1", updatedAt: 1)
        row.contentRevision = 2
        store.setFollowingTail("s1", true)
        store.setFollowingTail("s1", true)
        #expect(!LastSeenStore.isUnread(row, state: store.state, followedTails: store.followedTails))
        row.readState = SessionReadState(readRevision: 0, manualUnread: true, version: 1)
        #expect(LastSeenStore.isUnread(row, state: store.state, followedTails: store.followedTails))
        row.readState = nil
        store.setFollowingTail("s1", false)
        #expect(!LastSeenStore.isUnread(row, state: store.state, followedTails: store.followedTails))
        store.setFollowingTail("s1", false)
        #expect(store.followedTails.isEmpty)
        #expect(LastSeenStore.isUnread(row, state: store.state, followedTails: store.followedTails))
        #expect(store.lastSeenAt("s1") == 0)
    }

    @Test func staleReadCannotClearANewerManualChoice() async {
        let store = LastSeenStore()
        var row = storeSummary("s1", updatedAt: 1)
        row.contentRevision = 4
        let observed = SessionReadState(readRevision: 0, version: 1)
        await store.markSeen(sessionId: "s1", revision: 4, serverState: observed)
        row.readState = SessionReadState(readRevision: 4, manualUnread: true, version: 2)
        #expect(LastSeenStore.isUnread(row, state: store.state))
        await store.markSeen(sessionId: "s1", revision: 4, serverState: row.readState)
        #expect(!LastSeenStore.isUnread(row, state: store.state))
    }

    @Test func reconnectSendsPersistedObservedRevision() async {
        let directory = makeTempDirectory()
        let offline = LastSeenStore(snapshotDirectory: directory)
        await offline.markSeen(sessionId: "s1", revision: 3, serverState: SessionReadState(version: 2))
        let cold = LastSeenStore(snapshotDirectory: directory)
        let received = ReadStateRequests()
        await cold.configure(namespace: "default") { id, request in
            await received.append(id, request)
            return SessionReadState(readRevision: request.readRevision ?? 0, version: 3)
        }
        for _ in 0..<200 where !cold.state.pending.isEmpty {
            try? await Task.sleep(for: .milliseconds(5))
        }
        #expect(cold.state.pending.isEmpty)
        #expect(await received.requests == [SessionReadStateRequest(readRevision: 3, expectedVersion: 2)])
        let reloaded = LastSeenStore(snapshotDirectory: directory)
        #expect(reloaded.state.pending.isEmpty)
        #expect(reloaded.state.server["s1"]?.readRevision == 3)
        cold.shutdown()
    }

    @Test func persistenceFailureDoesNotClaimRead() async throws {
        let file = makeTempDirectory().appendingPathComponent("file")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: file)
        let store = LastSeenStore(snapshotDirectory: file)
        await store.markSeen(sessionId: "s1", revision: 3)
        #expect(store.lastSeenAt("s1") == 0)
        #expect(store.state.pending.isEmpty)
        #expect(store.persistenceError != nil)
    }
}

private actor ReadStateRequests {
    var requests: [SessionReadStateRequest] = []
    func append(_ id: String, _ request: SessionReadStateRequest) { requests.append(request) }
}
