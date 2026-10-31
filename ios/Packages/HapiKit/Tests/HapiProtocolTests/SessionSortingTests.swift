import Foundation
import HapiProtocol
import Testing

@Suite("User-activity session sorting")
struct SessionSortingTests {
    private func summary(_ id: String, createdAt: Int = 0, at: Int? = nil) -> SessionSummary {
        SessionSummary(id: id, active: false, thinking: false, activeAt: 0, updatedAt: 0,
                       createdAt: createdAt, lastUserMessageAt: at, metadataVersion: 0,
                       agentStateVersion: 0, todosUpdatedAt: 0, pendingRequestsCount: 0)
    }

    @Test func outputAndStatusDoNotReorderButNewInputDoes() {
        var old = summary("old", createdAt: 1, at: 100)
        let new = summary("new", createdAt: 2, at: 200)
        old.updatedAt = 90_000
        old.active = true
        old.thinking = true
        old.pendingRequestsCount = 4
        #expect(sortSessionSummaries([old, new]).map(\.id) == ["new", "old"])
        old.lastUserMessageAt = 300
        #expect(sortSessionSummaries([old, new]).map(\.id) == ["old", "new"])
    }

    @Test func manualPinsStillComeFirst() {
        var global = summary("global", at: 1)
        global.globalPinned = true
        var project = summary("project", at: 2)
        project.pinned = true
        #expect(sortSessionSummaries([summary("new", at: 99), project, global]).map(\.id) == ["global", "project", "new"])
    }

    @Test func creationFallbackAndTimestampTiesAreDeterministic() {
        let rows = [summary("b", createdAt: 2), summary("a", createdAt: 2), summary("old", createdAt: 1)]
        #expect(sortSessionSummaries(rows).map(\.id) == ["a", "b", "old"])
        #expect(sortSessionSummaries(rows.reversed()).map(\.id) == ["a", "b", "old"])
    }

    @Test func patchClockIsMonotonicAndRenderRelevant() throws {
        let row = summary("a", at: 100)
        let patch = try JSONDecoder().decode(SessionPatch.self, from: Data("{\"lastUserMessageAt\":200}".utf8))
        let next = SummaryPatching.applySessionSummaryPatch(row, patch)
        #expect(next.lastUserMessageAt == 200)
        #expect(!SummaryPatching.isRenderIrrelevantPatch(current: row, next: next))
        #expect(SummaryPatching.applySessionSummaryPatch(next, SessionPatch(lastUserMessageAt: 50)).lastUserMessageAt == 200)
    }
}
