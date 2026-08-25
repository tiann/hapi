import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Unit tests for the M2f `ChatPipeline` runner — the reduction path the
/// app's `ChatModel` drives (normalize memo → reduce → group with
/// `previousGroups`). Inputs come from real chat fixtures so the scripted
/// window states exercise the same wire shapes the golden suite does; the
/// golden byte-for-byte conformance itself lives in
/// `HapiProtocolTests/ChatFixtureTests`.
@Suite("Chat pipeline runner (M2f)")
struct ChatPipelineTests {
    // MARK: - Fixture plumbing (same #filePath scheme as PaginationFixtureTests)

    private struct FixtureDocument: Decodable {
        struct Input: Decodable {
            let messages: [DecryptedMessage]
            let agentState: AgentState?
        }

        let input: Input
    }

    private static func fixturesDirectory() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Tests/HapiClientTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // package root: ios/Packages/HapiKit
            .appendingPathComponent("../../../shared/fixtures")
            .standardizedFileURL
    }

    private static func loadFixture(_ fileName: String) throws -> FixtureDocument {
        let url = fixturesDirectory()
            .appendingPathComponent("chat")
            .appendingPathComponent(fileName)
        return try JSONDecoder().decode(FixtureDocument.self, from: Data(contentsOf: url))
    }

    /// Window rows for fixture messages. Unlike `WindowMessage(wire:)` —
    /// which maps a V8 hub page's collapsed `invokedAt` nil to the explicit
    /// null of a queued row — fixture inputs model historical rows, where an
    /// absent key means already-invoked. Mapping absence to `.absent` keeps
    /// them out of the queued filter, as on a real historical page.
    private static func windowRows(_ document: FixtureDocument) -> [WindowMessage] {
        document.input.messages.map { wire in
            WindowMessage(
                id: wire.id,
                seq: wire.seq,
                localId: wire.localId,
                content: wire.content,
                createdAt: wire.createdAt,
                invokedAt: wire.invokedAt.map(InvokedAtField.number) ?? .absent,
                scheduledAt: wire.scheduledAt
            )
        }
    }

    private static func blockIds(_ blocks: [VisibleChatBlock]) -> [String] {
        blocks.map { block in
            switch block {
            case .block(let value): return value.id
            case .toolGroup(let group): return group.id
            }
        }
    }

    private static func groupIds(_ blocks: [VisibleChatBlock]) -> [String] {
        blocks.compactMap { block in
            if case .toolGroup(let group) = block { return group.id }
            return nil
        }
    }

    // MARK: - Reduction path over scripted fixture windows

    @Test(
        "fixture windows reduce to non-empty stable-id blocks",
        arguments: [
            "claude-assistant-text.json",
            "claude-tool-use-result-pair.json",
            "codex-exploration-tool-group.json",
        ]
    )
    func reducesFixtureWindow(_ fileName: String) async throws {
        let document = try Self.loadFixture(fileName)
        let rows = Self.windowRows(document)
        let pipeline = ChatPipeline()

        let visible = await pipeline.run(
            messages: rows,
            agentState: document.input.agentState,
            hasMoreMessages: false
        )

        #expect(!visible.isEmpty, "\(fileName): expected rendered blocks")
        let ids = Self.blockIds(visible)
        #expect(ids.allSatisfy { !$0.isEmpty }, "\(fileName): empty stable id")
        #expect(Set(ids).count == ids.count, "\(fileName): duplicate stable ids \(ids)")
    }

    @Test func memoizedRecomputeIsStable() async throws {
        let document = try Self.loadFixture("claude-tool-use-result-pair.json")
        let rows = Self.windowRows(document)
        let pipeline = ChatPipeline()

        let first = await pipeline.run(
            messages: rows,
            agentState: document.input.agentState,
            hasMoreMessages: false
        )
        // Same row instances → every normalization is a memo hit; the
        // output must be value-identical (ids included).
        let second = await pipeline.run(
            messages: rows,
            agentState: document.input.agentState,
            hasMoreMessages: false
        )
        #expect(first == second)
        #expect(Self.blockIds(first) == Self.blockIds(second))
    }

    @Test func queuedNotInvokedRowsStayOutOfTheThread() async throws {
        let document = try Self.loadFixture("claude-assistant-text.json")
        var rows = Self.windowRows(document)
        // A queued composer row: user role, explicit-null invokedAt.
        rows.append(
            buildOptimisticMessage(
                localId: "local-queued-1",
                text: "queued follow-up",
                createdAt: 1_755_000_999_000,
                status: .queued
            )
        )
        let pipeline = ChatPipeline()

        let visible = await pipeline.run(messages: rows, agentState: nil, hasMoreMessages: false)

        #expect(!visible.isEmpty)
        #expect(
            !Self.blockIds(visible).contains("local-queued-1"),
            "queued-not-invoked rows belong to the composer bar, not the thread"
        )
    }

    // MARK: - Group-id stability via previousGroups

    @Test func groupIdSurvivesOlderHistoryArrival() async throws {
        let document = try Self.loadFixture("codex-exploration-tool-group.json")
        let allRows = Self.windowRows(document)
        // Drop the leading user prompt: the exploration group is now the
        // oldest visible block with more history behind it.
        let tailRows = Array(allRows.dropFirst())
        let pipeline = ChatPipeline()

        let truncated = await pipeline.run(
            messages: tailRows,
            agentState: document.input.agentState,
            hasMoreMessages: true
        )
        let truncatedGroupIds = Self.groupIds(truncated)
        #expect(truncatedGroupIds.count == 1, "expected one exploration group")

        // The older page lands (full window, no more history): the group no
        // longer starts at the oldest boundary, but previousGroups pins the
        // id it already rendered under.
        let complete = await pipeline.run(
            messages: allRows,
            agentState: document.input.agentState,
            hasMoreMessages: false
        )
        let completeGroupIds = Self.groupIds(complete)
        #expect(completeGroupIds == truncatedGroupIds, "group id must not change across recomputes")

        // Control: a fresh pipeline (no previousGroups) keys the same window
        // by its first tool instead — proof the pin above did the work.
        let fresh = await ChatPipeline().run(
            messages: allRows,
            agentState: document.input.agentState,
            hasMoreMessages: false
        )
        let freshGroupIds = Self.groupIds(fresh)
        #expect(freshGroupIds.count == 1)
        #expect(freshGroupIds != truncatedGroupIds)
    }
}
