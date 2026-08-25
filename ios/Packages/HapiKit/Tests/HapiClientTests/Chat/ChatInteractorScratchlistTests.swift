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
        attachments: [ScratchlistAttachment]
    ) async -> ScratchlistCreateResult {
        createCalls.append((sessionId, text, attachments))
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
        true
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
    private(set) var events: [ChatInteractionEvent] = []

    init(withStore: Bool = true) throws {
        let api = try makeStoreAPIClient(performer: RoutingPerformer())
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
