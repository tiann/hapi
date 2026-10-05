import Foundation
import HapiProtocol
import Testing

@Suite("Generated SSE fixtures")
struct SSEFixtureTests {
    private struct Fixture: Decodable {
        let initialSession: Session
        let patches: [SessionPatch]
        let expectedPatchResults: [String]
        let expectedSession: Session
    }

    private static func fixtureURL(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("../../../shared/fixtures/sse")
            .appendingPathComponent(name)
            .standardizedFileURL
    }

    @Test func replyClockBackwardAndNullFixtureMatchesGeneratedFold() throws {
        let data = try Data(contentsOf: Self.fixtureURL("reply-clock-versioned-backward-and-null.json"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        var session = fixture.initialSession
        for (patch, expectedResult) in zip(fixture.patches, fixture.expectedPatchResults) {
            let next = applySessionDetailPatch(session: session, patch: patch)
            if expectedResult == "applied" {
                session = try #require(next)
            } else {
                #expect(expectedResult == "unchanged")
                #expect(next == nil)
            }
        }
        #expect(session == fixture.expectedSession)
    }
}
