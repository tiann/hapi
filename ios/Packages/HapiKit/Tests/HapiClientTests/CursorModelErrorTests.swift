import Foundation
import HapiClient
import HapiProtocol
import Testing

@Suite("Cursor model error recovery")
struct CursorModelErrorTests {
    private func makeSession() throws -> Session {
        try HapiJSON.decoder.decode(Session.self, from: Data(#"""
        {
          "id":"s/1","namespace":"default","seq":1,"createdAt":1,"updatedAt":1,
          "active":true,"activeAt":1,"metadataVersion":1,"agentStateVersion":0,"thinking":false,"thinkingAt":0,
          "metadata":{"path":"/project","host":"mac","flavor":"cursor","lastModelError":{
            "eventId":"error-9","kind":"quota_exhausted","transient":true,"rawSnippet":"Try again",
            "atTs":123,"priorAssistantClaimsDone":false,"lastUserMessage":"Private replay data"
          }}
        }
        """#.utf8))
    }

    @Test func bridgeUsesCurrentVisibleTransientEvent() throws {
        var session = try makeSession()
        var error = try #require(session.visibleCursorModelError)
        #expect(error.canBridge(sessionActive: true))
        #expect(!error.canBridge(sessionActive: false))
        error.bridgedForEventId = "previous-error"
        #expect(error.canBridge(sessionActive: true))
        error.bridgedForEventId = error.eventId
        #expect(error.recovered)
        #expect(!error.canBridge(sessionActive: true))
        error.retriedAndFailed = true
        #expect(!error.recovered)
        #expect(!error.canBridge(sessionActive: true))

        error = try #require(session.visibleCursorModelError)
        error.transient = false
        #expect(!error.canBridge(sessionActive: true))
        error.transient = true
        error.bridgeable = false
        #expect(!error.canBridge(sessionActive: true))
        error.bridgeable = nil
        error.supersededByUserTurn = true
        #expect(!error.canBridge(sessionActive: true))

        session.metadata?.lastModelError?.acknowledgedAt = 0
        #expect(session.visibleCursorModelError == nil)
        session.metadata?.lastModelError?.acknowledgedAt = nil
        session.metadata?.flavor = "codex"
        #expect(session.visibleCursorModelError == nil)
        session.metadata?.flavor = "cursor"
        session.metadata?.lastModelError?.eventId = ""
        #expect(session.visibleCursorModelError == nil)
    }

    @Test func actionsPostOnlyDisplayedEventIdentity() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        for action in [ModelErrorAction.bridge, .acknowledge] {
            await harness.performer.enqueue(json: #"{"ok":true}"#)
            try await harness.client.performModelErrorAction(action, sessionId: "s/1", eventId: "error-9")
            let request = try #require(await harness.performer.requests.last)
            #expect(request.httpMethod == "POST")
            #expect(request.url?.absoluteString == "\(testHubURLString)/api/sessions/s%2F1/model-error/\(action.rawValue)")
            let body = try JSONDecoder().decode([String: String].self, from: #require(request.httpBody))
            #expect(body == ["eventId": "error-9"])
        }
    }

    @Test func refusalOrMalformedSuccessCannotConfirmRecovery() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        for (status, body) in [(409, #"{"ok":false,"reason":"superseded"}"#),
                               (200, "<html>"), (200, #"{"ok":false}"#)] {
            await harness.performer.enqueue(status: status, json: body)
            let error = await capturedError {
                try await harness.client.performModelErrorAction(.bridge, sessionId: "s", eventId: "old")
            }
            #expect(error != nil)
            if status == 409 { #expect((error as? APIError)?.code == "superseded") }
        }
        #expect(await harness.performer.requests.count == 3)
    }
}
