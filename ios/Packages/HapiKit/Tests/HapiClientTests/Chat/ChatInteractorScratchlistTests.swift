import Foundation
import HapiClient
import HapiProtocol
import Testing

// The A-M4b interactor seams — scratchlist badge count, "To composer"
// insertion, and park-from-composer — exercised against a FAKE scratchlist
// store (the interactor's other wiring is real but idle: no HTTP is hit).
// Kept out of `ChatInteractorTests.swift` so the concurrently-developed
// attachment suite and this one never collide.

// MARK: - Fake store

@MainActor
private final class FakeScratchlist: SessionScratchlistStoring {
    var states: [String: ScratchlistSessionState] = [:]
    var createResult: ScratchlistCreateResult = .atCap
    /// When true, `createEntry` parks on a gate until `resumeCreates()`.
    var holdCreates = false
    private(set) var createCalls: [(sessionId: String, text: String, attachments: [ScratchlistAttachment])] = []
    private(set) var createIds: [String?] = []
    var deleteResult = true
    private(set) var deleteCalls: [(String, String)] = []
    private var gates: [CheckedContinuation<Void, Never>] = []

    func state(_ sessionId: String) -> ScratchlistSessionState {
        states[sessionId] ?? ScratchlistSessionState()
    }

    func open(_ sessionId: String) {}

    func release(_ sessionId: String) {}

    func refresh(_ sessionId: String) async throws {}

    func createEntry(
        sessionId: String,
        text: String,
        attachments: [ScratchlistAttachment],
        entryId: String?
    ) async -> ScratchlistCreateResult {
        createCalls.append((sessionId, text, attachments))
        createIds.append(entryId)
        if holdCreates {
            await withCheckedContinuation { gates.append($0) }
        }
        return createResult
    }

    func resumeCreates() {
        let pending = gates
        gates = []
        pending.forEach { $0.resume() }
    }

    func updateEntry(
        sessionId: String,
        entryId: String,
        text: String?,
        attachments: [ScratchlistAttachment]?
    ) async -> Bool {
        true
    }

    func deleteEntry(sessionId: String, entryId: String) async -> Bool {
        deleteCalls.append((sessionId, entryId))
        return deleteResult
    }

    func uploadAttachment(
        sessionId: String,
        filename: String,
        data: Data,
        mimeType: String
    ) async -> ScratchlistUploadResult {
        .failed(message: "unused", code: nil)
    }

    func deleteAttachment(sessionId: String, attachmentId: String) async -> ScratchlistAttachmentDeleteResult {
        .removed
    }

    func limits(sessionId: String) async -> ScratchlistAttachmentLimits {
        .defaultLimits
    }
}

// MARK: - Harness

@MainActor
private final class ScratchlistSeamHarness {
    let scratchlist: FakeScratchlist
    let interactor: ChatInteractor
    let performer: RoutingPerformer
    private(set) var events: [ChatInteractionEvent] = []

    init(withStore: Bool = true) throws {
        performer = RoutingPerformer()
        let api = try makeStoreAPIClient(performer: performer)
        scratchlist = FakeScratchlist()
        interactor = ChatInteractor(
            sessionId: "sess-1",
            api: api,
            sessionStore: SessionListStore(api: api),
            windows: MessageWindowControllers(provider: api)
        )
        if withStore {
            interactor.scratchlist = scratchlist
        }
        interactor.onEvent = { [weak self] event in
            self?.events.append(event)
        }
    }

    var notices: [String] {
        events.compactMap {
            if case .notice(let message) = $0 { return message }
            return nil
        }
    }
}

@Suite("ChatInteractor scratchlist seams")
@MainActor
struct ChatInteractorScratchlistTests {

    // MARK: To composer

    @Test func insertIntoEmptyComposerTakesTheEntryVerbatim() throws {
        let harness = try ScratchlistSeamHarness()

        harness.interactor.insertComposerText("note text")

        #expect(harness.interactor.composerText == "note text")
    }

    @Test func insertAppendsOnANewLineTrimmingTheDraftsTrailingWhitespace() throws {
        let harness = try ScratchlistSeamHarness()
        harness.interactor.setComposerText("draft  ")

        harness.interactor.insertComposerText("note")

        #expect(harness.interactor.composerText == "draft\nnote")
    }

    @Test func insertWithBlankTextIsANoOp() throws {
        let harness = try ScratchlistSeamHarness()
        harness.interactor.setComposerText("draft")

        harness.interactor.insertComposerText("   ")

        #expect(harness.interactor.composerText == "draft")
    }

    // MARK: Park

    @Test func parkPostsTheDraftAndClearsTheComposerAfterTheHubAccepts() async throws {
        let harness = try ScratchlistSeamHarness()
        harness.scratchlist.createResult = .created(
            ScratchlistEntry(entryId: "e1", text: "park me", createdAt: 1, updatedAt: 1)
        )
        harness.interactor.setComposerText("park me")

        harness.interactor.parkComposerDraft()

        try await expectEventually { harness.interactor.composerText.isEmpty }
        #expect(harness.scratchlist.createCalls.count == 1)
        #expect(harness.scratchlist.createCalls[0].sessionId == "sess-1")
        #expect(harness.scratchlist.createCalls[0].text == "park me")
        #expect(harness.scratchlist.createCalls[0].attachments.isEmpty)
        #expect(harness.notices == ["Draft parked to scratchlist"])
    }

    @Test func parkKeepsADraftTheOperatorRetypedWhileThePostRan() async throws {
        let harness = try ScratchlistSeamHarness()
        harness.scratchlist.createResult = .created(
            ScratchlistEntry(entryId: "e1", text: "draft", createdAt: 1, updatedAt: 1)
        )
        harness.scratchlist.holdCreates = true
        harness.interactor.setComposerText("draft")

        harness.interactor.parkComposerDraft()
        try await expectEventually { harness.scratchlist.createCalls.count == 1 }
        harness.interactor.setComposerText("draft more")
        harness.scratchlist.resumeCreates()

        try await expectEventually { harness.notices == ["Draft parked to scratchlist"] }
        #expect(harness.interactor.composerText == "draft more")
    }

    @Test func parkAtCapKeepsTheDraftAndNotices() async throws {
        let harness = try ScratchlistSeamHarness()
        harness.scratchlist.createResult = .atCap
        harness.interactor.setComposerText("keep me")

        harness.interactor.parkComposerDraft()

        try await expectEventually { harness.notices == ["Scratchlist is full (200 entries)"] }
        #expect(harness.interactor.composerText == "keep me")
    }

    @Test func parkFailureKeepsTheDraftAndNotices() async throws {
        let harness = try ScratchlistSeamHarness()
        harness.scratchlist.createResult = .failed(ScratchlistStoreError.emptyEntry)
        harness.interactor.setComposerText("keep me too")

        harness.interactor.parkComposerDraft()

        try await expectEventually {
            harness.notices == ["Couldn't park the draft — check the hub connection"]
        }
        #expect(harness.interactor.composerText == "keep me too")
    }

    @Test func parkWithABlankComposerNeverCallsTheStore() async throws {
        let harness = try ScratchlistSeamHarness()
        harness.interactor.setComposerText("   ")

        harness.interactor.parkComposerDraft()

        try await Task.sleep(for: .milliseconds(50))
        #expect(harness.scratchlist.createCalls.isEmpty)
        #expect(harness.interactor.composerText == "   ")
    }

    @Test func parkWithoutAStoreIsANoOp() async throws {
        let harness = try ScratchlistSeamHarness(withStore: false)
        harness.interactor.setComposerText("stranded draft")

        harness.interactor.parkComposerDraft()

        try await Task.sleep(for: .milliseconds(50))
        #expect(harness.interactor.composerText == "stranded draft")
        #expect(harness.events.isEmpty)
    }

    // MARK: Badge count

    @Test func scratchlistCountReflectsTheStoreAndDefaultsToZeroWithoutOne() throws {
        let harness = try ScratchlistSeamHarness()
        var state = ScratchlistSessionState()
        state.entries = [
            ScratchlistEntry(entryId: "e1", text: "one", createdAt: 1, updatedAt: 1),
            ScratchlistEntry(entryId: "e2", text: "two", createdAt: 2, updatedAt: 2),
        ]
        harness.scratchlist.states["sess-1"] = state

        #expect(harness.interactor.scratchlistCount == 2)

        let bare = try ScratchlistSeamHarness(withStore: false)
        #expect(bare.interactor.scratchlistCount == 0)
    }
}

@Suite("Scratchlist composer workflow")
@MainActor
struct ScratchlistComposerWorkflowTests {
    private var attachment: ScratchlistAttachment {
        ScratchlistAttachment(id: "photo-1", filename: "screen.png", mimeType: "image/png", size: 4,
            path: "hapi-hub:scratchlist/default/sess-1/photo-1.png")
    }
    private func entry(_ text: String = "Next task", attachments: [ScratchlistAttachment] = []) -> ScratchlistEntry {
        ScratchlistEntry(entryId: "e1", text: text, createdAt: 1, updatedAt: 2, attachments: attachments)
    }

    @Test func modeRoutesSubmitToParkAndStaysReadyForAnotherDraft() async throws {
        let h = try ScratchlistSeamHarness()
        h.scratchlist.createResult = .created(entry())
        h.interactor.setComposerText("Next task")
        h.interactor.setComposerDestination(.scratchlist)
        h.interactor.sendMessage(steer: true)
        try await expectEventually { !h.interactor.scratchlistBusy }
        #expect(h.interactor.composerText.isEmpty)
        #expect(h.interactor.composerDestination == .scratchlist)
        #expect(h.scratchlist.createCalls.count == 1)
        #expect(await h.performer.requests.isEmpty)
    }

    @Test func returningToChatKeepsDraftAndDoesNotSend() throws {
        let h = try ScratchlistSeamHarness()
        h.interactor.setComposerText("not ready")
        h.interactor.setComposerDestination(.scratchlist)
        h.interactor.setComposerDestination(.chat)
        #expect(h.interactor.composerText == "not ready")
        #expect(h.scratchlist.createCalls.isEmpty)
    }

    @Test func attachmentOnlyRestoreIsLocalBorrowedAndExitsMode() async throws {
        let h = try ScratchlistSeamHarness()
        h.interactor.setComposerDestination(.scratchlist)
        #expect(await h.interactor.restoreScratchlistEntry(entry("", attachments: [attachment])))
        #expect(h.interactor.composerDestination == .chat)
        #expect(h.interactor.composerFocusRequest == 1)
        #expect(h.interactor.attachments.items.count == 1)
        #expect(h.interactor.attachments.allReady)
        h.interactor.attachments.remove(h.interactor.attachments.items[0].id)
        try await Task.sleep(for: .milliseconds(20))
        #expect(await h.performer.requests.isEmpty, "Borrowed attachments must not be uploaded, resumed, or deleted")
    }

    @Test func appendKeepsCurrentTextAndAttachmentsAndDeduplicatesBorrowedFiles() async throws {
        let h = try ScratchlistSeamHarness()
        h.interactor.setComposerText("Existing")
        h.interactor.attachments.restoreScratchlist([attachment])
        #expect(await h.interactor.restoreScratchlistEntry(entry(attachments: [attachment]), choice: .append))
        #expect(h.interactor.composerText == "Existing\nNext task")
        #expect(h.interactor.attachments.items.count == 1)
    }

    @Test func parkThenTakeIsAtomicOnFailureAndCopiesAttachmentsOnSuccess() async throws {
        let h = try ScratchlistSeamHarness()
        h.interactor.setComposerText("Existing")
        h.interactor.attachments.restoreScratchlist([attachment])
        #expect(!(await h.interactor.restoreScratchlistEntry(entry(), choice: .parkCurrent)))
        #expect(h.interactor.composerText == "Existing")
        #expect(h.interactor.attachments.items.count == 1)
        h.scratchlist.createResult = .created(entry("Existing", attachments: [attachment]))
        #expect(await h.interactor.restoreScratchlistEntry(entry(), choice: .parkCurrent))
        #expect(h.scratchlist.createCalls.last?.attachments == [attachment])
        #expect(h.interactor.composerText == "Next task")
        #expect(h.interactor.attachments.items.isEmpty)
        #expect(h.scratchlist.createIds[0] == h.scratchlist.createIds[1])
    }

    @Test func duplicateParkClicksSubmitOnceAndProtectMidflightChanges() async throws {
        let h = try ScratchlistSeamHarness()
        h.scratchlist.holdCreates = true
        h.scratchlist.createResult = .created(entry())
        h.interactor.setComposerText("Next task")
        h.interactor.parkComposerDraft()
        h.interactor.parkComposerDraft()
        try await expectEventually { h.scratchlist.createCalls.count == 1 }
        h.interactor.setComposerText("Still typing")
        h.scratchlist.resumeCreates()
        try await expectEventually { !h.interactor.scratchlistBusy }
        #expect(h.interactor.composerText == "Still typing")
        #expect(h.scratchlist.createCalls.count == 1)
    }

    @Test func overlongAndUnsupportedDraftsNeverSendOrTruncate() async throws {
        let h = try ScratchlistSeamHarness()
        let long = String(repeating: "😀", count: 5_001)
        h.interactor.setComposerText(long)
        h.interactor.parkComposerDraft()
        try await expectEventually { !h.interactor.scratchlistBusy }
        #expect(h.interactor.composerText == long)
        #expect(h.scratchlist.createCalls.isEmpty)
        var video = attachment
        video.mimeType = "video/mp4"
        h.interactor.setComposerText("")
        h.interactor.attachments.restoreScratchlist([video])
        h.interactor.setComposerDestination(.scratchlist)
        h.interactor.sendMessage()
        try await expectEventually { !h.interactor.scratchlistBusy }
        #expect(h.interactor.scratchlistError != nil)
        #expect(h.interactor.attachments.items.count == 1)
        #expect(h.scratchlist.createCalls.isEmpty)
        #expect(await h.performer.requests.isEmpty)
    }

    @Test func directQueueDoesNotConsumeComposerAndRemovalRetryDoesNotSendAgain() async throws {
        let h = try ScratchlistSeamHarness()
        await h.performer.setRoutes([(pathPrefix: "/api/sessions/sess-1/messages", json: "{}")])
        h.interactor.setComposerText("Unrelated input")
        h.scratchlist.deleteResult = false
        #expect(!(await h.interactor.queueScratchlistEntry(entry())))
        #expect(h.interactor.composerText == "Unrelated input")
        #expect(h.interactor.queuedScratchlistEntries.contains("e1"))
        let before = await h.performer.requests.filter { $0.httpMethod == "POST" }
        #expect(before.count == 1)
        let body = try #require(before.first?.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["deliveryMode"] as? String == "queue")
        #expect(json["text"] as? String == "Next task")
        h.scratchlist.deleteResult = true
        #expect(await h.interactor.queueScratchlistEntry(entry()))
        #expect(await h.performer.requests.filter { $0.httpMethod == "POST" }.count == 1)
        #expect(h.scratchlist.deleteCalls.count == 2)
        #expect(h.interactor.queuedScratchlistEntries.isEmpty)
    }

    @Test func failedQueueKeepsEntryAndRetriesWithTheSameLocalId() async throws {
        let h = try ScratchlistSeamHarness()
        #expect(!(await h.interactor.queueScratchlistEntry(entry())))
        #expect(h.scratchlist.deleteCalls.isEmpty)
        await h.performer.setRoutes([(pathPrefix: "/api/sessions/sess-1/messages", json: "{}")])
        #expect(await h.interactor.queueScratchlistEntry(entry()))
        let posts = await h.performer.requests.filter { $0.httpMethod == "POST" }
        #expect(posts.count == 2)
        let ids = try posts.map {
            let data = try #require($0.httpBody)
            let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            return json["localId"] as? String
        }
        #expect(ids[0] == ids[1])
        #expect(h.scratchlist.deleteCalls.count == 1)
    }
}
