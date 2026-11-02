import Foundation
import HapiProtocol
import Testing

@Suite("Session mention metadata")
struct SessionMentionMetadataTests {
    private let json = #"{"id":"peer","namespace":"default","seq":1,"createdAt":1,"updatedAt":2,"active":false,"activeAt":0,"hasConversationContent":true,"metadata":{"path":"/repo","host":"host","promptTitle":"Initial prompt"},"metadataVersion":3,"agentStateVersion":1,"thinking":false,"thinkingAt":0}"#

    @Test func fullSessionsProjectAndRoundTripTheHubContentFlagAndPromptTitle() throws {
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        #expect(session.hasConversationContent == true)
        #expect(session.metadata?.promptTitle == "Initial prompt")
        let summary = SummaryPatching.toSessionSummary(session)
        #expect(summary.hasConversationContent == true)
        #expect(summary.metadata?.promptTitle == "Initial prompt")
        #expect(try JSONDecoder().decode(Session.self, from: JSONEncoder().encode(session)) == session)
        #expect(try JSONDecoder().decode(SessionSummary.self, from: JSONEncoder().encode(summary)) == summary)
    }

    @Test func metadataPatchesRetainEligibilityAndRejectStaleTitles() throws {
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        let summary = SummaryPatching.toSessionSummary(session)
        let metadata = SessionMetadata(path: "/repo", host: "host", promptTitle: "Updated title")
        let stale = SessionPatch(metadata: .init(version: 2, value: metadata))
        #expect(SummaryPatching.applySessionSummaryPatch(summary, stale) == summary)
        let patch = SessionPatch(metadata: .init(version: 4, value: metadata))
        let next = SummaryPatching.applySessionSummaryPatch(summary, patch)
        #expect(next.metadata?.promptTitle == "Updated title")
        #expect(next.hasConversationContent == true)
        #expect(!SummaryPatching.sameSessionSummaryMetadata(summary.metadata, next.metadata))
        #expect(!SummaryPatching.isRenderIrrelevantPatch(current: summary, next: next))
        #expect(applySessionDetailPatch(session: session, patch: patch)?.metadata?.promptTitle == "Updated title")
    }
}
