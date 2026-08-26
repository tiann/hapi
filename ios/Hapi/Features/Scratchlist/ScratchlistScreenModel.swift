import Foundation
import HapiClient
import HapiProtocol
import Observation
import PhotosUI
// PhotosPickerItem lives in the `_PhotosUI_SwiftUI` cross-import overlay:
// it is only visible when SwiftUI is imported alongside PhotosUI.
import SwiftUI
import UniformTypeIdentifiers

/// Edit-sheet model; `entryId == nil` = drafting a brand-new entry.
struct ScratchlistEditorState: Equatable {
    var entryId: String?
    var text = ""
    var attachments: [ScratchlistAttachment] = []
    /// A picked file is importing/uploading — spinner tile in the strip.
    var isUploading = false
}

/// Per-session scratchlist workbench (A-M4b) — the iOS port of the Android
/// `ScratchlistViewModel`: the entries list rides
/// ``SessionScratchlistStoring``'s per-session cache (optimistic CRUD +
/// SSE-triggered refetch handled there); this model owns the edit-sheet draft
/// state and the attachment import→upload flow.
///
/// Attachment writes: on an **existing** entry every strip change persists
/// immediately (upload → `PUT {attachments}` / remove → PUT minus the file,
/// then a best-effort attachment delete to free session bytes). On a **new**
/// entry uploads accumulate locally and travel with the create; dismissing
/// the draft best-effort deletes the now-orphaned uploads.
@MainActor @Observable
final class ScratchlistScreenModel {
    let sessionId: String
    @ObservationIgnored private let store: any SessionScratchlistStoring

    /// Non-nil while the edit sheet is open.
    private(set) var editor: ScratchlistEditorState?
    /// Transient failure/notice toast (the Android snackbar analogue).
    private(set) var notice: String?
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    @ObservationIgnored private var opened = false

    init(sessionId: String, store: any SessionScratchlistStoring) {
        self.sessionId = sessionId
        self.store = store
    }

    // MARK: - List state (from the store)

    var state: ScratchlistSessionState { store.state(sessionId) }

    /// First fetch still running, nothing cached yet.
    var isLoading: Bool { !state.loaded && !state.loadFailed }

    // MARK: - Lifecycle (paired with the screen's appear/disappear)

    func start() {
        guard !opened else { return }
        opened = true
        store.open(sessionId)
    }

    func stop() {
        guard opened else { return }
        opened = false
        noticeTask?.cancel()
        store.release(sessionId)
    }

    /// Error-state retry.
    func retry() {
        Task { [self] in
            try? await store.refresh(sessionId)
        }
    }

    // MARK: - Editor

    /// Card tap (existing) or the new-note button (`entry == nil`, new draft).
    func openEditor(_ entry: ScratchlistEntry?) {
        if entry == nil, state.atCap {
            showNotice(String(localized: "Scratchlist is full (200 entries) — delete one first"))
            return
        }
        if let entry {
            editor = ScratchlistEditorState(
                entryId: entry.entryId,
                text: entry.text,
                attachments: entry.attachments
            )
        } else {
            editor = ScratchlistEditorState()
        }
    }

    /// Sheet dismissed without saving; orphaned new-draft uploads are freed.
    func dismissEditor() {
        guard let editor else { return }
        self.editor = nil
        if editor.entryId == nil, !editor.attachments.isEmpty {
            Task { [self] in
                for attachment in editor.attachments {
                    _ = await store.deleteAttachment(sessionId: sessionId, attachmentId: attachment.id)
                }
            }
        }
    }

    func setEditorText(_ text: String) {
        editor?.text = text
    }

    /// Save closes the sheet immediately (mutations are store-optimistic and
    /// roll back with a notice on failure — web parity).
    func saveEditor() {
        guard let editor else { return }
        let text = editor.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty, editor.attachments.isEmpty {
            // Nothing to keep: a new draft just closes; an existing entry
            // must keep text or attachments (hub 400s empty updates).
            if editor.entryId == nil {
                self.editor = nil
            } else {
                showNotice("A note needs text or an attachment — use Delete to remove it")
            }
            return
        }
        self.editor = nil
        Task { [self] in
            if let entryId = editor.entryId {
                let updated = await store.updateEntry(
                    sessionId: sessionId,
                    entryId: entryId,
                    text: text,
                    attachments: nil
                )
                if !updated {
                    showNotice(String(localized: "Couldn't save the note — check the hub connection"))
                }
            } else {
                switch await store.createEntry(sessionId: sessionId, text: text, attachments: editor.attachments) {
                case .created:
                    break
                case .atCap:
                    showNotice(String(localized: "Scratchlist is full (200 entries)"))
                case .failed:
                    showNotice(String(localized: "Couldn't save the note — check the hub connection"))
                }
            }
        }
    }

    /// Sheet delete; optimistic with store rollback.
    func deleteEntry(_ entryId: String) {
        if editor?.entryId == entryId {
            editor = nil
        }
        Task { [self] in
            let deleted = await store.deleteEntry(sessionId: sessionId, entryId: entryId)
            if !deleted {
                showNotice(String(localized: "Couldn't delete the note — check the hub connection"))
            }
        }
    }

    // MARK: - Attachments

    /// Photo-picker result → guard/downscale → upload → strip (and PUT for
    /// existing entries).
    func addAttachment(_ item: PhotosPickerItem) {
        guard let current = editor, !current.isUploading else { return }
        editor?.isUploading = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.editor?.isUploading = false }
            let limits = await self.store.limits(sessionId: self.sessionId)
            guard let existing = self.editor?.attachments else { return }
            guard let data = try? await item.loadTransferable(type: Data.self), !data.isEmpty else {
                self.showNotice(String(localized: "Couldn't read the selected photo"))
                return
            }
            let contentType = item.supportedContentTypes.first
            let mimeType = contentType?.preferredMIMEType ?? "application/octet-stream"
            let filename = Self.pickedFilename(for: contentType)
            // Guard + downscale are CPU work — keep them off the main actor.
            let outcome = await Task.detached(priority: .userInitiated) {
                ScratchlistAttachmentImport.prepare(
                    data: data,
                    filename: filename,
                    mimeType: mimeType,
                    existing: existing,
                    limits: limits
                )
            }.value
            switch outcome {
            case .rejected(let message):
                self.showNotice(message)
            case .ready(let prepared):
                let uploaded = await self.store.uploadAttachment(
                    sessionId: self.sessionId,
                    filename: prepared.filename,
                    data: prepared.data,
                    mimeType: prepared.mimeType
                )
                switch uploaded {
                case .failed(_, let code):
                    self.showNotice(Self.uploadFailureMessage(code: code))
                case .uploaded(let attachment):
                    await self.attachToEditor(attachment)
                }
            }
        }
    }

    private func attachToEditor(_ attachment: ScratchlistAttachment) async {
        guard let editor else {
            // Sheet closed mid-upload: don't leak the stored file.
            _ = await store.deleteAttachment(sessionId: sessionId, attachmentId: attachment.id)
            return
        }
        let next = editor.attachments + [attachment]
        self.editor?.attachments = next
        if let entryId = editor.entryId {
            let updated = await store.updateEntry(
                sessionId: sessionId,
                entryId: entryId,
                text: nil,
                attachments: next
            )
            if !updated {
                rollbackEditorAttachments(entryId: entryId, to: editor.attachments)
                _ = await store.deleteAttachment(sessionId: sessionId, attachmentId: attachment.id)
                showNotice(String(localized: "Couldn't attach the file — check the hub connection"))
            }
        }
    }

    /// Restore the strip to `attachments` if the sheet still edits `entryId`.
    private func rollbackEditorAttachments(entryId: String, to attachments: [ScratchlistAttachment]) {
        guard editor?.entryId == entryId else { return }
        editor?.attachments = attachments
    }

    /// Strip ✕: detach (existing entries PUT immediately) and free the stored file.
    func removeAttachment(_ attachment: ScratchlistAttachment) {
        guard let editor else { return }
        let next = editor.attachments.filter { $0.id != attachment.id }
        guard next.count != editor.attachments.count else { return }
        self.editor?.attachments = next
        Task { [self] in
            if let entryId = editor.entryId {
                let updated = await store.updateEntry(
                    sessionId: sessionId,
                    entryId: entryId,
                    text: nil,
                    attachments: next
                )
                if !updated {
                    rollbackEditorAttachments(entryId: entryId, to: editor.attachments)
                    showNotice(String(localized: "Couldn't remove the attachment — check the hub connection"))
                    return
                }
            }
            // Best-effort byte-budget cleanup; InUse just means another entry
            // still references the file (fine to leave).
            _ = await store.deleteAttachment(sessionId: sessionId, attachmentId: attachment.id)
        }
    }

    // MARK: - Internals

    private static func uploadFailureMessage(code: String?) -> String {
        code == ScratchlistErrorCode.attachmentTooLarge
            ? String(localized: "That file is over the hub's per-file size limit")
            : String(localized: "Upload failed — check the hub connection")
    }

    private static func pickedFilename(for contentType: UTType?) -> String {
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        let ext = contentType?.preferredFilenameExtension ?? "bin"
        return "photo-\(stamp).\(ext)"
    }

    private func showNotice(_ message: String) {
        notice = message
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }
}
