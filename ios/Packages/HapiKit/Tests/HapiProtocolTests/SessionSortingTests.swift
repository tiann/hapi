import Foundation
import HapiProtocol
import Testing

/// Pins the exact `sortSessionSummaries` order from `web/src/hooks/useSSE.ts`
/// (transcribed from the Android reference suite, `SessionSortingTest.kt`).
@Suite("Session sorting")
struct SessionSortingTests {

    private func summary(
        _ id: String,
        active: Bool = false,
        updatedAt: Int = 0,
        pinned: Bool? = nil,
        globalPinned: Bool? = nil,
        pendingRequestsCount: Int = 0
    ) -> SessionSummary {
        SessionSummary(
            id: id,
            active: active,
            thinking: false,
            activeAt: 0,
            updatedAt: updatedAt,
            pinned: pinned,
            globalPinned: globalPinned,
            metadata: nil,
            metadataVersion: 0,
            agentStateVersion: 0,
            todosUpdatedAt: 0,
            todoProgress: nil,
            pendingRequestsCount: pendingRequestsCount,
            pendingRequestKinds: [],
            pendingRequests: [],
            backgroundTaskCount: 0,
            futureScheduledMessageCount: 0,
            nextScheduledAt: nil,
            model: nil,
            modelReasoningEffort: nil,
            effort: nil
        )
    }

    @Test func globalPinnedBeatsPinnedBeatsActiveBeatsRecency() {
        let sorted = sortSessionSummaries([
            summary("recent-inactive", updatedAt: 9_000),
            summary("active", active: true, updatedAt: 1_000),
            summary("pinned", updatedAt: 500, pinned: true),
            summary("global", updatedAt: 100, globalPinned: true),
        ])
        #expect(sorted.map(\.id) == ["global", "pinned", "active", "recent-inactive"])
    }

    @Test func amongActiveSessionsPendingRequestsCountDescendsBeforeUpdatedAt() {
        let sorted = sortSessionSummaries([
            summary("a", active: true, updatedAt: 9_000, pendingRequestsCount: 0),
            summary("b", active: true, updatedAt: 1_000, pendingRequestsCount: 2),
            summary("c", active: true, updatedAt: 5_000, pendingRequestsCount: 1),
        ])
        #expect(sorted.map(\.id) == ["b", "c", "a"])
    }

    @Test func inactiveSessionsIgnorePendingRequestsCountWebLeftActiveGuard() {
        let sorted = sortSessionSummaries([
            summary("low-pending-recent", updatedAt: 9_000, pendingRequestsCount: 0),
            summary("high-pending-old", updatedAt: 1_000, pendingRequestsCount: 5),
        ])
        #expect(sorted.map(\.id) == ["low-pending-recent", "high-pending-old"])
    }

    @Test func pinnedSectionsSortByRecencyWithinThemselves() {
        let sorted = sortSessionSummaries([
            summary("g-old", updatedAt: 100, globalPinned: true),
            summary("p-new", updatedAt: 9_000, pinned: true),
            summary("g-new", updatedAt: 5_000, globalPinned: true),
            summary("p-old", updatedAt: 200, pinned: true),
        ])
        #expect(sorted.map(\.id) == ["g-new", "g-old", "p-new", "p-old"])
    }

    @Test func nilPinFlagsCountAsFalseAndTiesKeepPriorOrderStable() {
        let a = summary("a", updatedAt: 1_000, pinned: nil)
        let b = summary("b", updatedAt: 1_000, pinned: false)
        let c = summary("c", updatedAt: 1_000)
        #expect(sortSessionSummaries([a, b, c]).map(\.id) == ["a", "b", "c"])
        #expect(sortSessionSummaries([c, b, a]).map(\.id) == ["c", "b", "a"])
    }

    @Test func updatedAtComparisonSurvivesLongDeltas() {
        // Long-range timestamps must not overflow a narrower subtraction
        // (the comparator compares, never subtracts).
        let sorted = sortSessionSummaries([
            summary("old", updatedAt: 1_000),
            summary("new", updatedAt: 1_000 + Int(Int32.max) * 3),
        ])
        #expect(sorted.map(\.id) == ["new", "old"])
    }
}
