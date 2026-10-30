import Foundation
@testable import HapiClient
import HapiProtocol
import Testing

/// `GET /sessions/:id/export`: the web download's filename and the hub's
/// warning / too-large answers.
@MainActor
@Suite("Session export")
struct SessionExportTests {
    @Test func payloadBecomesAPrettyJsonFileNamedLikeTheWebDownload() async throws {
        let performer = RecordingPerformer()
        let api = try makeStoreAPIClient(performer: performer)
        await performer.enqueue(json: """
        {"schemaVersion":2,"exportedAt":1793145600000,"scratchlist":[],
         "session":{"id":"abcdef123456","metadata":{"name":"Fix login: bug #2","path":"/repo/app"}},
         "messages":[{"id":"m1"},{"id":"m2"}]}
        """)
        guard case .file(let file) = try await api.exportSession(sessionId: "abcdef123456") else {
            Issue.record("expected a file")
            return
        }
        #expect(file.filename == "fix-login-bug-2-abcdef12-2026-10-28.json")
        #expect(file.messageCount == 2)
        let text = String(decoding: file.data, as: UTF8.self)
        #expect(text.hasSuffix("}\n"))
        #expect(text.contains("\"path\" : \"/repo/app\""))
        let path = await performer.requests.first?.url?.path
        #expect(path == "/api/sessions/abcdef123456/export")
    }

    @Test func warningAndTooLargeAnswers() async throws {
        let performer = RecordingPerformer()
        let api = try makeStoreAPIClient(performer: performer)
        await performer.enqueue(json: #"{"type":"warning","count":25000,"limit":20000,"estimatedBytes":9000}"#)
        #expect(try await api.exportSession(sessionId: "s1") == .warning(count: 25000, limit: 20000, estimatedBytes: 9000))

        await performer.enqueue(
            status: 413,
            json: #"{"type":"too-large","error":"x","code":"session_export_too_large","count":9,"estimatedBytes":200,"maxBytes":100}"#
        )
        #expect(try await api.exportSession(sessionId: "s1", force: true) == .tooLarge(count: 9, estimatedBytes: 200, maxBytes: 100))
        let query = await performer.requests.last?.url?.query
        #expect(query == "force=true")
    }

    @Test func untitledSessionsFallBackToThePathTail() throws {
        let data = Data(#"{"exportedAt":0,"session":{"id":"zz","metadata":{"path":"/w/中文 项目"}},"messages":[]}"#.utf8)
        guard case .file(let file) = try SessionExportFormatting.result(from: data) else {
            Issue.record("expected a file")
            return
        }
        #expect(file.filename == "中文-项目-zz-1970-01-01.json")
    }
}
