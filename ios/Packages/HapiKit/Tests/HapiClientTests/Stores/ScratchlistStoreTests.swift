import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiClient
import HapiProtocol
import Testing

// Transcription of the Android reference suite (`ScratchlistStoreTest.kt`)
// against the iOS `ScratchlistStore`. The store runs over the REAL
// `APIClient`/`AuthManager` with only HTTP scripted (FIFO performer, the
// MockWebServer analogue), so request paths and canonical JSON bodies are
// asserted as what the app actually sends.

// MARK: - FIFO performer (MockWebServer analogue)

private actor ScratchlistPerformer: HTTPPerforming {
    struct Exchange: Sendable {
        let method: String
        let path: String
        let body: String?
    }

    private struct Scripted {
        let status: Int
        let json: String
        let delay: Duration?
    }

    private(set) var exchanges: [Exchange] = []
    private var queue: [Scripted] = []

    /// Enqueues the next response in FIFO order, regardless of path.
    func enqueue(status: Int = 200, json: String = "{}", delay: Duration? = nil) {
        queue.append(Scripted(status: status, json: json, delay: delay))
    }

    var requestCount: Int { exchanges.count }

    func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        exchanges.append(Exchange(
            method: request.httpMethod ?? "GET",
            path: request.url?.path ?? "",
            body: request.httpBody.map { String(decoding: $0, as: UTF8.self) }
        ))
        let scripted: Scripted
        if queue.isEmpty {
            scripted = Scripted(status: 404, json: "{\"error\":\"no scripted response\"}", delay: nil)
        } else {
            scripted = queue.removeFirst()
        }
        if let delay = scripted.delay {
            try? await Task.sleep(for: delay)
        }
        guard let url = request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: scripted.status,
                  httpVersion: "HTTP/1.1",
                  headerFields: ["Content-Type": "application/json"]
              ) else {
            throw URLError(.badURL)
        }
        return (Data(scripted.json.utf8), response)
    }
}

// MARK: - Fixtures

private func entryJSON(
    _ id: String,
    _ text: String,
    createdAt: Int = 1,
    updatedAt: Int = 1,
    attachmentsJSON: String? = nil
) -> String {
    let attachments = attachmentsJSON.map { ",\"attachments\":\($0)" } ?? ""
    return "{\"entryId\":\"\(id)\",\"text\":\"\(text)\",\"createdAt\":\(createdAt),\"updatedAt\":\(updatedAt)\(attachments)}"
}

private func entriesJSON(_ entries: String...) -> String {
    "{\"entries\":[\(entries.joined(separator: ","))]}"
}

@MainActor
private func makeScratchlistStore(
    _ performer: ScratchlistPerformer
) throws -> ScratchlistStore {
    ScratchlistStore(
        api: try makeStoreAPIClient(performer: performer),
        now: { 111 },
        makeEntryId: { "opt-1" }
    )
}

private func decodeBody(_ body: String?) throws -> [String: JSONValue] {
    let value = try HapiJSON.decoder.decode(JSONValue.self, from: Data((body ?? "{}").utf8))
    guard case .object(let object) = value else {
        throw StoreFixtureError(message: "body is not an object")
    }
    return object
}

// MARK: - Tests

@Suite("ScratchlistStore")
@MainActor
struct ScratchlistStoreTests {

    // MARK: Fetching

    @Test func openRefreshesAndLoadsEntriesWithAbsentAttachmentsDefaultingEmpty() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(json: entriesJSON(entryJSON("e1", "note one", updatedAt: 5)))

        store.open("s1")
        try await expectEventually { store.state("s1").loaded }

        let state = store.state("s1")
        #expect(state.entries.map(\.entryId) == ["e1"])
        #expect(state.entries[0].attachments.isEmpty)
        #expect(!state.atCap)
        let exchanges = await performer.exchanges
        let request = try #require(exchanges.first)
        #expect(request.method == "GET")
        #expect(request.path == "/api/sessions/s1/scratchlist")
    }

    @Test func initialFetchFailureLandsInLoadFailedUntilARetrySucceeds() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(status: 500, json: "{\"error\":\"boom\"}")
        _ = try? await store.refresh("s1")
        #expect(store.state("s1").loadFailed)

        await performer.enqueue(json: entriesJSON(entryJSON("e1", "note")))
        try await store.refresh("s1")
        let state = store.state("s1")
        #expect(state.loaded)
        #expect(!state.loadFailed)
    }

    // MARK: Create

    @Test func createShowsTheOptimisticRowThenReconcilesWithTheCanonicalEntry() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(
            status: 201,
            json: "{\"entry\":\(entryJSON("opt-1", "note", createdAt: 111, updatedAt: 999))}",
            delay: .milliseconds(150)
        )

        let create = Task { await store.createEntry(sessionId: "s1", text: "  note  ") }
        // Optimistic row (client stamp 111) is visible before the hub answers.
        try await expectEventually {
            store.state("s1").entries.contains { $0.entryId == "opt-1" && $0.updatedAt == 111 }
        }

        let result = await create.value
        guard case .created = result else {
            Issue.record("expected .created, got \(result)")
            return
        }
        try await expectEventually {
            store.state("s1").entries.count == 1 && store.state("s1").entries[0].updatedAt == 999
        }

        let exchanges = await performer.exchanges
        let request = try #require(exchanges.last)
        #expect(request.method == "POST")
        #expect(request.path == "/api/sessions/s1/scratchlist")
        // Canonical encoder (sorted keys); also proves empty attachments are omitted.
        #expect(request.body == "{\"createdAt\":111,\"entryId\":\"opt-1\",\"text\":\"note\"}")
    }

    @Test func createFailureRollsTheOptimisticRowBack() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(status: 500, json: "{\"error\":\"boom\"}")

        let result = await store.createEntry(sessionId: "s1", text: "doomed")

        guard case .failed = result else {
            Issue.record("expected .failed, got \(result)")
            return
        }
        #expect(store.state("s1").entries.isEmpty)
    }

    @Test func create409AtCapSurfacesTheFriendlyCapStateWithoutAGhostRow() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(
            status: 409,
            json: "{\"error\":\"Scratchlist is at its 200-entry cap\",\"code\":\"\(ScratchlistErrorCode.atCap)\"}"
        )
        // The cap verdict schedules a reconcile refetch.
        await performer.enqueue(json: entriesJSON())

        let result = await store.createEntry(sessionId: "s1", text: "over the cap")

        guard case .atCap = result else {
            Issue.record("expected .atCap, got \(result)")
            return
        }
        let state = store.state("s1")
        #expect(state.atCap)
        #expect(!state.entries.contains { $0.entryId == "opt-1" })
    }

    @Test func local200EntryCapShortCircuitsCreateWithoutARequest() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        let full = (1...200).map { entryJSON("e\($0)", "n\($0)") }
        await performer.enqueue(json: "{\"entries\":[\(full.joined(separator: ","))]}")
        try await store.refresh("s1")
        #expect(store.state("s1").atCap)

        let result = await store.createEntry(sessionId: "s1", text: "one too many")

        guard case .atCap = result else {
            Issue.record("expected .atCap, got \(result)")
            return
        }
        let count = await performer.requestCount
        #expect(count == 1)
    }

    // MARK: Update

    @Test func updateAppliesOptimisticallyAndReconcilesWithTheCanonicalRow() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(json: entriesJSON(entryJSON("e1", "old", updatedAt: 1)))
        try await store.refresh("s1")
        await performer.enqueue(json: "{\"entry\":\(entryJSON("e1", "new", updatedAt: 999))}")

        let updated = await store.updateEntry(sessionId: "s1", entryId: "e1", text: "new", attachments: nil)
        #expect(updated)

        let entry = try #require(store.state("s1").entries.first)
        #expect(entry.text == "new")
        #expect(entry.updatedAt == 999)
        let exchanges = await performer.exchanges
        let request = try #require(exchanges.last)
        #expect(request.method == "PUT")
        #expect(request.path == "/api/sessions/s1/scratchlist/e1")
        #expect(request.body == "{\"text\":\"new\"}")
    }

    @Test func updateFailureRestoresThePreviousRow() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(json: entriesJSON(entryJSON("e1", "old", updatedAt: 7)))
        try await store.refresh("s1")
        await performer.enqueue(status: 500, json: "{\"error\":\"boom\"}")

        let updated = await store.updateEntry(sessionId: "s1", entryId: "e1", text: "new", attachments: nil)
        #expect(!updated)

        let entry = try #require(store.state("s1").entries.first)
        #expect(entry.text == "old")
        #expect(entry.updatedAt == 7)
    }

    @Test func update404DropsTheRowDeletedElsewhere() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(json: entriesJSON(entryJSON("e1", "old")))
        try await store.refresh("s1")
        await performer.enqueue(status: 404, json: "{\"error\":\"Scratchlist entry not found\"}")
        // 404 schedules a reconcile refetch.
        await performer.enqueue(json: entriesJSON())

        let updated = await store.updateEntry(sessionId: "s1", entryId: "e1", text: "new", attachments: nil)
        #expect(!updated)
        #expect(store.state("s1").entries.isEmpty)
    }

    // MARK: Delete

    @Test func deleteRemovesOptimisticallyAndRestoresAtTheSamePositionOnFailure() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(json: entriesJSON(entryJSON("e1", "first"), entryJSON("e2", "second")))
        try await store.refresh("s1")
        await performer.enqueue(status: 500, json: "{\"error\":\"boom\"}")

        let deleted = await store.deleteEntry(sessionId: "s1", entryId: "e1")
        #expect(!deleted)

        #expect(store.state("s1").entries.map(\.entryId) == ["e1", "e2"])
    }

    @Test func delete404CountsAsSuccess() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(json: entriesJSON(entryJSON("e1", "gone soon")))
        try await store.refresh("s1")
        await performer.enqueue(status: 404, json: "{\"error\":\"Scratchlist entry not found\"}")

        let deleted = await store.deleteEntry(sessionId: "s1", entryId: "e1")
        #expect(deleted)
        #expect(store.state("s1").entries.isEmpty)
    }

    // MARK: SSE invalidation

    @Test func scratchlistUpdatedAtSignalRefetchesObservedSessionsOnly() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(json: entriesJSON(entryJSON("e1", "note")))
        store.open("s1")
        try await expectEventually { store.state("s1").loaded }

        // Signal for the observed session → refetch picks up the new entry.
        await performer.enqueue(json: entriesJSON(
            entryJSON("e1", "note"),
            entryJSON("e2", "from another device")
        ))
        store.handleInvalidation(sessionId: "s1")
        try await expectEventually {
            store.state("s1").entries.contains { $0.entryId == "e2" }
        }
        var count = await performer.requestCount
        #expect(count == 2)

        // Signals for unobserved sessions are ignored.
        store.handleInvalidation(sessionId: "s2")
        try await Task.sleep(for: .milliseconds(120))
        count = await performer.requestCount
        #expect(count == 2)

        // Released sessions stop refetching too.
        store.release("s1")
        store.handleInvalidation(sessionId: "s1")
        try await Task.sleep(for: .milliseconds(120))
        count = await performer.requestCount
        #expect(count == 2)
    }

    /// The seam feeding the signal: a `session-updated` patch carrying
    /// `scratchlistUpdatedAt` fires `SessionListStore.onScratchlistInvalidation`
    /// with the session id; other patches do not.
    @Test func sessionPatchWithScratchlistUpdatedAtFiresTheInvalidationSeam() async throws {
        let performer = ScratchlistPerformer()
        let listStore = SessionListStore(api: try makeStoreAPIClient(performer: performer))
        let fired = Box<[String]>([])
        listStore.onScratchlistInvalidation = { fired.value.append($0) }

        listStore.applySessionEvent(
            try sessionUpdatedEvent("s1", dataJSON: "{\"scratchlistUpdatedAt\":123}")
        )
        #expect(fired.value == ["s1"])

        listStore.applySessionEvent(try sessionUpdatedEvent("s1", dataJSON: "{\"active\":true}"))
        #expect(fired.value == ["s1"])
    }

    // MARK: Attachments

    @Test func uploadReportsInFlightProgressAndReturnsTheStoredAttachment() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(
            json: "{\"success\":true,\"attachment\":{\"id\":\"a1\",\"filename\":\"pic.jpg\","
                + "\"mimeType\":\"image/jpeg\",\"size\":3,\"path\":\"hapi-hub:scratchlist/a1\"}}",
            delay: .milliseconds(150)
        )

        let upload = Task {
            await store.uploadAttachment(
                sessionId: "s1",
                filename: "pic.jpg",
                data: Data([1, 2, 3]),
                mimeType: "image/jpeg"
            )
        }
        try await expectEventually { store.state("s1").uploadsInFlight == ["pic.jpg"] }

        let result = await upload.value
        guard case .uploaded(let attachment) = result else {
            Issue.record("expected .uploaded, got \(result)")
            return
        }
        #expect(attachment.id == "a1")
        try await expectEventually { store.state("s1").uploadsInFlight.isEmpty }

        let exchanges = await performer.exchanges
        let request = try #require(exchanges.first)
        #expect(request.method == "POST")
        #expect(request.path == "/api/sessions/s1/scratchlist/upload")
        let sent = try decodeBody(request.body)
        #expect(sent["filename"] == .string("pic.jpg"))
        #expect(sent["mimeType"] == .string("image/jpeg"))
        #expect(sent["content"] == .string("AQID")) // base64 of 1,2,3
    }

    @Test func upload413MapsToTheTypedTooLargeCode() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(
            status: 413,
            json: "{\"success\":false,\"error\":\"File exceeds the 10 MB limit\","
                + "\"code\":\"\(ScratchlistErrorCode.attachmentTooLarge)\"}"
        )

        let result = await store.uploadAttachment(
            sessionId: "s1",
            filename: "huge.png",
            data: Data(count: 4),
            mimeType: "image/png"
        )

        guard case .failed(_, let code) = result else {
            Issue.record("expected .failed, got \(result)")
            return
        }
        #expect(code == ScratchlistErrorCode.attachmentTooLarge)
        #expect(store.state("s1").uploadsInFlight.isEmpty)
    }

    @Test func attachmentDeleteMaps409InUseAndOkBodies() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(
            status: 409,
            json: "{\"error\":\"Attachment is still referenced\",\"code\":\"\(ScratchlistErrorCode.attachmentInUse)\"}"
        )
        let first = await store.deleteAttachment(sessionId: "s1", attachmentId: "a1")
        guard case .inUse = first else {
            Issue.record("expected .inUse, got \(first)")
            return
        }

        await performer.enqueue(json: "{\"ok\":true}")
        let second = await store.deleteAttachment(sessionId: "s1", attachmentId: "a1")
        guard case .removed = second else {
            Issue.record("expected .removed, got \(second)")
            return
        }
        let exchanges = await performer.exchanges
        let request = try #require(exchanges.first)
        #expect(request.method == "DELETE")
        #expect(request.path == "/api/sessions/s1/scratchlist/attachments/a1")
    }

    @Test func limitsDefaultOfflineAndCacheAfterTheFirstSuccess() async throws {
        let performer = ScratchlistPerformer()
        let store = try makeScratchlistStore(performer)
        await performer.enqueue(status: 500, json: "{\"error\":\"boom\"}")
        let offline = await store.limits(sessionId: "s1")
        #expect(offline == .defaultLimits)

        await performer.enqueue(
            json: "{\"limits\":{\"maxBytesPerFile\":1024,\"maxAttachmentsPerEntry\":2,"
                + "\"maxBytesPerEntry\":2048,\"maxBytesPerSession\":4096,\"allowedMimeTypes\":[\"image/png\"]}}"
        )
        let fetched = await store.limits(sessionId: "s1")
        #expect(fetched.maxBytesPerFile == 1024)
        #expect(fetched.allowedMimeTypes == ["image/png"])

        // Third call answers from the cache — no further request.
        let cached = await store.limits(sessionId: "s1")
        #expect(cached == fetched)
        let count = await performer.requestCount
        #expect(count == 2)
    }
}

/// Reference box for capturing values in `@MainActor` test callbacks.
@MainActor
private final class Box<Value> {
    var value: Value

    init(_ value: Value) {
        self.value = value
    }
}
