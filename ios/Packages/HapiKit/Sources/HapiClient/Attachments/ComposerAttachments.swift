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

    public init(
        id: String,
        filename: String,
        mimeType: String,
        sizeBytes: Int,
        previewBytes: Data?,
        status: ComposerAttachmentStatus
    ) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.previewBytes = previewBytes
        self.status = status
    }

    func with(status: ComposerAttachmentStatus) -> ComposerAttachmentUI {
        ComposerAttachmentUI(
            id: id,
            filename: filename,
            mimeType: mimeType,
            sizeBytes: sizeBytes,
            previewBytes: previewBytes,
            status: status
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
}

extension APIClient: AttachmentUploading {}

/// Composer attachment tray (A-M3f): upload-on-pick state machine feeding
/// `SendMessageRequest.attachments` — the iOS port of the Android
/// `ComposerAttachments` (B-M3f), which itself mirrors the web
/// `attachmentAdapter.ts` flow with mobile adjustments:
///
/// - ``add(_:)`` uploads immediately (`POST upload`, JSON + base64) and
///   tracks the chip through ``ComposerAttachmentStatus``; failures keep the
///   payload bytes for ``retry(_:)``, successes drop them (only the small
///   preview stays resident).
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
/// - **Inactive sessions (v1 simplification)**: the hub's upload route
///   requires an active session, and unlike the web this tray does not
///   resume-then-upload — a pick on an inactive session settles Failed;
///   sending any text auto-resumes (A-M3ab), after which the chip's retry
///   succeeds. Uploaded paths are absolute on the agent machine, so they
///   stay readable across a resume (even one that supersedes the id).
@MainActor @Observable
public final class ComposerAttachments {
    private struct Entry {
        var ui: ComposerAttachmentUI
        /// Hub upload path once Ready.
        var path: String?
        /// Upload payload, retained only until the upload succeeds (retry source).
        var bytes: Data?
    }

    private var entries: [Entry] = []

    private let api: any AttachmentUploading
    private let sessionId: String
    /// Nonisolated shadow of the Ready chips' hub paths, so `deinit` (which
    /// cannot touch main-actor state) can schedule the orphan cleanup.
    private let uploadedPaths = UploadedPathBox()

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
        guard !paths.isEmpty else { return }
        Self.deleteDetached(api: api, sessionId: sessionId, paths: paths)
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

    // MARK: - Mutations

    /// Add a prepared pick to the tray and start its upload.
    public func add(_ prepared: PreparedAttachment) {
        let ui = ComposerAttachmentUI(
            id: prepared.id,
            filename: prepared.filename,
            mimeType: prepared.mimeType,
            sizeBytes: prepared.sizeBytes,
            previewBytes: prepared.previewBytes,
            status: .uploading
        )
        entries.append(Entry(ui: ui, path: nil, bytes: prepared.bytes))
        upload(id: prepared.id, filename: prepared.filename, mimeType: prepared.mimeType, bytes: prepared.bytes)
    }

    /// Failed chip tap: re-fire the upload with the retained bytes.
    public func retry(_ id: String) {
        guard let index = entries.firstIndex(where: { $0.ui.id == id }),
              entries[index].ui.status == .failed,
              let bytes = entries[index].bytes else {
            return
        }
        let ui = entries[index].ui
        entries[index] = Entry(ui: ui.with(status: .uploading), path: nil, bytes: bytes)
        upload(id: id, filename: ui.filename, mimeType: ui.mimeType, bytes: bytes)
    }

    /// Drop a chip. An already-uploaded file is deleted best-effort; an
    /// in-flight upload deletes its result on completion (see `upload`).
    public func remove(_ id: String) {
        guard let index = entries.firstIndex(where: { $0.ui.id == id }) else { return }
        let removed = entries.remove(at: index)
        uploadedPaths.forget(id: id)
        guard let path = removed.path else { return }
        let api = api
        let sessionId = sessionId
        Task {
            _ = try? await api.deleteUpload(sessionId: sessionId, path: path)
        }
    }

    /// Take every Ready chip as send metadata, clearing them from the tray
    /// (unsettled chips stay put — the interactor guards against calling with
    /// any pending, but a race can settle one to Failed in between).
    ///
    /// - Returns: the metadata list, or nil when nothing was ready.
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
        guard !paths.isEmpty else { return }
        Self.deleteDetached(api: api, sessionId: sessionId, paths: paths)
    }

    // MARK: - Internals

    private func upload(id: String, filename: String, mimeType: String, bytes: Data) {
        // Strong self on purpose: the upload finishes (and settles or deletes
        // its orphan) even while the screen is being dismantled — Android's
        // scope.launch keeps its ViewModel alive the same way.
        Task {
            // `APIClient.uploadFile` is a nonisolated async function, so the
            // base64 encode of up to 50 MB inside it runs off the main actor
            // (SE-0338 executor hopping).
            var path: String?
            do {
                let response = try await api.uploadFile(
                    sessionId: sessionId,
                    filename: filename,
                    data: bytes,
                    mimeType: mimeType
                )
                path = response.success ? response.path : nil
            } catch {
                path = nil
            }

            let applied = settleUpload(id: id, path: path)
            // Removed while uploading: the hub file just became an orphan.
            if !applied, let path {
                _ = try? await api.deleteUpload(sessionId: sessionId, path: path)
            }
        }
    }

    /// Applies the upload outcome to the chip; false when the chip is gone.
    private func settleUpload(id: String, path: String?) -> Bool {
        guard let index = entries.firstIndex(where: { $0.ui.id == id }) else {
            return false
        }
        if let path {
            // Success: drop the payload bytes — only the preview stays.
            entries[index] = Entry(ui: entries[index].ui.with(status: .ready), path: path, bytes: nil)
            uploadedPaths.set(id: id, path: path)
        } else {
            let bytes = entries[index].bytes
            entries[index] = Entry(ui: entries[index].ui.with(status: .failed), path: nil, bytes: bytes)
        }
        return true
    }

    /// `nonisolated`: the class is main-actor-bound, but this must stay
    /// callable from `deinit`.
    private nonisolated static func deleteDetached(
        api: any AttachmentUploading,
        sessionId: String,
        paths: [String]
    ) {
        Task.detached {
            for path in paths {
                _ = try? await api.deleteUpload(sessionId: sessionId, path: path)
            }
        }
    }
}

/// Lock-guarded `id → uploaded path` map living outside the main actor so
/// ``ComposerAttachments/deinit`` can read it. Kept in lockstep with the
/// entries by every main-actor mutation.
private final class UploadedPathBox: @unchecked Sendable {
    private let lock = NSLock()
    private var paths: [String: String] = [:]

    func set(id: String, path: String) {
        lock.lock()
        paths[id] = path
        lock.unlock()
    }

    func forget(id: String) {
        lock.lock()
        paths.removeValue(forKey: id)
        lock.unlock()
    }

    func drain() -> [String] {
        lock.lock()
        let values = Array(paths.values)
        paths = [:]
        lock.unlock()
        return values
    }
}
