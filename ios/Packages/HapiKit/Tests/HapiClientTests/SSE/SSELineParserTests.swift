import Foundation
import Testing
@testable import HapiClient

@Suite("SSE line parser")
struct SSELineParserTests {
    private func frames(_ text: String) -> [SSEFrame] {
        var parser = SSELineParser()
        return parser.consume(Data(text.utf8))
    }

    @Test func joinsMultiLineDataWithNewline() {
        let result = frames("data: line1\ndata: line2\ndata: line3\n\n")
        #expect(result == [SSEFrame(data: "line1\nline2\nline3")])
    }

    @Test func emitsIdOnlyForTheBlockThatCarriedIt() {
        // A dispatched id is consumed; the next block starts with no id.
        // Cursor stickiness across id-less frames is the caller's job.
        let result = frames("id: 018f:1:aa\ndata: first\n\ndata: second\n\n")
        #expect(result.count == 2)
        #expect(result[0] == SSEFrame(id: "018f:1:aa", data: "first"))
        #expect(result[1].id == nil)
        #expect(result[1].data == "second")
    }

    @Test func heartbeatShapedFrameHasNilId() {
        let result = frames("id: 42\ndata: {\"a\":1}\n\ndata: {\"type\":\"heartbeat\"}\n\n")
        #expect(result.map(\.id) == ["42", nil])
    }

    @Test func idFromNonDispatchedBlockTagsNextDispatch() {
        // Mirrors the EventSource last-event-id buffer: an id-only block sets
        // the id even though nothing dispatches, and the next data block
        // carries it.
        let result = frames("id: X\n\ndata: y\n\n")
        #expect(result == [SSEFrame(id: "X", data: "y")])
    }

    @Test func handlesCRLFLineEndings() {
        let result = frames("id: 5\r\nevent: named\r\ndata: hello\r\ndata: world\r\n\r\n")
        #expect(result == [SSEFrame(id: "5", event: "named", data: "hello\nworld")])
    }

    @Test func ignoresInterleavedComments() {
        let result = frames(": keepalive\ndata: a\n: mid-frame comment\ndata: b\n\n: trailing\n")
        #expect(result == [SSEFrame(data: "a\nb")])
    }

    @Test func reassemblesFramesSplitAcrossChunks() {
        let text = "id: 018f:9:bb\r\ndata: {\"type\":\"x\"}\r\n\r\ndata: tail\n\n"
        let whole = frames(text)

        // Byte-at-a-time feeding must produce the identical frames,
        // including a CRLF split between the CR and the LF.
        var parser = SSELineParser()
        var collected: [SSEFrame] = []
        for byte in Data(text.utf8) {
            collected += parser.consume(Data([byte]))
        }
        #expect(collected == whole)
        #expect(whole.count == 2)
        #expect(whole[0] == SSEFrame(id: "018f:9:bb", data: "{\"type\":\"x\"}"))

        // And an arbitrary mid-line split.
        var parser2 = SSELineParser()
        let bytes = Data(text.utf8)
        let cut = 7
        var collected2 = parser2.consume(bytes.prefix(cut))
        collected2 += parser2.consume(bytes.dropFirst(cut))
        #expect(collected2 == whole)
    }

    @Test func ignoresRetryAndUnknownFields() {
        let result = frames("retry: 5000\nfancy-field: nope\ndata: a\n\n")
        #expect(result == [SSEFrame(data: "a")])
    }

    @Test func lineWithoutColonIsFieldWithEmptyValue() {
        // Per spec, "data" alone is the data field with an empty value.
        let result = frames("data\n\n")
        #expect(result == [SSEFrame(data: "")])
    }

    @Test func stripsExactlyOneLeadingSpace() {
        #expect(frames("data:no-space\n\n") == [SSEFrame(data: "no-space")])
        #expect(frames("data:  two-spaces\n\n") == [SSEFrame(data: " two-spaces")])
    }

    @Test func emptyDataFieldDispatchesEmptyString() {
        #expect(frames("data:\n\n") == [SSEFrame(data: "")])
    }

    @Test func blankLineWithoutDataDispatchesNothingAndResetsEventType() {
        let result = frames("event: named\n\ndata: x\n\n")
        // The first block had no data: no frame, and its event type must not
        // leak into the following block.
        #expect(result == [SSEFrame(data: "x")])
    }

    @Test func idContainingNulIsIgnored() {
        let result = frames("id: a\u{0000}b\ndata: x\n\n")
        #expect(result == [SSEFrame(id: nil, data: "x")])
    }

    @Test func incompleteTrailingBlockIsNotEmitted() {
        var parser = SSELineParser()
        let first = parser.consume(Data("data: complete\n\ndata: partial".utf8))
        #expect(first == [SSEFrame(data: "complete")])
        // The unterminated tail only dispatches once its blank line arrives.
        let second = parser.consume(Data("\n\n".utf8))
        #expect(second == [SSEFrame(data: "partial")])
    }
}
