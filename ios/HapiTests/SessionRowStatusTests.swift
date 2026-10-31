import HapiClient
import HapiProtocol
import XCTest
@testable import Hapi

@MainActor
final class SessionRowStatusTests: XCTestCase {
    func testAuthoritativeKindsDetermineAttentionWithoutGuessingFromTools() {
        let cases: [([PendingRequestKind], SessionRowStatus)] = [
            ([.input], .needsReply(7)),
            ([.permission], .needsApproval(7)),
            ([.input, .permission], .needsAttention(7)),
            ([.permission, .input], .needsAttention(7)),
            ([], .needsAttention(7)),
        ]
        for (kinds, expected) in cases {
            var summary = HomeFilterTestData.summary("a", machine: "mac")
            summary.pendingRequestsCount = 7
            summary.pendingRequestKinds = kinds
            // Deliberately misleading and capped: neither its length nor
            // its first tool can replace the authoritative total/kinds.
            summary.pendingRequests = [.init(id: "r", kind: .input, tool: "request_user_input", since: 0)]
            XCTAssertEqual(SessionRowStatus(summary: summary), expected)
            XCTAssertEqual(SessionRowStatus(summary: summary)?.count, 7)
        }
    }

    func testPendingWinsOverThinkingAndSurvivesDisconnection() {
        var summary = HomeFilterTestData.summary("a", machine: nil)
        summary.thinking = true
        XCTAssertEqual(SessionRowStatus(summary: summary), .running)
        summary.pendingRequestsCount = 1
        summary.pendingRequestKinds = [.input]
        XCTAssertEqual(SessionRowStatus(summary: summary), .needsReply(1))
        summary.active = false
        XCTAssertEqual(SessionRowStatus(summary: summary), .needsReply(1))
        summary.pendingRequestsCount = 0
        XCTAssertNil(SessionRowStatus(summary: summary), "Stale kinds and thinking do not imply pending/connected activity")
        summary.active = true
        XCTAssertEqual(SessionRowStatus(summary: summary), .running)
        summary.thinking = false
        XCTAssertNil(SessionRowStatus(summary: summary))
    }

    func testReadingDoesNotResolveAttentionAndResolutionKeepsTheProject() {
        var summary = HomeFilterTestData.summary("a", machine: "mac")
        summary.metadata?.summary = .init(text: "Keep the session context visible")
        summary.pendingRequestsCount = 2
        summary.pendingRequestKinds = [.permission]
        let sessions = HomeFilterTestSessions([summary])
        let model = HomeFilterTestData.model(sessions: sessions)
        XCTAssertTrue(model.rows[0].unread)
        XCTAssertEqual(model.rows[0].status, .needsApproval(2))

        model.onSessionOpened("a")
        XCTAssertFalse(model.rows[0].unread)
        XCTAssertEqual(model.rows[0].status, .needsApproval(2))
        XCTAssertEqual(model.rows[0].project, "hapi")

        sessions.sessions[0].pendingRequestsCount = 0
        sessions.sessions[0].pendingRequestKinds = []
        XCTAssertNil(model.rows[0].status)
        XCTAssertEqual(model.rows[0].project, "hapi")
        sessions.sessions[0].thinking = true
        XCTAssertEqual(model.rows[0].status, .running)
        sessions.sessions[0].updatedAt += 1
        XCTAssertTrue(model.rows[0].unread, "Existing updatedAt-based unread semantics stay intact")
    }

    func testMissingMetadataDoesNotCreatePlaceholderContent() {
        var summary = HomeFilterTestData.summary("a", machine: nil)
        summary.metadata = nil
        let model = HomeFilterTestData.model(sessions: HomeFilterTestSessions([summary]))
        XCTAssertNil(model.rows[0].status)
        XCTAssertNil(model.rows[0].project)
    }

    func testProjectIsOnlyTheRepositoryNameIncludingWorktreesAndWindowsPaths() {
        var summary = HomeFilterTestData.summary("a", machine: "mac")
        XCTAssertEqual(SessionListModel.projectLabel(summary), "hapi")
        summary.metadata?.path = "C:\\workspace\\hapi\\"
        XCTAssertEqual(SessionListModel.projectLabel(summary), "hapi")
        summary.metadata?.path = "/tmp/checkouts/generated-branch"
        summary.metadata?.worktree = .init(basePath: "/workspace/hapi", branch: "feature", name: "generated-branch")
        XCTAssertEqual(SessionListModel.projectLabel(summary), "hapi")
        summary.metadata?.worktree = nil
        summary.metadata?.path = "/"
        XCTAssertNil(SessionListModel.projectLabel(summary))
    }

    func testStatusCopyIsHumanFacing() {
        XCTAssertEqual(SessionRowStatus.needsReply(1).titleKey, "Needs reply")
        XCTAssertEqual(SessionRowStatus.needsApproval(2).titleKey, "Needs approval")
        XCTAssertEqual(SessionRowStatus.needsAttention(7).titleKey, "Needs attention")
        XCTAssertEqual(SessionRowStatus.running.titleKey, "Running")
        XCTAssertNil(SessionRowStatus.running.count)
    }
}
