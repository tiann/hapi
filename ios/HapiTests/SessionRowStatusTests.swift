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

    func testPendingSurvivesDisconnectionAndActivityStaysOnTheBadge() {
        var summary = HomeFilterTestData.summary("a", machine: nil)
        summary.thinking = true
        XCTAssertNil(SessionRowStatus(summary: summary), "Work is the presence badge, not an attention symbol")
        XCTAssertEqual(SessionPresence(summary: summary), .working)
        summary.pendingRequestsCount = 1
        summary.pendingRequestKinds = [.input]
        XCTAssertEqual(SessionRowStatus(summary: summary), .needsReply(1))
        XCTAssertEqual(SessionPresence(summary: summary), .working, "A request does not hide the working badge")
        summary.active = false
        XCTAssertEqual(SessionRowStatus(summary: summary), .needsReply(1))
        XCTAssertEqual(SessionPresence(summary: summary), .stopped, "Stale thinking does not imply activity")
        summary.pendingRequestsCount = 0
        XCTAssertNil(SessionRowStatus(summary: summary), "Stale kinds do not imply a pending request")
    }

    /// Web #2296: every state has its own mark, none is an absent badge.
    func testPresenceGivesEveryStateItsOwnMark() {
        var summary = HomeFilterTestData.summary("a", machine: nil)
        XCTAssertEqual(SessionPresence(summary: summary), .waiting)
        summary.backgroundTaskCount = 2
        XCTAssertEqual(SessionPresence(summary: summary), .background)
        summary.thinking = true
        XCTAssertEqual(SessionPresence(summary: summary), .working, "A turn outranks background tasks")
        summary.active = false
        XCTAssertEqual(SessionPresence(summary: summary), .stopped)
        summary.thinking = false
        XCTAssertEqual(SessionPresence(summary: summary), .stopped, "Background counts need a connected CLI")
        XCTAssertEqual([SessionPresence.working, .background, .waiting, .stopped].map(\.pulses),
                       [true, true, false, false])
    }

    /// Work that outlives the agent keeps the row live (web #1404 / #2296).
    func testRunningAttachedJobIsWorkEvenWhenTheAgentIsGone() {
        var summary = HomeFilterTestData.summary("a", machine: nil)
        summary.active = false
        summary.attachedJob = AttachedJob(key: "k", label: "Import", heartbeatAt: 0, startedAt: 0, updatedAt: 0)
        XCTAssertEqual(SessionPresence(summary: summary), .working)
        summary.active = true
        XCTAssertEqual(SessionPresence(summary: summary), .working)
        summary.backgroundTaskCount = 1
        XCTAssertEqual(SessionPresence(summary: summary), .background, "Same precedence as web")
        summary.backgroundTaskCount = 0
        summary.active = false
        summary.attachedJob?.status = .completed
        XCTAssertEqual(SessionPresence(summary: summary), .stopped, "A finished job is not work")
    }

    func testAttachedJobLineSaysProgressAndElapsedAndAdmitsStaleness() {
        let minute = 60_000
        var job = AttachedJob(key: "k", label: "Import", done: 12, total: 30, unit: "files",
                              heartbeatAt: 0, startedAt: 0, updatedAt: 0)
        job.heartbeatAt = 184 * minute
        XCTAssertEqual(AttachedJobLine.text(job, nowMs: 185 * minute),
                       "Import · 40% · 12/30 files · 3h 5m")
        job.remaining = 18
        job.heartbeatAt = 5 * minute
        XCTAssertEqual(AttachedJobLine.text(job, nowMs: 5 * minute), "Import · 18 files left · 5m",
                       "Remaining wins, as on web")
        job.remaining = nil
        job.total = nil
        job.heartbeatAt = 0
        XCTAssertEqual(AttachedJobLine.text(job, nowMs: 0), "Import · <1m")
        XCTAssertEqual(AttachedJobLine.text(job, nowMs: 20 * minute), "Import · no heartbeat 20m",
                       "A frozen job is not passed off as live")
    }

    func testReadingDoesNotResolveAttentionAndResolutionKeepsTheProject() async throws {
        var summary = HomeFilterTestData.summary("a", machine: "mac")
        summary.metadata?.summary = .init(text: "Keep the session context visible")
        summary.contentRevision = 1
        summary.pendingRequestsCount = 2
        summary.pendingRequestKinds = [.permission]
        let sessions = HomeFilterTestSessions([summary])
        let model = HomeFilterTestData.model(sessions: sessions)
        XCTAssertTrue(model.rows[0].unread)
        XCTAssertEqual(model.rows[0].status, .needsApproval(2))

        model.markAllRead()
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertFalse(model.rows[0].unread)
        XCTAssertEqual(model.rows[0].status, .needsApproval(2))
        XCTAssertEqual(model.rows[0].project, "hapi")

        sessions.sessions[0].pendingRequestsCount = 0
        sessions.sessions[0].pendingRequestKinds = []
        XCTAssertNil(model.rows[0].status)
        XCTAssertEqual(model.rows[0].project, "hapi")
        sessions.sessions[0].thinking = true
        XCTAssertNil(model.rows[0].status)
        XCTAssertEqual(model.rows[0].presence, .working)
        sessions.sessions[0].updatedAt += 1
        XCTAssertFalse(model.rows[0].unread, "Metadata changes do not create unread output")
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
        XCTAssertEqual(SessionPresence.working.titleKey, "Running")
        XCTAssertEqual(SessionPresence.background.titleKey, "Background tasks running")
        XCTAssertEqual(SessionPresence.waiting.titleKey, "Connected")
        XCTAssertEqual(SessionPresence.stopped.titleKey, "Stopped")
    }
}
