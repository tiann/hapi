import Foundation
@testable import HapiClient
import HapiProtocol
import Testing

/// Transcribes the web `sessionListSearch.test.ts` / Android
/// `SessionListSearchTest.kt` semantics for the iOS port.
@Suite("SessionListSearch")
struct SessionListSearchTests {
    private func summary(
        _ id: String,
        name: String? = nil,
        path: String = "/repo",
        summary: String? = nil,
        flavor: String? = nil,
        machineId: String? = nil,
        updatedAt: Int = 0,
        pinned: Bool? = nil,
        globalPinned: Bool? = nil,
        worktree: WorktreeMetadata? = nil
    ) -> SessionSummary {
        var row = storeSummary(id, updatedAt: updatedAt, pinned: pinned, globalPinned: globalPinned)
        row.metadata = SessionSummaryMetadata(
            name: name,
            path: path,
            machineId: machineId,
            summary: summary.map(SessionSummaryMetadata.Summary.init(text:)),
            flavor: flavor,
            worktree: worktree
        )
        return row
    }

    private func index(_ sessions: [SessionSummary], _ query: String) -> SessionListSearch.ScoreIndex? {
        SessionListSearch.scoreIndex(sessions: sessions, query: query) { $0 == "m1" ? "MacBook" : "" }
    }

    @Test func boundaryNeedsANonAlphanumericEdge() {
        #expect(SessionListSearch.hasBoundaryMatch("Home Assistant", "home"))
        #expect(SessionListSearch.hasBoundaryMatch("my home!", "home"))
        #expect(!SessionListSearch.hasBoundaryMatch("homelab", "home"))
        #expect(!SessionListSearch.hasBoundaryMatch("myhome", "home"))
        #expect(SessionListSearch.tokenize("  Home   ASSISTANT ") == ["home", "assistant"])
    }

    @Test func wildcardsMatchOnUnicodeScalars() {
        #expect(SessionListSearch.matchesQuery("/work/coding/hapi", "*coding?hapi"))
        #expect(!SessionListSearch.matchesQuery("/work/coding/hapi", "coding?hapi"))
        #expect(SessionListSearch.matchesQuery("a-b-c", "a*b*c"))
        #expect(!SessionListSearch.matchesQuery("a-b", "a*c"))
        #expect(SessionListSearch.matchesQuery("hapi", "hapi***"))
        #expect(SessionListSearch.matchesQuery("a😀b", "a?b"))
        #expect(!SessionListSearch.matchesQuery("a😀b", "a??b"))
    }

    @Test func blankQueryIsNoSearch() {
        #expect(index([summary("a")], "   ") == nil)
    }

    @Test func termsAndAcrossFieldsAndExactTitlesRankFirst() throws {
        let exact = summary("exact", name: "fix login bug", updatedAt: 1)
        let scrambled = summary("scrambled", name: "bug in login fix", updatedAt: 9)
        let machineOnly = summary("machine", name: "other", machineId: "m1")
        let neither = summary("neither", name: "fix")
        let result = try #require(index([exact, scrambled, machineOnly, neither], "fix login bug"))
        #expect(result.matches("exact") && result.matches("scrambled"))
        #expect(!result.matches("neither"), "every term must hit somewhere")
        #expect(result.scores["exact"] == 10 * 3 * 1.75 + 50)
        #expect(SessionListSearch.rank([scrambled, exact, neither], by: result).map(\.id) == ["exact", "scrambled"])

        let machine = try #require(index([machineOnly], "macbook"))
        #expect(machine.scores["machine"] == 2 * 1.75)
    }

    @Test func searchesWorktreeSummaryFlavorPathAndId() throws {
        let worktree = WorktreeMetadata(basePath: "/repo", branch: "feat", name: "", worktreePath: "/wt/devbox-branch")
        let row = summary("sess-9", path: "/data/hapi", summary: "Working on it", flavor: "claude", worktree: worktree)
        for query in ["devbox-branch", "working", "claude", "/data/hapi", "/wt", "sess-9"] {
            #expect(index([row], query)?.matches("sess-9") == true, "\(query)")
        }
    }

    @Test func rankingKeepsPinSectionsAndBreaksTiesByRecency() throws {
        let old = summary("old", name: "api", updatedAt: 1)
        let new = summary("new", name: "api", updatedAt: 5)
        let pinned = summary("pinned", name: "api tweaks", pinned: true)
        let global = summary("global", name: "the api", globalPinned: true)
        let result = try #require(index([old, new, pinned, global], "api"))
        #expect(SessionListSearch.rank([old, new, pinned, global], by: result).map(\.id)
            == ["global", "pinned", "new", "old"])
    }
}
