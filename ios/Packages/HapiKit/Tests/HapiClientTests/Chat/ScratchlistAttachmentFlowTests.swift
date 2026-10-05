import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import HapiProtocol
import Testing
@testable import HapiClient

private actor ScratchlistFlowHTTP: HTTPPerforming {
    private(set) var requests: [URLRequest] = []
    var failUploadNumber: Int?
    var failParkNumber: Int?
    private var uploads = 0
    private var parks = 0
    private var resumes = 0
    private var expireAfterUpload = false

    func failChatUpload(_ number: Int) { failUploadNumber = number }
    func failParkUpload(_ number: Int) { failParkNumber = number }
    func expireStagedSession() { expireAfterUpload = true }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let path = request.url!.path
        var status = 200
        let response: String
        if path.hasSuffix("/scratchlist/upload") {
            parks += 1
            if parks == failParkNumber { status = 500; response = "{}" }
            else {
                let attachment = ScratchlistAttachment(id: "park-\(parks)", filename: "photo.png", mimeType: "image/png", size: 4,
                    path: "hapi-hub:scratchlist/default/sess-1/park-\(parks).png")
                response = try encodeJSON(ScratchlistUploadResponse(success: true, attachment: attachment))
            }
        } else if path.hasSuffix("/upload") {
            uploads += 1
            if uploads == failUploadNumber { status = 500; response = "{}" }
            else { response = "{\"success\":true,\"path\":\"/tmp/chat-\(uploads).png\"}" }
        } else if path.hasSuffix("/file") {
            response = try encodeJSON(FileReadResponse(success: true, content: Data("test".utf8).base64EncodedString()))
        } else if path.hasSuffix("/resume") {
            resumes += 1
            response = resumes == 1 ? "{\"sessionId\":\"resumed\"}" : "{\"sessionId\":\"resumed-again\"}"
        }
        else if path.hasSuffix("/messages"), request.httpMethod == "POST", expireAfterUpload {
            expireAfterUpload = false
            status = 409
            response = "{\"error\":\"inactive\",\"code\":\"session_inactive\"}"
        }
        else if path.contains("/scratchlist/attachments/") { response = "test" }
        else if path.hasSuffix("/messages"), request.httpMethod == "GET" { response = "{\"messages\":[],\"hasMore\":false}" }
        else { response = "{}" }
        return (Data(response.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!)
    }
}

@Suite("Scratchlist attachment ownership and transfer")
@MainActor
struct ScratchlistAttachmentFlowTests {
    private func photo(_ id: String) -> ScratchlistAttachment {
        ScratchlistAttachment(id: id, filename: "\(id).png", mimeType: "image/png", size: 4, path: "hapi-hub:scratchlist/default/sess-1/\(id).png")
    }
    private func pick(_ id: String) -> PreparedAttachment {
        PreparedAttachment(id: id, filename: "photo.png", mimeType: "image/png", bytes: Data("test".utf8))
    }

    @Test func scratchlistPicksUploadToHubAndOnlyUnsavedOwnedFilesAreDeleted() async throws {
        let http = ScratchlistFlowHTTP()
        let api = try makeStoreAPIClient(performer: http)
        let tray = ComposerAttachments(api: api, sessionId: "sess-1")
        tray.add(pick("first"), toScratchlist: true)
        try await expectEventually { tray.allReady }
        let snapshot = tray.snapshot
        guard case .scratchlist(let saved) = snapshot[0].source else { Issue.record("Expected hub storage"); return }
        tray.markScratchlistPersisted([saved])
        tray.discard(snapshot)
        tray.restoreScratchlist([saved])
        tray.discardAllDetached()
        try await Task.sleep(for: .milliseconds(30))
        #expect(await http.requests.count == 1, "Neither saved nor borrowed files are owned by the composer")
        tray.add(pick("second"), toScratchlist: true)
        try await expectEventually { tray.allReady }
        tray.discardAllDetached()
        try await Task.sleep(for: .milliseconds(30))
        #expect(await http.requests.contains { $0.httpMethod == "DELETE" && $0.url!.path.hasSuffix("/park-2") })
    }

    @Test func chatToScratchlistMigrationLeavesTheSourceUntilCommit() async throws {
        let http = ScratchlistFlowHTTP()
        let api = try makeStoreAPIClient(performer: http)
        let store = ScratchlistStore(api: api)
        let tray = ComposerAttachments(api: api, sessionId: "sess-1")
        tray.add(pick("first"))
        try await expectEventually { tray.allReady }
        let snapshot = tray.snapshot
        let prepared = try await ScratchlistTransfer.preparePark(api: api, store: store, sessionId: "sess-1", snapshot: snapshot)
        #expect(prepared.attachments.count == 1)
        #expect(tray.snapshot == snapshot)
        #expect(await http.requests.contains { $0.url!.path.hasSuffix("/file") })
        #expect(!(await http.requests.contains { $0.url!.path.hasSuffix("/upload/delete") }))
        await ScratchlistTransfer.cleanupPark(store: store, sessionId: "sess-1", attachments: prepared.uploaded)
        #expect(tray.snapshot == snapshot, "A rejected park leaves the original chat upload usable")
    }

    @Test func partialParkFailureCleansOnlyNewHubCopies() async throws {
        let http = ScratchlistFlowHTTP()
        await http.failParkUpload(2)
        let api = try makeStoreAPIClient(performer: http)
        let store = ScratchlistStore(api: api)
        let tray = ComposerAttachments(api: api, sessionId: "sess-1")
        tray.add(pick("first")); tray.add(pick("second"))
        try await expectEventually { tray.allReady }
        do {
            _ = try await ScratchlistTransfer.preparePark(api: api, store: store, sessionId: "sess-1", snapshot: tray.snapshot)
            Issue.record("The second upload must fail")
        } catch {}
        #expect(tray.items.count == 2)
        #expect(tray.allReady)
        #expect(await http.requests.contains { $0.httpMethod == "DELETE" && $0.url!.path.hasSuffix("/park-1") })
        #expect(!(await http.requests.contains { $0.url!.path.hasSuffix("/upload/delete") }))
    }

    @Test func partialSendPreparationCleansChatCopiesWithoutDeletingSavedFiles() async throws {
        let http = ScratchlistFlowHTTP()
        await http.failChatUpload(2)
        let api = try makeStoreAPIClient(performer: http)
        let entry = ScratchlistEntry(entryId: "entry", text: "", createdAt: 1, updatedAt: 1, attachments: [photo("one"), photo("two")])
        do {
            _ = try await ScratchlistTransfer.prepareSend(api: api, sourceSessionId: "sess-1", targetSessionId: "sess-1",
                snapshot: ScratchlistTransfer.snapshot(entry))
            Issue.record("The second upload must fail")
        } catch {}
        #expect(await http.requests.contains { $0.url!.path.hasSuffix("/upload/delete") })
        #expect(!(await http.requests.contains { $0.httpMethod == "DELETE" }))
    }

    @Test func queueResumesBeforeStagingAndCleansEntryInTheEffectiveSession() async throws {
        let http = ScratchlistFlowHTTP()
        let api = try makeStoreAPIClient(performer: http)
        let interactor = ChatInteractor(sessionId: "sess-1", api: api, sessionStore: SessionListStore(api: api), windows: MessageWindowControllers(provider: api))
        interactor.scratchlist = ScratchlistStore(api: api)
        interactor.setComposerText("Keep this input")
        let entry = ScratchlistEntry(entryId: "entry", text: "", createdAt: 1, updatedAt: 1, attachments: [photo("one")])
        #expect(await interactor.queueScratchlistEntry(entry))
        #expect(interactor.composerText == "Keep this input")
        let requests = await http.requests
        let resume = try #require(requests.firstIndex { $0.url!.path.hasSuffix("/resume") })
        let fetch = try #require(requests.firstIndex { $0.url!.path == "/api/sessions/resumed/scratchlist/attachments/one" })
        #expect(resume < fetch)
        #expect(requests.contains { $0.httpMethod == "POST" && $0.url!.path == "/api/sessions/resumed/messages" })
        #expect(requests.contains { $0.httpMethod == "DELETE" && $0.url!.path == "/api/sessions/resumed/scratchlist/entry" })
        let message = try #require(requests.first { $0.httpMethod == "POST" && $0.url!.path.hasSuffix("/messages") })
        let body = try #require(message.httpBody)
        #expect(!String(decoding: body, as: UTF8.self).contains("hapi-hub:"))
    }

    @Test func expiryDuringStagingResumesTheEffectiveSessionRatherThanTheDeletedOriginal() async throws {
        let http = ScratchlistFlowHTTP()
        await http.expireStagedSession()
        let api = try makeStoreAPIClient(performer: http)
        let interactor = ChatInteractor(sessionId: "sess-1", api: api, sessionStore: SessionListStore(api: api), windows: MessageWindowControllers(provider: api))
        interactor.scratchlist = ScratchlistStore(api: api)
        let entry = ScratchlistEntry(entryId: "entry", text: "next", createdAt: 1, updatedAt: 1, attachments: [photo("one")])
        #expect(await interactor.queueScratchlistEntry(entry))
        let requests = await http.requests
        #expect(requests.filter { $0.url!.path.hasSuffix("/resume") }.map { $0.url!.path }
            == ["/api/sessions/sess-1/resume", "/api/sessions/resumed/resume"])
        #expect(requests.contains { $0.httpMethod == "DELETE" && $0.url!.path == "/api/sessions/resumed-again/scratchlist/entry" })
    }
}
