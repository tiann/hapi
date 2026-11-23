import HapiClient
import XCTest
@testable import Hapi
@testable import HapiProtocol

/// Home-list rename/delete/reopen forwarding over in-memory stores: no
/// networking, Keychain or disk snapshots.
@MainActor
final class SessionLifecycleActionTests: XCTestCase {
    private final class Drafts: ChatDrafts {
        var storage: [String: String] = [:]
        func load(sessionId: String) -> String? { storage[sessionId] }
        func save(sessionId: String, text: String) { storage[sessionId] = text }
        func clear(sessionId: String) { storage[sessionId] = nil }
        func move(fromSessionId: String, toSessionId: String) {
            storage[toSessionId] = storage.removeValue(forKey: fromSessionId)
        }
    }

    private func makeModel(_ sessions: HomeFilterTestSessions, drafts: Drafts? = nil) -> SessionListModel {
        SessionListModel(
            sessionStore: sessions,
            machineStore: HomeFilterTestMachines(),
            lastSeenStore: LastSeenStore(),
            hubUrl: "test",
            drafts: drafts
        )
    }

    private func waitUntil(_ condition: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<200 where !condition() {
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    func testRenameTrimsAndIgnoresBlankNames() async {
        let sessions = HomeFilterTestSessions([HomeFilterTestData.summary("s1", machine: "m1")])
        let model = makeModel(sessions)

        model.renameSession(sessionId: "s1", name: "   ")
        model.renameSession(sessionId: "s1", name: "  Release prep ")

        await waitUntil { sessions.sessions.first?.metadata?.name == "Release prep" }
        XCTAssertTrue(SessionNameRules.isValid(" x "))
        XCTAssertFalse(SessionNameRules.isValid("  "))
        XCTAssertFalse(SessionNameRules.isValid(String(repeating: "a", count: 256)))
    }

    func testDeleteConflictAsksToArchiveFirst() async {
        let sessions = HomeFilterTestSessions([HomeFilterTestData.summary("s1", machine: "m1")])
        sessions.deleteError = APIError(status: 409, code: "Cannot delete active session. Archive it first.")
        let model = makeModel(sessions)

        model.deleteSession(sessionId: "s1")

        await waitUntil { model.actionError != nil }
        XCTAssertEqual(model.actionError, String(localized: "Active sessions can't be deleted — archive first"))
        XCTAssertEqual(sessions.sessions.map(\.id), ["s1"])
    }

    func testReopenFollowsASupersedingSessionWithItsDraft() async {
        let sessions = HomeFilterTestSessions([HomeFilterTestData.summary("old", machine: "m1")])
        sessions.reopenTarget = "new"
        let drafts = Drafts()
        drafts.storage["old"] = "unsent"
        let model = makeModel(sessions, drafts: drafts)
        var opened: [String] = []

        model.reopenSession(sessionId: "old") { opened.append($0) }

        await waitUntil { opened == ["new"] }
        XCTAssertEqual(drafts.storage, ["new": "unsent"])
    }

    func testReopenFailureShowsTheHubMessage() async {
        let sessions = HomeFilterTestSessions([HomeFilterTestData.summary("old", machine: "m1")])
        sessions.reopenError = APIError(
            status: 422,
            body: #"{"error":"Session metadata is incomplete","missing":["path"]}"#
        )
        let model = makeModel(sessions)
        var opened: [String] = []

        model.reopenSession(sessionId: "old") { opened.append($0) }

        await waitUntil { model.actionError != nil }
        XCTAssertEqual(model.actionError, "Session metadata is incomplete (missing: path)")
        XCTAssertTrue(opened.isEmpty)
    }
}
