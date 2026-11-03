import Foundation
import HapiProtocol
import Observation

/// A picked file after platform preparation (bytes read + optional ImageIO
/// downscale): everything the upload flow needs, no UIKit types — package
/// tests feed these directly. Mirror of the Android `PreparedAttachment`.
public struct PreparedAttachment: Sendable {
    public let id: String
    /// Display/upload filename (extension rewritten to `.jpg` when compressed).
    public let filename: String
    public let mimeType: String
    /// The exact bytes that will upload (post-compression when applicable).
    public let bytes: Data
    /// Small JPEG thumbnail for the chip + wire `previewUrl`; nil for non-images.
    public let previewBytes: Data?

    public var sizeBytes: Int { bytes.count }

    public init(
        id: String = "att-\(UUID().uuidString)",
        filename: String,
        mimeType: String,
        bytes: Data,
        previewBytes: Data? = nil
    ) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.bytes = bytes
        self.previewBytes = previewBytes
    }
}

/// Chip lifecycle: uploading → ready (or failed → retry/remove).
public enum ComposerAttachmentStatus: Equatable, Sendable {
    case uploading
    case ready
    case failed
}

/// One composer attachment chip.
public struct ComposerAttachmentUI: Equatable, Sendable, Identifiable {
    public let id: String
    public let filename: String
    public let mimeType: String
    public let sizeBytes: Int
    /// JPEG thumbnail bytes for image picks; nil renders a file glyph.
    public let previewBytes: Data?
    public let status: ComposerAttachmentStatus
    /// Upload failure detail, never the request body or file contents.
    public let errorMessage: String?

    public init(
        id: String,
        filename: String,
        mimeType: String,
        sizeBytes: Int,
        previewBytes: Data?,
        status: ComposerAttachmentStatus,
        errorMessage: String? = nil
    ) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.previewBytes = previewBytes
        self.status = status
        self.errorMessage = errorMessage
    }

    func with(status: ComposerAttachmentStatus, errorMessage: String? = nil) -> ComposerAttachmentUI {
        ComposerAttachmentUI(
            id: id,
            filename: filename,
            mimeType: mimeType,
            sizeBytes: sizeBytes,
            previewBytes: previewBytes,
            status: status,
            errorMessage: errorMessage
        )
    }
}

/// Transport seam over the two upload endpoints (Android
/// `AttachmentUploadApi`); ``APIClient`` conforms via its existing
/// `MediaEndpoints` methods, tests script HTTP through the performer.
public protocol AttachmentUploading: Sendable {
    /// `POST /api/sessions/:id/upload` — JSON + base64.
    func uploadFile(
        sessionId: String,
        filename: String,
        data: Data,
        mimeType: String
    ) async throws -> UploadFileResponse

    /// `POST /api/sessions/:id/upload/delete`.
    @discardableResult
    func deleteUpload(sessionId: String, path: String) async throws -> DeleteUploadResponse

    func uploadScratchlistAttachment(sessionId: String, filename: String, data: Data, mimeType: String) async throws -> ScratchlistUploadResponse
    func deleteScratchlistAttachment(sessionId: String, attachmentId: String) async throws
}

extension APIClient: AttachmentUploading {}

/// Composer attachment tray (A-M3f): upload-on-pick state machine feeding
/// `SendMessageRequest.attachments` — the iOS port of the Android
/// `ComposerAttachments` (B-M3f), which itself mirrors the web
/// `attachmentAdapter.ts` flow with mobile adjustments:
///
/// Scratchlist picks upload to the hub rather than the agent machine. Saved
/// references restored into the tray are borrowed (never deleted here) and
/// staged to chat storage only by an explicit send. The two ownership maps
/// separately track unsaved hub uploads and unconsumed chat uploads.
///
/// - ``add(_:)`` uploads immediately (`POST upload`, JSON + base64) and
///   tracks the chip through ``ComposerAttachmentStatus``; retains the
///   payload bytes for ``retry(_:)`` and session-ID migration until send or
///   removal. Upload paths are session-scoped, so migration must re-upload.
/// - ``remove(_:)`` deletes the uploaded file best-effort
///   (`POST upload/delete`); removing a chip whose upload is still in flight
///   lets the upload finish and then deletes the orphan (web
///   `cancelledAttachmentIds` semantics).
/// - ``consume()`` converts every Ready chip into `AttachmentMetadata` for
///   the send body — `previewUrl` is a small JPEG data URL
///   (``AttachmentPolicy/previewMaxDimension``) so user bubbles render
///   thumbnails on every client.
/// - **Drafts (v1 simplification)**: unlike the web (IndexedDB attachment
///   drafts), attachments never persist. The tray lives with its
///   ``ChatInteractor`` across screen covers (the interactor's
///   deactivate/activate cycles); when the chat is left for good the tray
///   deallocates and `deinit` deletes the un-sent uploads best-effort — the
///   Android `discardAllDetached` (holder `onCleared`) analogue.
///   ``discardAllDetached()`` stays callable for an explicit discard.
/// - **Inactive sessions**: the owning interactor supplies resume recovery.
///   A `session_inactive` response resumes once, then retries the upload. A
///   superseding session receives the same tray, with old uploads re-staged
///   under the new ID and cleanup still scoped to each upload's owner.
@MainActor @Observable
public final class ComposerAttachments {
    private struct Entry {
        var ui: ComposerAttachmentUI
        /// Hub upload path once Ready.
        var path: String?
        /// Retained until consumption/removal for retries and session-ID migration.
        var bytes: Data?
        var scratchlist: ScratchlistAttachment?
        var uploadsToScratchlist = false
    }

    private var entries: [Entry] = []

    private let api: any AttachmentUploading
    private var sessionId: String
    /// Nonisolated shadow of the Ready chips' hub paths, so `deinit` (which
    /// cannot touch main-actor state) can schedule the orphan cleanup.
    private let uploadedPaths = UploadedPathBox<OwnedUpload>()
    private let ownedScratchlistIds = UploadedPathBox<OwnedUpload>()
    @ObservationIgnored var resumeInactiveSession: (@MainActor (String) async throws -> String)?
    @ObservationIgnored private var recoveryTask: Task<String, Error>?
    private var sessionRevision = 0

    public init(api: any AttachmentUploading, sessionId: String) {
        self.api = api
        self.sessionId = sessionId
    }

    deinit {
        // Leaving the chat for good: un-sent uploads are orphans on the hub —
        // delete them best-effort on a detached task (Android
        // `discardAllDetached` from the holder's `onCleared`). Only Sendable
        // stored lets are touched here.
        let paths = uploadedPaths.drain()
        Self.deleteDetached(api: api, uploads: paths)
        Self.deleteScratchlistDetached(api: api, uploads: ownedScratchlistIds.drain())
    }

    // MARK: - Read surface

    /// Chip states for the composer row.
    public var items: [ComposerAttachmentUI] {
        entries.map(\.ui)
    }

    /// Convenience for send gating: chips exist and every one settled Ready.
    public var allReady: Bool {
        !entries.isEmpty && !hasUnsettled
    }

    /// True while any chip is Uploading or Failed — send must wait or resolve.
    public var hasUnsettled: Bool {
        entries.contains { $0.ui.status != .ready }
    }

    public var snapshot: [ComposerAttachmentSnapshot] {
        entries.compactMap { entry in
            guard entry.ui.status == .ready else { return nil }
            if let attachment = entry.scratchlist {
                return ComposerAttachmentSnapshot(ui: entry.ui, source: .scratchlist(attachment))
            }
            return entry.path.map { ComposerAttachmentSnapshot(ui: entry.ui, source: .chatUpload($0)) }
        }
    }

    public var hasScratchlistAttachments: Bool { entries.contains { $0.scratchlist != nil } }

    /// Budget projection includes pending picks, not just completed uploads.
    public var scratchlistBudget: [ScratchlistAttachment] {
        entries.map { entry in
            entry.scratchlist ?? ScratchlistAttachment(id: entry.ui.id, filename: entry.ui.filename,
                mimeType: entry.ui.mimeType, size: entry.ui.sizeBytes, path: "")
        }
    }

    /// Borrowed references stay in hub storage until an explicit chat send.
    /// Removing these chips must never delete the original saved attachment.
    public func restoreScratchlist(_ attachments: [ScratchlistAttachment]) {
        for attachment in attachments {
            guard !entries.contains(where: { $0.scratchlist?.id == attachment.id }) else { continue }
            let ui = ComposerAttachmentUI(id: "restored-\(UUID().uuidString)", filename: attachment.filename,
                mimeType: attachment.mimeType, sizeBytes: attachment.size, previewBytes: nil, status: .ready)
            entries.append(Entry(ui: ui, path: nil, bytes: nil, scratchlist: attachment))
        }
    }

    public func markScratchlistPersisted(_ attachments: [ScratchlistAttachment]) {
        let ids = Set(attachments.map(\.id))
        for entry in entries where entry.scratchlist.map({ ids.contains($0.id) }) == true {
            ownedScratchlistIds.forget(id: entry.ui.id)
        }
    }

    public func discard(_ snapshot: [ComposerAttachmentSnapshot]) {
        for item in snapshot { remove(item.ui.id) }
    }

    /// Staged chat uploads now belong to the optimistic message, not this tray.
    public func consumePrepared(_ snapshot: [ComposerAttachmentSnapshot]) {
        for item in snapshot {
            uploadedPaths.forget(id: item.ui.id)
            remove(item.ui.id)
        }
    }

    // MARK: - Mutations

    /// Add a prepared pick to the tray and start its upload.
    public func add(_ prepared: PreparedAttachment, toScratchlist: Bool = false) {
        let ui = ComposerAttachmentUI(
            id: prepared.id,
            filename: prepared.filename,
            mimeType: prepared.mimeType,
            sizeBytes: prepared.sizeBytes,
            previewBytes: prepared.previewBytes,
            status: .uploading
        )
        entries.append(Entry(ui: ui, path: nil, bytes: prepared.bytes, uploadsToScratchlist: toScratchlist))
        if toScratchlist {
            uploadScratchlist(id: prepared.id, filename: prepared.filename, mimeType: prepared.mimeType, bytes: prepared.bytes)
        } else {
            upload(id: prepared.id, filename: prepared.filename, mimeType: prepared.mimeType, bytes: prepared.bytes)
        }
    }

    /// Failed chip tap: re-fire the upload with the retained bytes.
    public func retry(_ id: String) {
        guard let index = entries.firstIndex(where: { $0.ui.id == id }),
              entries[index].ui.status == .failed,
              let bytes = entries[index].bytes else {
            return
        }
        let ui = entries[index].ui
        if entries[index].uploadsToScratchlist {
            entries[index].ui = ui.with(status: .uploading)
            uploadScratchlist(id: id, filename: ui.filename, mimeType: ui.mimeType, bytes: bytes)
            return
        }
        entries[index] = Entry(ui: ui.with(status: .uploading), path: nil, bytes: bytes)
        upload(id: id, filename: ui.filename, mimeType: ui.mimeType, bytes: bytes)
    }

    /// Drop a chip. An already-uploaded file is deleted best-effort; an
    /// in-flight upload deletes its result on completion (see `upload`).
    public func remove(_ id: String) {
        guard let index = entries.firstIndex(where: { $0.ui.id == id }) else { return }
        let removed = entries.remove(at: index)
        if let owned = ownedScratchlistIds.remove(id: id) {
            Self.deleteScratchlistDetached(api: api, uploads: [owned])
        }
        let ownedPath = uploadedPaths.remove(id: id)
        guard let path = ownedPath, removed.path != nil else { return }
        let api = api
        Task {
            _ = try? await api.deleteUpload(sessionId: path.sessionId, path: path.path)
        }
    }

    /// Take Ready chat-upload chips as send metadata, clearing them from the tray
    /// (unsettled chips stay put — the interactor guards against calling with
    /// any pending, but a race can settle one to Failed in between).
    ///
    /// Hub-backed chips require staging followed by ``consumePrepared(_:)``.
    /// - Returns: the metadata list, or nil when no chat upload was ready.
    public func consume() -> [AttachmentMetadata]? {
        var taken: [Entry] = []
        entries.removeAll { entry in
            guard entry.ui.status == .ready, entry.path != nil else { return false }
            taken.append(entry)
            return true
        }
        guard !taken.isEmpty else { return nil }
        for entry in taken {
            // The paths now belong to the sent message — never delete them.
            uploadedPaths.forget(id: entry.ui.id)
        }
        return taken.map { entry in
            AttachmentMetadata(
                id: entry.ui.id,
                filename: entry.ui.filename,
                mimeType: entry.ui.mimeType,
                size: entry.ui.sizeBytes,
                path: entry.path!,
                previewUrl: entry.ui.previewBytes.map {
                    AttachmentPolicy.dataUrl(mimeType: "image/jpeg", bytes: $0)
                }
            )
        }
    }

    /// Explicit discard of every chip: uploaded files are deleted best-effort
    /// on a detached task (safe to call while the owning scope is being torn
    /// down). `deinit` does the same for whatever is left.
    public func discardAllDetached() {
        entries = []
        let paths = uploadedPaths.drain()
        Self.deleteDetached(api: api, uploads: paths)
        Self.deleteScratchlistDetached(api: api, uploads: ownedScratchlistIds.drain())
    }

    // MARK: - Internals

    private func uploadScratchlist(id: String, filename: String, mimeType: String, bytes: Data) {
        let sessionId = sessionId
        Task {
            let attachment: ScratchlistAttachment?
            var errorMessage: String?
            do {
                let result = try await api.uploadScratchlistAttachment(sessionId: sessionId, filename: filename, data: bytes, mimeType: mimeType)
                attachment = result.success ? result.attachment : nil
                if attachment == nil {
                    errorMessage = result.error ?? "Invalid upload response"
                }
            } catch {
                attachment = nil
                errorMessage = error.localizedDescription
            }
            guard let index = entries.firstIndex(where: { $0.ui.id == id }) else {
                if let attachment { try? await api.deleteScratchlistAttachment(sessionId: sessionId, attachmentId: attachment.id) }
                return
            }
            entries[index].ui = entries[index].ui.with(status: attachment == nil ? .failed : .ready, errorMessage: errorMessage)
            entries[index].scratchlist = attachment
            if let attachment {
                entries[index].bytes = nil
                ownedScratchlistIds.set(id: id, path: OwnedUpload(sessionId: sessionId, path: attachment.id))
            }
        }
    }

    private nonisolated static func deleteScratchlistDetached(api: any AttachmentUploading, uploads: [OwnedUpload]) {
        guard !uploads.isEmpty else { return }
        Task.detached {
            for upload in uploads {
                try? await api.deleteScratchlistAttachment(sessionId: upload.sessionId, attachmentId: upload.path)
            }
        }
    }

    /// Called before the navigation handoff. Ready paths from the source
    /// session cannot be sent or deleted through the replacement session.
    func retarget(to target: String) {
        sessionRevision += 1
        guard target != sessionId else { return }
        sessionId = target
        for index in entries.indices where entries[index].path != nil {
            let entry = entries[index]
            guard let bytes = entry.bytes else { continue }
            if let owned = uploadedPaths.remove(id: entry.ui.id) {
                Self.deleteDetached(api: api, uploads: [owned])
            }
            entries[index].path = nil
            entries[index].ui = entry.ui.with(status: .uploading)
            upload(id: entry.ui.id, filename: entry.ui.filename, mimeType: entry.ui.mimeType, bytes: bytes)
        }
    }

    private func recoverSession(from source: String, revision: Int) async throws -> String {
        // An older in-flight upload can report 409 after a concurrent pick
        // already resumed this very ID. Don't start a second agent process.
        if revision != sessionRevision { return sessionId }
        if let recoveryTask { return try await recoveryTask.value }
        guard let resumeInactiveSession else {
            throw APIError(status: 409, code: "session_inactive")
        }
        let task = Task { try await resumeInactiveSession(source) }
        recoveryTask = task
        defer { recoveryTask = nil }
        return try await task.value
    }

    private func upload(id: String, filename: String, mimeType: String, bytes: Data) {
        // Keep the tray alive until completion so removal/deallocation never
        // leaves a successful in-flight upload without orphan cleanup.
        Task {
            var target = sessionId
            let revision = sessionRevision
            var path: String?
            var errorMessage: String?
            do {
                let response: UploadFileResponse
                do {
                    response = try await api.uploadFile(sessionId: target, filename: filename, data: bytes, mimeType: mimeType)
                } catch let error as APIError where error.status == 409 && error.code == "session_inactive" && resumeInactiveSession != nil {
                    target = try await recoverSession(from: target, revision: revision)
                    // Removal while /resume was in flight must not upload or
                    // resurrect the cancelled chip.
                    guard entries.contains(where: { $0.ui.id == id }) else { return }
                    response = try await api.uploadFile(sessionId: target, filename: filename, data: bytes, mimeType: mimeType)
                }
                path = response.success ? response.path : nil
                if path?.isEmpty == true { path = nil }
                if path == nil { errorMessage = response.error ?? "Invalid upload response" }
            } catch {
                errorMessage = error.localizedDescription
            }

            // Another pick may have rotated the ID while this request was
            // in flight. Re-upload its payload, never publish an old path.
            if target != sessionId {
                if let path { Self.deleteDetached(api: api, uploads: [OwnedUpload(sessionId: target, path: path)]) }
                if entries.contains(where: { $0.ui.id == id }) {
                    upload(id: id, filename: filename, mimeType: mimeType, bytes: bytes)
                }
                return
            }
            let applied = settleUpload(id: id, sessionId: target, path: path, errorMessage: errorMessage)
            if !applied, let path {
                _ = try? await api.deleteUpload(sessionId: target, path: path)
            }
        }
    }

    /// Applies the upload outcome to the chip; false when the chip is gone.
    private func settleUpload(id: String, sessionId: String, path: String?, errorMessage: String?) -> Bool {
        guard let index = entries.firstIndex(where: { $0.ui.id == id }) else {
            return false
        }
        if let path {
            entries[index].ui = entries[index].ui.with(status: .ready)
            entries[index].path = path
            uploadedPaths.set(id: id, path: OwnedUpload(sessionId: sessionId, path: path))
        } else {
            let bytes = entries[index].bytes
            entries[index] = Entry(ui: entries[index].ui.with(status: .failed, errorMessage: errorMessage), path: nil, bytes: bytes)
        }
        return true
    }

    /// `nonisolated`: the class is main-actor-bound, but this must stay
    /// callable from `deinit`.
    private nonisolated static func deleteDetached(
        api: any AttachmentUploading,
        uploads: [OwnedUpload]
    ) {
        guard !uploads.isEmpty else { return }
        Task.detached {
            for upload in uploads {
                _ = try? await api.deleteUpload(sessionId: upload.sessionId, path: upload.path)
            }
        }
    }
}

/// Lock-guarded `id → uploaded path` map living outside the main actor so
/// ``ComposerAttachments/deinit`` can read it. Kept in lockstep with the
/// entries by every main-actor mutation.
private struct OwnedUpload: Sendable {
    let sessionId: String
    let path: String
}

private final class UploadedPathBox<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var paths: [String: Value] = [:]

    func set(id: String, path: Value) {
        lock.lock()
        paths[id] = path
        lock.unlock()
    }

    func forget(id: String) {
        _ = remove(id: id)
    }

    func remove(id: String) -> Value? {
        lock.lock()
        defer { lock.unlock() }
        return paths.removeValue(forKey: id)
    }

    func drain() -> [Value] {
        lock.lock()
        let values = Array(paths.values)
        paths = [:]
        lock.unlock()
        return values
    }
}
