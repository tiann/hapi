import Foundation
import HapiProtocol
import Testing

/// Stream-id identity rules for the timeline reducer: streamed reasoning/text
/// blocks must take their identity from the (non-blank) stream id, and blank
/// stream ids — which are not streams per shared/src/messages.ts — must fall
/// back to row-derived ids instead of colliding onto one blank identity.
@Suite("Chat stream identity")
struct ChatStreamIdentityTests {
    private static func agentMessage(_ id: String, text: String, streamId: String?) -> NormalizedMessage {
        NormalizedMessage(
            id: id,
            createdAt: 1_700_000_000_000,
            content: .agent([.reasoning(.init(text: text, uuid: id, streamId: streamId))])
        )
    }

    private static func textMessage(_ id: String, text: String, streamId: String?) -> NormalizedMessage {
        NormalizedMessage(
            id: id,
            createdAt: 1_700_000_000_000,
            content: .agent([.text(.init(text: text, uuid: id, streamId: streamId))])
        )
    }

    private static func reasoningIds(_ messages: [NormalizedMessage]) -> [String] {
        reduceChatBlocks(messages, agentState: nil).blocks.compactMap { $0.asAgentReasoning?.id }
    }

    private static func textIds(_ messages: [NormalizedMessage]) -> [String] {
        reduceChatBlocks(messages, agentState: nil).blocks.compactMap { $0.asAgentText?.id }
    }

    @Test("reasoning blocks take the stream id as their identity")
    func reasoningIdentityUsesStreamId() {
        let rows = [
            Self.agentMessage("row-1", text: "partial", streamId: "stream-1"),
            Self.agentMessage("row-2", text: "partial extended", streamId: "stream-1")
        ]

        #expect(Self.reasoningIds(rows) == ["stream-1"])
    }

    @Test("text blocks take the stream id as their identity")
    func textIdentityUsesStreamId() {
        let rows = [
            Self.textMessage("row-1", text: "partial", streamId: "stream-1"),
            Self.textMessage("row-2", text: "partial extended", streamId: "stream-1")
        ]

        #expect(Self.textIds(rows) == ["stream-1"])
    }

    @Test("blank reasoning stream ids fall back to distinct row-derived ids")
    func blankReasoningStreamIdsFallBackToRowIds() {
        let rows = [
            Self.agentMessage("blank-1", text: "one", streamId: ""),
            Self.agentMessage("blank-2", text: "two", streamId: "   ")
        ]

        #expect(Self.reasoningIds(rows) == ["blank-1:0", "blank-2:0"])
    }

    @Test("blank text stream ids fall back to distinct row-derived ids")
    func blankTextStreamIdsFallBackToRowIds() {
        let rows = [
            Self.textMessage("blank-1", text: "one", streamId: ""),
            Self.textMessage("blank-2", text: "two", streamId: "   ")
        ]

        #expect(Self.textIds(rows) == ["blank-1:0", "blank-2:0"])
    }
}
