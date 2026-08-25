import Foundation
import HapiClient
import Testing

@Suite("Push payload parsing")
struct PushPayloadTests {
    private let fullFields: [String: String] = [
        "type": "permission-request",
        "sessionId": "sess-1",
        "sessionName": "claude - hapi",
        "url": "/sessions/sess-1",
        "title": "Permission needed",
        "body": "Bash: rm -rf build",
        "requestId": "req-9",
        "severity": "warning",
        "contractVersion": "1",
    ]

    @Test func parsesEveryContractField() throws {
        let payload = try #require(PushPayload.parse(dictionary: fullFields))
        #expect(payload.type == .permissionRequest)
        #expect(payload.rawType == "permission-request")
        #expect(payload.sessionId == "sess-1")
        #expect(payload.sessionName == "claude - hapi")
        #expect(payload.url == "/sessions/sess-1")
        #expect(payload.title == "Permission needed")
        #expect(payload.body == "Bash: rm -rf build")
        #expect(payload.requestId == "req-9")
        #expect(payload.severity == .warning)
        #expect(payload.contractVersion == "1")
        #expect(payload.supportsActions)
        #expect(payload.categoryIdentifier == "permission-request")
    }

    @Test func missingSessionIdDropsTheMessage() {
        var fields = fullFields
        fields["sessionId"] = nil
        #expect(PushPayload.parse(dictionary: fields) == nil)
        fields["sessionId"] = "   "
        #expect(PushPayload.parse(dictionary: fields) == nil)
    }

    @Test func permissionRequestWithoutRequestIdHasNoActions() throws {
        var fields = fullFields
        fields["requestId"] = nil
        let payload = try #require(PushPayload.parse(dictionary: fields))
        #expect(!payload.supportsActions)
        #expect(payload.categoryIdentifier == nil)
    }

    @Test func unknownTypeDegradesToPlainNotification() throws {
        let payload = try #require(PushPayload.parse(dictionary: [
            "type": "hologram",
            "sessionId": "s1",
            "title": "T",
            "body": "B",
            "contractVersion": "1",
        ]))
        #expect(payload.type == nil)
        #expect(payload.rawType == "hologram")
        #expect(!payload.supportsActions)
        #expect(payload.categoryIdentifier == nil)
        #expect(payload.displayTitle == "T")
        #expect(payload.displayBody == "B")
    }

    @Test func unknownContractVersionDisablesActionsButKeepsContent() throws {
        var fields = fullFields
        fields["contractVersion"] = "2"
        let payload = try #require(PushPayload.parse(dictionary: fields))
        #expect(!payload.isKnownContractVersion)
        #expect(!payload.supportsActions)
        #expect(payload.categoryIdentifier == nil)
        #expect(payload.displayTitle == "Permission needed")
    }

    @Test func absentContractVersionCountsAsKnown() throws {
        var fields = fullFields
        fields["contractVersion"] = nil
        let payload = try #require(PushPayload.parse(dictionary: fields))
        #expect(payload.isKnownContractVersion)
        #expect(payload.supportsActions)
    }

    @Test func titleFallsBackToSessionNameThenConstant() throws {
        let named = try #require(PushPayload.parse(dictionary: [
            "type": "ready", "sessionId": "s1", "sessionName": "claude - hapi",
        ]))
        #expect(named.displayTitle == "claude - hapi")
        let bare = try #require(PushPayload.parse(dictionary: [
            "type": "ready", "sessionId": "s1",
        ]))
        #expect(bare.displayTitle == "HAPI")
    }

    @Test func readySummaryComposesDisplayBody() throws {
        let summaryJSON = #"{"version":1,"summary":"Tests green","action":"Review the diff"}"#
        let payload = try #require(PushPayload.parse(dictionary: [
            "type": "ready",
            "sessionId": "s1",
            "body": "hub body",
            "notifySummary": summaryJSON,
        ]))
        #expect(payload.notifySummary?.version == 1)
        #expect(payload.displayBody == "Tests green\n-> Review the diff")
    }

    @Test func readySummaryEqualActionCollapsesToOneLine() throws {
        let summaryJSON = #"{"summary":"Done","action":"Done"}"#
        let payload = try #require(PushPayload.parse(dictionary: [
            "type": "ready", "sessionId": "s1", "notifySummary": summaryJSON,
        ]))
        #expect(payload.displayBody == "Done")
    }

    @Test func malformedNotifySummaryFallsBackToBody() throws {
        let payload = try #require(PushPayload.parse(dictionary: [
            "type": "ready",
            "sessionId": "s1",
            "body": "hub body",
            "notifySummary": "{not json",
        ]))
        #expect(payload.notifySummary == nil)
        #expect(payload.displayBody == "hub body")
    }

    // MARK: - Plaintext (decrypted envelope) form

    @Test func parsesPlaintextJSONObject() throws {
        let json = #"{"type":"ready","sessionId":"s1","title":"HAPI","body":"Ready for input","contractVersion":"1"}"#
        let payload = try #require(PushPayload.parse(plaintext: Data(json.utf8)))
        #expect(payload.type == .ready)
        #expect(payload.sessionId == "s1")
        #expect(payload.categoryIdentifier == "ready")
    }

    @Test func plaintextToleratesNumericScalarsAndSkipsNested() throws {
        // A future hub emitting a bare number for contractVersion must not
        // drop the message; nested values are ignored, not fatal.
        let json = #"{"type":"ready","sessionId":"s1","contractVersion":1,"extra":{"a":1}}"#
        let payload = try #require(PushPayload.parse(plaintext: Data(json.utf8)))
        #expect(payload.contractVersion == "1")
        #expect(payload.isKnownContractVersion)
    }

    @Test func plaintextRejectsNonObjectOrGarbage() {
        #expect(PushPayload.parse(plaintext: Data("[1,2]".utf8)) == nil)
        #expect(PushPayload.parse(plaintext: Data("nope".utf8)) == nil)
    }
}
