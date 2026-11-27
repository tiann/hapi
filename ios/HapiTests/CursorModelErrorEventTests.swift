import HapiProtocol
import XCTest
@testable import Hapi

final class CursorModelErrorEventTests: XCTestCase {
    func testTimelineShowsErrorKindWithoutRawPayload() {
        let event = AgentEvent(object: [
            "type": .string("modelError"), "kind": .string("internal"), "transient": .bool(true),
            "rawSnippet": .string("Private diagnostics")
        ])
        XCTAssertEqual(eventPresentation(event).text, "Model error (internal, transient)")
    }

    func testBridgeTimelineDistinguishesManualAndAutomaticRecovery() {
        var event = AgentEvent(object: ["type": .string("modelErrorBridged"), "kind": .string("unavailable")])
        XCTAssertEqual(eventPresentation(event).text, "HAPI bridged after unavailable — re-sent last user message")
        event.object["auto"] = .bool(true)
        XCTAssertEqual(eventPresentation(event).text, "HAPI auto-bridged after unavailable — re-sent last user message")
    }
}
