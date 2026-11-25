import Testing
@testable import HapiProtocol

@Suite("Native tool group identity")
struct ToolGroupIdentityTests {
    private func tool(_ id: String) -> ChatBlock {
        .toolCall(ToolCallBlock(
            id: id, localId: nil, createdAt: 0, invokedAt: nil,
            durationMs: nil, usage: nil, model: nil,
            tool: ChatToolCall(id: id, name: "Read", state: .completed, createdAt: 0),
            children: [], meta: nil
        ))
    }

    private var separator: ChatBlock {
        .agentText(AgentTextBlock(
            id: "text", localId: nil, createdAt: 0, invokedAt: nil,
            durationMs: nil, usage: nil, model: nil, text: "Between tool runs", meta: nil
        ))
    }

    private func groups(_ blocks: [ChatBlock], more: Bool = false,
                        previous: [ToolGroupBlock] = []) -> [ToolGroupBlock] {
        buildVisibleChatBlocks(blocks, options: .init(hasMoreMessages: more, previousGroups: previous))
            .compactMap { if case .toolGroup(let group) = $0 { group } else { nil } }
    }

    @Test(arguments: [false, true])
    func splittingAGroupCannotReuseItsIdentityTwice(_ more: Bool) {
        let tools = ["a", "b", "c", "d"].map(tool)
        let previous = groups(tools, more: more)
        let split = [tools[0], tools[1], separator, tools[2], tools[3]]
        let next = groups(split, more: more, previous: previous)
        #expect(next.count == 2)
        #expect(Set(next.map(\.id)).count == 2)
        #expect(next.filter { $0.id == previous[0].id }.count == 1)
        #expect(next.flatMap(\.tools).map(\.id) == ["a", "b", "c", "d"])
        #expect(groups(split, more: more, previous: next).map(\.id) == next.map(\.id))
    }

    @Test func aFallbackCannotCollideWithAnAlreadyClaimedHistoricalId() {
        let original = groups([tool("c"), tool("d")]) // tool-group:c
        let grown = groups(["a", "b", "c", "d"].map(tool), previous: original)
        let split = [tool("a"), tool("b"), separator, tool("c"), tool("d")]
        let next = groups(split, previous: grown)
        #expect(next[0].id == original[0].id)
        #expect(next[1].id != next[0].id)
        #expect(groups(split, previous: next).map(\.id) == next.map(\.id))
    }

    @Test func prependingANewGroupCannotStealALaterGroupsHistoricalId() {
        let original = groups(["c", "d", "e"].map(tool)) // tool-group:c
        let trimmed = groups([tool("d"), tool("e")], previous: original)
        let prepended = [tool("a"), tool("b"), tool("c"), separator, tool("d"), tool("e")]
        let next = groups(prepended, more: true, previous: trimmed)
        #expect(next.count == 2)
        #expect(next[0].id != next[1].id)
        #expect(next[1].id == original[0].id)
        #expect(groups(prepended, more: true, previous: next).map(\.id) == next.map(\.id))
    }

    @Test func bothBoundaryCollisionsUseAStableSuffixWithoutDroppingBlocks() {
        guard case .agentText(var left) = separator, case .agentText(var right) = separator else { return }
        left.id = "tool-group:a"
        right.id = "tool-group:b"
        let blocks: [ChatBlock] = [.agentText(left), tool("a"), tool("b"), .agentText(right)]
        let visible = buildVisibleChatBlocks(blocks, options: .init(hasMoreMessages: false))
        let next = groups(blocks)
        #expect(visible.count == 3)
        #expect(next[0].id == "tool-group:a#2")
        #expect(groups(blocks, previous: next).map(\.id) == next.map(\.id))
    }
}
