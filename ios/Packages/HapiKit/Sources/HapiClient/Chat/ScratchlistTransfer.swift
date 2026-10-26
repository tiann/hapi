import Foundation
import HapiProtocol

public enum ComposerDestination: Equatable, Sendable {
    case chat
    case scratchlist
}

public enum ScratchlistRestoreChoice: Sendable {
    case append
    case parkCurrent
}

public struct ComposerAttachmentSnapshot: Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        case chatUpload(String)
        case scratchlist(ScratchlistAttachment)
    }
    public let ui: ComposerAttachmentUI
    public let source: Source
}

enum ScratchlistTransferError: Error, LocalizedError {
    case attachment(String)
    case limit
    var errorDescription: String? {
        switch self {
        case .attachment: "Couldn't prepare the attachments — retry or remove the failed files"
        case .limit: "The attachments exceed the scratchlist limits — remove a file or choose a smaller one"
        }
    }
}

/// Storage conversion is explicit. Hub paths never travel in chat messages,
/// and chat paths never travel in scratchlist writes. Failed preparation
/// cleans up only newly created copies; the source always stays intact.
enum ScratchlistTransfer {
    struct Parked {
        var attachments: [ScratchlistAttachment] = []
        var uploaded: [ScratchlistAttachment] = []
    }

    @MainActor
    static func preparePark(api: APIClient, store: any SessionScratchlistStoring, sessionId: String,
                            snapshot: [ComposerAttachmentSnapshot]) async throws -> Parked {
        let limits = await store.limits(sessionId: sessionId)
        guard snapshot.count <= limits.maxAttachmentsPerEntry,
              snapshot.reduce(0, { $0 + $1.ui.sizeBytes }) <= limits.maxBytesPerEntry,
              snapshot.allSatisfy({ limits.allowedMimeTypes.contains($0.ui.mimeType) && $0.ui.sizeBytes <= limits.maxBytesPerFile })
        else { throw ScratchlistTransferError.limit }
        var result = Parked()
        do {
            for item in snapshot {
                switch item.source {
                case .scratchlist(let attachment): result.attachments.append(attachment)
                case .chatUpload(let path):
                    let file = try await api.readSessionFile(sessionId: sessionId, path: path)
                    guard file.success, let content = file.content, let bytes = Data(base64Encoded: content) else {
                        throw ScratchlistTransferError.attachment(item.ui.filename)
                    }
                    switch await store.uploadAttachment(sessionId: sessionId, filename: item.ui.filename, data: bytes, mimeType: item.ui.mimeType) {
                    case .uploaded(let attachment):
                        result.uploaded.append(attachment)
                        result.attachments.append(attachment)
                    case .failed: throw ScratchlistTransferError.attachment(item.ui.filename)
                    }
                }
            }
            return result
        } catch {
            await cleanupPark(store: store, sessionId: sessionId, attachments: result.uploaded)
            throw error
        }
    }

    @MainActor
    static func cleanupPark(store: any SessionScratchlistStoring, sessionId: String, attachments: [ScratchlistAttachment]) async {
        for attachment in attachments {
            _ = await store.deleteAttachment(sessionId: sessionId, attachmentId: attachment.id)
        }
    }

    static func prepareSend(api: APIClient, sourceSessionId: String, targetSessionId: String,
                            snapshot: [ComposerAttachmentSnapshot]) async throws -> [AttachmentMetadata] {
        var result: [AttachmentMetadata] = []
        var createdPaths: [String] = []
        do {
            for item in snapshot {
                let path: String
                switch item.source {
                case .chatUpload(let existing): path = existing
                case .scratchlist(let attachment):
                    let bytes = try await api.scratchlistAttachment(sessionId: sourceSessionId, attachmentId: attachment.id).data
                    let uploaded = try await api.uploadFile(sessionId: targetSessionId, filename: attachment.filename,
                                                           data: bytes, mimeType: attachment.mimeType)
                    guard uploaded.success, let uploadedPath = uploaded.path else {
                        throw ScratchlistTransferError.attachment(attachment.filename)
                    }
                    path = uploadedPath
                    createdPaths.append(path)
                }
                result.append(AttachmentMetadata(id: item.ui.id, filename: item.ui.filename, mimeType: item.ui.mimeType,
                    size: item.ui.sizeBytes, path: path,
                    previewUrl: item.ui.previewBytes.map { AttachmentPolicy.dataUrl(mimeType: "image/jpeg", bytes: $0) }))
            }
            return result
        } catch {
            for path in createdPaths { _ = try? await api.deleteUpload(sessionId: targetSessionId, path: path) }
            throw error
        }
    }

    static func snapshot(_ entry: ScratchlistEntry) -> [ComposerAttachmentSnapshot] {
        entry.attachments.map {
            ComposerAttachmentSnapshot(ui: ComposerAttachmentUI(id: $0.id, filename: $0.filename, mimeType: $0.mimeType,
                sizeBytes: $0.size, previewBytes: nil, status: .ready), source: .scratchlist($0))
        }
    }
}
