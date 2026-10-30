import Foundation
import HapiClient
import HapiProtocol
import Observation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ScratchlistEditorState: Equatable, Identifiable {
    let id = UUID()
    var entryId: String?
    var text = ""
    var attachments: [ScratchlistAttachment] = []
    var originalText = ""
    var originalAttachments: [ScratchlistAttachment] = []
    var uploaded: [ScratchlistAttachment] = []
    var isUploading = false
    var isSaving = false
    var error: String?
    var saveFailed = false
    var failedUploadName: String?

    var isDirty: Bool { text != originalText || attachments != originalAttachments || isUploading || failedUploadName != nil }
    var canSave: Bool {
        !isUploading && !isSaving && failedUploadName == nil && text.utf16.count <= ScratchlistCaps.maxTextLength
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }
}

/// Transactional editor: text and attachment membership commit together.
/// Each opening has an identity, so a late upload cannot attach to a new editor.
@MainActor @Observable
final class ScratchlistScreenModel {
    let sessionId: String
    @ObservationIgnored private let store: any SessionScratchlistStoring
    private(set) var editor: ScratchlistEditorState?
    private(set) var notice: String?
    private(set) var deletingEntryId: String?
    @ObservationIgnored private var opened = false
    @ObservationIgnored private var createId: String?
    @ObservationIgnored private var retryUpload: PreparedAttachment?

    init(sessionId: String, store: any SessionScratchlistStoring) {
        self.sessionId = sessionId
        self.store = store
    }

    var state: ScratchlistSessionState { store.state(sessionId) }
    var isLoading: Bool { !state.loaded && !state.loadFailed }

    func start() {
        guard !opened else { return }
        opened = true
        store.open(sessionId)
    }

    func stop() {
        guard opened else { return }
        opened = false
        store.release(sessionId)
    }

    func refresh() async { try? await store.refresh(sessionId) }
    func retry() { Task { await refresh() } }
    func clearNotice() { notice = nil }

    func openEditor(_ entry: ScratchlistEntry?) {
        guard editor == nil else { return }
        if entry == nil, state.atCap {
            notice = String(localized: "Scratchlist is full (200 entries)")
            return
        }
        createId = "scratch-\(UUID().uuidString)"
        editor = ScratchlistEditorState(entryId: entry?.entryId, text: entry?.text ?? "",
            attachments: entry?.attachments ?? [], originalText: entry?.text ?? "",
            originalAttachments: entry?.attachments ?? [])
    }

    func dismissEditor() {
        guard let draft = editor, !draft.isSaving else { return }
        editor = nil
        createId = nil
        retryUpload = nil
        cleanup(draft.uploaded)
    }

    func setEditorText(_ text: String) {
        guard editor?.isSaving == false else { return }
        editor?.text = text
    }

    func reportEditorError(_ message: String) {
        editor?.error = message
        editor?.saveFailed = false
    }

    var editorErrorIsRetryable: Bool { retryUpload != nil || editor?.saveFailed == true }

    func retryEditorOperation() {
        if let prepared = retryUpload, let draft = editor, !draft.isUploading, !draft.isSaving {
            editor?.isUploading = true
            editor?.error = nil
            Task { await uploadPrepared(prepared, draftId: draft.id) }
        } else if editor?.saveFailed == true { saveEditor() }
        else { editor?.error = nil }
    }

    func removeFailedUpload() {
        guard editor?.isUploading == false else { return }
        retryUpload = nil
        editor?.failedUploadName = nil
        editor?.error = nil
    }

    func saveEditor() {
        guard let draft = editor, draft.canSave else { return }
        editor?.isSaving = true
        editor?.error = nil
        editor?.saveFailed = false
        let createId = createId
        Task {
            let saved: Bool
            let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if let entryId = draft.entryId {
                saved = await store.updateEntry(sessionId: sessionId, entryId: entryId, text: text, attachments: draft.attachments)
            } else {
                switch await store.createEntry(sessionId: sessionId, text: text, attachments: draft.attachments, entryId: createId) {
                case .created: saved = true
                case .atCap:
                    saved = false
                    editor?.error = String(localized: "Scratchlist is full (200 entries)")
                case .failed: saved = false
                }
            }
            guard editor?.id == draft.id else { return }
            if saved {
                editor = nil
                self.createId = nil
                retryUpload = nil
                let retained = Set(draft.attachments.map(\.id))
                cleanup((draft.originalAttachments + draft.uploaded).filter { !retained.contains($0.id) })
            } else {
                editor?.isSaving = false
                editor?.saveFailed = true
                if editor?.error == nil {
                    editor?.error = String(localized: "Couldn't save the draft — your changes are kept here")
                }
            }
        }
    }

    func deleteEntry(_ entryId: String) {
        guard deletingEntryId == nil else { return }
        deletingEntryId = entryId
        notice = nil
        Task {
            defer { deletingEntryId = nil }
            if !(await store.deleteEntry(sessionId: sessionId, entryId: entryId)) {
                notice = String(localized: "Couldn't delete the note — check the hub connection")
            }
        }
    }

    func addAttachment(_ item: PhotosPickerItem) {
        guard let draft = editor, !draft.isUploading, !draft.isSaving, draft.failedUploadName == nil else { return }
        editor?.isUploading = true
        editor?.error = nil
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self), !data.isEmpty else {
                finishImport(id: draft.id, error: String(localized: "Couldn't read the selected photo"))
                return
            }
            let type = item.supportedContentTypes.first
            await importAttachment(data: data, filename: "photo-\(UUID().uuidString).\(type?.preferredFilenameExtension ?? "jpg")",
                mimeType: type?.preferredMIMEType ?? "image/jpeg", draft: draft)
        }
    }

    func addPreparedAttachment(_ attachment: PreparedAttachment) {
        guard let draft = editor, !draft.isUploading, !draft.isSaving, draft.failedUploadName == nil else { return }
        editor?.isUploading = true
        editor?.error = nil
        Task {
            await importAttachment(data: attachment.bytes, filename: attachment.filename, mimeType: attachment.mimeType, draft: draft)
        }
    }

    private func importAttachment(data: Data, filename: String, mimeType: String, draft: ScratchlistEditorState) async {
        let limits = await store.limits(sessionId: sessionId)
        guard editor?.id == draft.id else { return }
        let outcome = await Task.detached(priority: .userInitiated) {
            ScratchlistAttachmentImport.prepare(data: data, filename: filename, mimeType: mimeType,
                existing: draft.attachments, limits: limits)
        }.value
        guard editor?.id == draft.id else { return }
        switch outcome {
        case .rejected(let message): finishImport(id: draft.id, error: message)
        case .ready(let prepared):
            await uploadPrepared(PreparedAttachment(filename: prepared.filename, mimeType: prepared.mimeType, bytes: prepared.data), draftId: draft.id)
        }
    }

    private func uploadPrepared(_ prepared: PreparedAttachment, draftId: UUID) async {
        let result = await store.uploadAttachment(sessionId: sessionId, filename: prepared.filename,
            data: prepared.bytes, mimeType: prepared.mimeType)
        switch result {
        case .uploaded(let attachment):
            guard editor?.id == draftId else {
                cleanup([attachment])
                return
            }
            retryUpload = nil
            editor?.failedUploadName = nil
            editor?.attachments.append(attachment)
            editor?.uploaded.append(attachment)
            finishImport(id: draftId, error: nil)
        case .failed:
            guard editor?.id == draftId else { return }
            retryUpload = prepared
            editor?.failedUploadName = prepared.filename
            finishImport(id: draftId, error: String(localized: "Upload failed — check the hub connection"))
        }
    }

    private func finishImport(id: UUID, error: String?) {
        guard editor?.id == id else { return }
        editor?.isUploading = false
        editor?.error = error
        editor?.saveFailed = false
    }

    func removeAttachment(_ attachment: ScratchlistAttachment) {
        guard editor?.isSaving == false, editor?.isUploading == false else { return }
        editor?.attachments.removeAll { $0.id == attachment.id }
        // Even local uploads wait for Save/Cancel cleanup; a failed Save is retryable.
    }

    private func cleanup(_ attachments: [ScratchlistAttachment]) {
        guard !attachments.isEmpty else { return }
        Task {
            for attachment in attachments {
                _ = await store.deleteAttachment(sessionId: sessionId, attachmentId: attachment.id)
            }
        }
    }
}
