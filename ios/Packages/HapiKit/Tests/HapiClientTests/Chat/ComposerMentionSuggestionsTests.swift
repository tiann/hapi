import Foundation
import HapiClient
import HapiProtocol
import Testing

@Suite("Composer @ suggestions")
struct ComposerMentionSuggestionsTests {
    private func query(_ text: String, caret: Int? = nil) -> ComposerMentionSuggestions.Query? {
        ComposerMentionSuggestions.query(in: text, selection: NSRange(location: caret ?? text.utf16.count, length: 0))
    }

    private func session(_ id: String, title: String? = nil, active: Bool = false,
                         updated: Int = 1, content: Bool? = true, archived: Bool = false,
                         agentId: String? = nil, flavor: String = "claude") -> SessionSummary {
        SessionSummary(hasConversationContent: content, id: id, active: active, thinking: false,
            activeAt: 0, updatedAt: updated,
            metadata: .init(name: title, path: "/work/project", machineId: "machine-1", flavor: flavor,
                agentSessionId: agentId, lifecycleState: archived ? "archived" : nil),
            metadataVersion: 1, agentStateVersion: 1, todosUpdatedAt: 0, pendingRequestsCount: 0)
    }

    @Test func triggersAtCaretWithWebBoundariesAndMultiwordSearch() {
        #expect(query("@")?.search == "")
        #expect(query("请参考 @项目")?.search == "项目")
        #expect(query("line\n@home assistant")?.search == "home assistant")
        #expect(query("@home ") == nil)
        #expect(query("@one two three") == nil)
        #expect(query("a@host") == nil)
        #expect(query("hello @peer, next") == nil)
        #expect(query("@peer\n") == nil)
        #expect(query("(@peer") == nil)
        #expect(query("") == nil)
        #expect(query("@peer", caret: 0) == nil)
        #expect(query("@peer", caret: 99) == nil)
        #expect(ComposerMentionSuggestions.query(in: "@peer", selection: NSRange(location: 1, length: 2)) == nil)
        #expect(query("hi \u{FFFC}@second")?.search == "second")
        #expect(query("@src/App.swift")?.search == "src/App.swift")
    }

    @Test func replacingTheWholeActiveTokenKeepsSuffixAndUTF16Caret() throws {
        let suggestion = ComposerMentionSuggestion(id: "session:peer", text: "[Peer](/sessions/peer)",
            label: "@Peer", detail: "peer", source: .session(active: false))
        let text = "😀 看 @peerOld, thanks"
        let caret = ("😀 看 @pe" as NSString).length
        let active = try #require(query(text, caret: caret))
        #expect(active.search == "pe")
        #expect((text as NSString).substring(with: active.range) == "@peerOld")
        let edit = try #require(ComposerMentionSuggestions.inserting(suggestion, into: text,
            selection: NSRange(location: caret, length: 0)))
        #expect(edit.text == "😀 看 [Peer](/sessions/peer) , thanks")
        #expect(edit.selection.location == "😀 看 [Peer](/sessions/peer) ".utf16.count)
        #expect(edit.selection.length == 0)
        #expect(query(edit.text, caret: edit.selection.location) == nil)
        #expect(ComposerMentionSuggestions.inserting(suggestion, into: "not a query", selection: .init(location: 3, length: 0)) == nil)
        let spaced = try #require(ComposerMentionSuggestions.inserting(suggestion, into: "see @peer next",
            selection: .init(location: "see @peer".utf16.count, length: 0)))
        #expect(spaced.text == "see [Peer](/sessions/peer) next")
        #expect(spaced.selection.location == "see [Peer](/sessions/peer)".utf16.count)
    }

    @Test func sessionReferencesEscapeMarkdownAndPreserveEmojiAtWebLimit() {
        #expect(ComposerMentionSuggestions.sessionReference(title: "  A [B] \\ C\nD ", id: "id /?#")
            == "[A \\[B\\] \\\\ C D](/sessions/id%20%2F%3F%23)")
        #expect(ComposerMentionSuggestions.sessionReference(title: "", id: "123456789") == "[12345678](/sessions/123456789)")
        let title = String(repeating: "x", count: 119) + "😀tail"
        #expect(ComposerMentionSuggestions.sessionReference(title: title, id: "id")
            == "[\(String(repeating: "x", count: 119))](/sessions/id)")
    }

    @Test func sessionPoolRequiresContentAndExcludesCurrentEmptyAndArchivedShortlist() {
        let pool = [session("current", title: "Current"), session("empty", title: "Named stub", content: false),
                    session("unknown", content: nil), session("archived", title: "Archive", archived: true),
                    session("untitled"), session("active", title: "Active", active: true)]
        let hits = ComposerMentionSuggestions.sessions(pool, query: "", excluding: "current")
        #expect(hits.map(\.id) == ["session:active", "session:untitled"])
        #expect(hits.last?.label == "@project")
        #expect(ComposerMentionSuggestions.sessions(pool, query: "archive", excluding: "current").map(\.id) == ["session:archived"])
        #expect(ComposerMentionSuggestions.sessions(pool, query: "stub", excluding: "current").isEmpty)
    }

    @Test func matchingUsesTitleIdPathMachineWildcardsAndEveryQueryTerm() {
        var prompt = session("prompt-session")
        prompt.metadata?.promptTitle = "Prompt title"
        let pool = [session("exact", title: "Fix"), session("prefix", title: "Fix tests", active: true),
                    session("contains", title: "Please fix"), session("fix-id", title: "Other"), prompt]
        #expect(ComposerMentionSuggestions.sessions(pool, query: "FIX", excluding: "current").map(\.id)
            == ["session:exact", "session:prefix", "session:contains", "session:fix-id"])
        #expect(ComposerMentionSuggestions.sessions(pool, query: "prompt title", excluding: "current").first?.label == "@Prompt title")
        #expect(ComposerMentionSuggestions.sessions(pool, query: "desktop project", excluding: "current", machineLabel: { _ in "Desktop" }).count == 5)
        #expect(ComposerMentionSuggestions.sessions(pool, query: "desktop missing", excluding: "current", machineLabel: { _ in "Desktop" }).isEmpty)
        #expect(ComposerMentionSuggestions.sessions(pool, query: "Fix*", excluding: "current").map(\.id) == ["session:prefix", "session:exact", "session:fix-id"])
        #expect(ComposerMentionSuggestions.sessions(pool, query: "", excluding: "current", limit: 2).count == 2)
    }

    @Test func deduplicationPrefersLiveSessionAndScopesNativeIdsByFlavor() {
        let pool = [session("old", title: "Old", updated: 99, agentId: "native"),
                    session("live", title: "Live", active: true, agentId: "native"),
                    session("codex", title: "Codex", agentId: "native", flavor: "codex")]
        #expect(Set(ComposerMentionSuggestions.sessions(pool, query: "", excluding: "current").map(\.id)) == ["session:live", "session:codex"])
        #expect(ComposerMentionSuggestions.sessions(pool, query: "Old", excluding: "current").isEmpty)
        #expect(ComposerMentionSuggestions.sessions(pool, query: "", excluding: "live").map(\.id) == ["session:codex"])
        let husks = [session("old", title: "Old", agentId: "native"),
                     session("live", active: true, content: false, agentId: "native")]
        #expect(ComposerMentionSuggestions.sessions(husks, query: "old", excluding: "current").isEmpty)
    }

    @Test func fileSerializationFollowsAgentSyntaxAndDeduplicates() {
        let file = FileSearchItem(fileName: "a.swift", filePath: "src", fullPath: "src/a \"b\"\\c.swift", fileType: "file")
        let codex = ComposerMentionSuggestions.files([file, file], flavor: "codex")
        #expect(codex.count == 1)
        #expect(codex.first?.text == "@\"src/a \\\"b\\\"\\\\c.swift\"")
        #expect(codex.first?.detail == "src")
        #expect(ComposerMentionSuggestions.files([file], flavor: "copilot").first?.text == "@src/a \"b\"\\c.swift")
        #expect(ComposerMentionSuggestions.files([file], flavor: "claude").isEmpty)
    }
}

private actor MentionSearchGate {
    var pending: [String: CheckedContinuation<FileSearchResponse, Never>] = [:]
    func search(_ query: String) async -> FileSearchResponse {
        await withCheckedContinuation { pending[query] = $0 }
    }
    func wait(_ query: String) async {
        while pending[query] == nil { await Task.yield() }
    }
    func finish(_ query: String, success: Bool = true) {
        pending.removeValue(forKey: query)?.resume(returning: .init(success: success, files: [
            FileSearchItem(fileName: query, filePath: "src", fullPath: "src/\(query)", fileType: "file"),
        ]))
    }
}

@Suite("Composer @ deferred files") @MainActor
struct ComposerMentionFilesTests {
    @Test func lateOldResponseCannotOverwriteNewQueryAndDismissClearsResults() async {
        let gate = MentionSearchGate()
        let model = ComposerMentionFiles(debounce: .zero) { await gate.search($0) }
        let old = ComposerMentionFiles.Request(query: "old", flavor: "codex")
        let new = ComposerMentionFiles.Request(query: "new", flavor: "codex")
        let first = Task { await model.load(old) }
        await gate.wait("old")
        let second = Task { await model.load(new) }
        await gate.wait("new")
        #expect(model.suggestions(for: old).isEmpty)
        await gate.finish("new")
        await second.value
        #expect(model.suggestions(for: new).map(\.text) == ["@\"src/new\""])
        await gate.finish("old")
        await first.value
        #expect(model.suggestions(for: new).map(\.text) == ["@\"src/new\""])
        await model.load(nil)
        #expect(model.suggestions(for: new).isEmpty)
    }

    @Test func cancelledAndFailedSearchNeverPublishesAndUnsupportedAgentsDoNotSearch() async {
        let gate = MentionSearchGate()
        let model = ComposerMentionFiles(debounce: .zero) { await gate.search($0) }
        let request = ComposerMentionFiles.Request(query: "cancel", flavor: "copilot")
        let task = Task { await model.load(request) }
        await gate.wait("cancel")
        task.cancel()
        await gate.finish("cancel")
        await task.value
        #expect(model.suggestions(for: request).isEmpty)
        let failed = ComposerMentionFiles.Request(query: "failed", flavor: "codex")
        let failure = Task { await model.load(failed) }
        await gate.wait("failed")
        await gate.finish("failed", success: false)
        await failure.value
        #expect(model.suggestions(for: failed).isEmpty)
        let noSearch = ComposerMentionFiles(debounce: .zero) { _ in
            Issue.record("Other agents must not perform file search")
            return .init(success: true, files: [])
        }
        await noSearch.load(.init(query: "anything", flavor: "claude"))
    }
}
