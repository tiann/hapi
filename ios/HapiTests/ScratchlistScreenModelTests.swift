import HapiClient
import HapiProtocol
import Observation
import XCTest
@testable import Hapi

@MainActor @Observable
final class ScratchlistTestStore: SessionScratchlistStoring {
    var session = ScratchlistSessionState()
    var updates: [(String?, [ScratchlistAttachment]?)] = []
    var deletedAttachments: [String] = []
    var updateSucceeds = true
    var holdUpload = false
    var uploadStarted = false
    var uploadSucceeds = true
    var uploadCount = 0
    @ObservationIgnored var uploadGate: CheckedContinuation<Void, Never>?
    let uploaded = ScratchlistAttachment(id: "new-photo", filename: "new.txt", mimeType: "text/plain", size: 4, path: "hapi-hub:scratchlist/test/new.txt")

    init(entries: [ScratchlistEntry] = []) {
        session.loaded = true
        session.entries = entries
    }
    func state(_ sessionId: String) -> ScratchlistSessionState { session }
    func open(_ sessionId: String) {}
    func release(_ sessionId: String) {}
    func refresh(_ sessionId: String) async throws {}
    func createEntry(sessionId: String, text: String, attachments: [ScratchlistAttachment], entryId: String?) async -> ScratchlistCreateResult {
        let entry = ScratchlistEntry(entryId: entryId ?? "new", text: text, createdAt: 1, updatedAt: 1, attachments: attachments)
        session.entries.insert(entry, at: 0)
        return .created(entry)
    }
    func updateEntry(sessionId: String, entryId: String, text: String?, attachments: [ScratchlistAttachment]?) async -> Bool {
        updates.append((text, attachments))
        return updateSucceeds
    }
    func deleteEntry(sessionId: String, entryId: String) async -> Bool { true }
    func uploadAttachment(sessionId: String, filename: String, data: Data, mimeType: String) async -> ScratchlistUploadResult {
        uploadStarted = true
        uploadCount += 1
        if holdUpload { await withCheckedContinuation { uploadGate = $0 } }
        return uploadSucceeds ? .uploaded(uploaded) : .failed(message: "offline", code: nil)
    }
    func deleteAttachment(sessionId: String, attachmentId: String) async -> ScratchlistAttachmentDeleteResult {
        deletedAttachments.append(attachmentId)
        return .removed
    }
    func limits(sessionId: String) async -> ScratchlistAttachmentLimits { .defaultLimits }
}

@MainActor
final class ScratchlistScreenModelTests: XCTestCase {
    private var original: ScratchlistEntry {
        ScratchlistEntry(entryId: "original", text: "Original text", createdAt: 1, updatedAt: 2,
            attachments: [ScratchlistAttachment(id: "old", filename: "reference.txt", mimeType: "text/plain", size: 5, path: "hub-path")])
    }
    private func wait(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for scratchlist state")
    }

    func testCancelDoesNotPersistTextOrAttachmentChanges() async throws {
        let store = ScratchlistTestStore(entries: [original])
        let model = ScratchlistScreenModel(sessionId: "session", store: store)
        model.openEditor(original)
        model.setEditorText("Changed")
        model.removeAttachment(original.attachments[0])
        XCTAssertTrue(model.editor?.isDirty == true)
        XCTAssertTrue(store.updates.isEmpty)
        model.dismissEditor()
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertNil(model.editor)
        XCTAssertTrue(store.updates.isEmpty)
        XCTAssertTrue(store.deletedAttachments.isEmpty)
    }

    func testSaveCommitsTextAndAttachmentsTogetherAndKeepsFailedDraft() async throws {
        let store = ScratchlistTestStore(entries: [original])
        store.updateSucceeds = false
        let model = ScratchlistScreenModel(sessionId: "session", store: store)
        model.openEditor(original)
        model.setEditorText("Changed")
        model.removeAttachment(original.attachments[0])
        model.saveEditor()
        try await wait { model.editor?.isSaving == false }
        XCTAssertEqual(store.updates.count, 1)
        XCTAssertEqual(store.updates[0].0, "Changed")
        XCTAssertEqual(store.updates[0].1, [])
        XCTAssertEqual(model.editor?.text, "Changed")
        XCTAssertNotNil(model.editor?.error)
        XCTAssertTrue(store.deletedAttachments.isEmpty)
        store.updateSucceeds = true
        model.saveEditor()
        try await wait { model.editor == nil && store.deletedAttachments == ["old"] }
    }

    func testLateUploadCannotWriteIntoAnotherEditor() async throws {
        let store = ScratchlistTestStore(entries: [original])
        store.holdUpload = true
        let model = ScratchlistScreenModel(sessionId: "session", store: store)
        model.openEditor(original)
        model.addPreparedAttachment(PreparedAttachment(filename: "new.txt", mimeType: "text/plain", bytes: Data("test".utf8)))
        try await wait { store.uploadStarted }
        model.dismissEditor()
        model.openEditor(ScratchlistEntry(entryId: "another", text: "Another", createdAt: 2, updatedAt: 2))
        store.uploadGate?.resume()
        store.uploadGate = nil
        try await wait { store.deletedAttachments.contains("new-photo") }
        XCTAssertEqual(model.editor?.entryId, "another")
        XCTAssertEqual(model.editor?.attachments, [])
        XCTAssertFalse(model.editor?.isUploading ?? true)
        XCTAssertTrue(store.updates.isEmpty)
    }

    func testCancellingUploadedAttachmentCleansOnlyTheNewFile() async throws {
        let store = ScratchlistTestStore(entries: [original])
        let model = ScratchlistScreenModel(sessionId: "session", store: store)
        model.openEditor(original)
        model.addPreparedAttachment(PreparedAttachment(filename: "new.txt", mimeType: "text/plain", bytes: Data("test".utf8)))
        try await wait { model.editor?.isUploading == false }
        XCTAssertEqual(model.editor?.attachments.count, 2)
        XCTAssertTrue(store.updates.isEmpty)
        model.dismissEditor()
        try await wait { store.deletedAttachments == ["new-photo"] }
    }

    func testUTF16LimitAndAttachmentOnlyValidation() {
        let store = ScratchlistTestStore(entries: [original])
        let model = ScratchlistScreenModel(sessionId: "session", store: store)
        model.openEditor(original)
        model.setEditorText("")
        XCTAssertTrue(model.editor?.canSave == true)
        model.removeAttachment(original.attachments[0])
        XCTAssertFalse(model.editor?.canSave ?? true)
        model.setEditorText(String(repeating: "😀", count: 5001))
        XCTAssertFalse(model.editor?.canSave ?? true)
        model.saveEditor()
        XCTAssertTrue(store.updates.isEmpty)
        XCTAssertEqual(model.editor?.text.utf16.count, 10_002)
    }

    func testFailedUploadBlocksSaveAndRetryRetriesTheFileNotTheSave() async throws {
        let store = ScratchlistTestStore(entries: [original])
        store.uploadSucceeds = false
        let model = ScratchlistScreenModel(sessionId: "session", store: store)
        model.openEditor(original)
        model.addPreparedAttachment(PreparedAttachment(filename: "new.txt", mimeType: "text/plain", bytes: Data("test".utf8)))
        try await wait { model.editor?.isUploading == false }
        XCTAssertEqual(model.editor?.failedUploadName, "new.txt")
        XCTAssertFalse(model.editor?.canSave ?? true)
        model.saveEditor()
        XCTAssertTrue(store.updates.isEmpty)
        store.uploadSucceeds = true
        model.retryEditorOperation()
        try await wait { model.editor?.failedUploadName == nil }
        XCTAssertEqual(store.uploadCount, 2)
        XCTAssertEqual(model.editor?.attachments.count, 2)
        XCTAssertTrue(store.updates.isEmpty, "Retry upload must not save or dismiss the editor")
        XCTAssertTrue(model.editor?.canSave == true)
    }
}
