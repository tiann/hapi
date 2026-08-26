import Foundation
import HapiProtocol

/// Scratchlist endpoints (A-M4b, `docs/api/client-contract/rest.md#scratchlist`,
/// `hub/src/web/routes/sessions.ts`). Mutations bump `scratchlistUpdatedAt`
/// in the session's SSE patch — a bare refetch trigger for
/// ``scratchlistEntries(sessionId:)``, never data
/// (see `SessionListStore.onScratchlistInvalidation`).
extension APIClient {
    /// `GET /api/sessions/:id/scratchlist` — all entries, `createdAt DESC`.
    public func scratchlistEntries(sessionId: String) async throws -> ScratchlistEntriesResponse {
        try await request(.get, "/api/sessions/\(encodePathComponent(sessionId))/scratchlist")
    }

    /// `POST /api/sessions/:id/scratchlist` — 201 with the canonical row; 200
    /// with the existing row when `entryId` is already known (idempotent
    /// retry); 409 `scratchlist_at_cap` at 200 entries.
    public func createScratchlistEntry(
        sessionId: String,
        _ body: ScratchlistEntryCreateRequest
    ) async throws -> ScratchlistEntryResponse {
        try await request(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/scratchlist",
            body: body
        )
    }

    /// `PUT /api/sessions/:id/scratchlist/:entryId` — 404 when the entry is gone.
    public func updateScratchlistEntry(
        sessionId: String,
        entryId: String,
        _ body: ScratchlistEntryUpdateRequest
    ) async throws -> ScratchlistEntryResponse {
        try await request(
            .put,
            "/api/sessions/\(encodePathComponent(sessionId))/scratchlist/\(encodePathComponent(entryId))",
            body: body
        )
    }

    /// `DELETE /api/sessions/:id/scratchlist/:entryId` — 404 when already gone.
    public func deleteScratchlistEntry(sessionId: String, entryId: String) async throws {
        try await requestVoid(
            .delete,
            "/api/sessions/\(encodePathComponent(sessionId))/scratchlist/\(encodePathComponent(entryId))"
        )
    }

    /// `GET /api/sessions/:id/scratchlist/limits` — attachment size/count/byte
    /// budgets (``ScratchlistAttachmentLimits``).
    public func scratchlistLimits(sessionId: String) async throws -> ScratchlistLimitsResponse {
        try await request(
            .get,
            "/api/sessions/\(encodePathComponent(sessionId))/scratchlist/limits"
        )
    }

    /// `POST /api/sessions/:id/scratchlist/upload` — JSON + base64 (**not**
    /// multipart), the message-upload body shape. Decoded size over
    /// `limits.maxBytesPerFile` → 413 `scratchlist_attachment_too_large`.
    public func uploadScratchlistAttachment(
        sessionId: String,
        filename: String,
        data: Data,
        mimeType: String
    ) async throws -> ScratchlistUploadResponse {
        try await request(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/scratchlist/upload",
            body: UploadFileRequest(
                filename: filename,
                content: data.base64EncodedString(),
                mimeType: mimeType
            )
        )
    }

    /// `GET /api/sessions/:id/scratchlist/attachments/:attachmentId` — raw
    /// bytes (`Content-Type` from stored metadata). Attachment content is
    /// immutable per id, so any `URLCache` hit is safe — same plumbing as
    /// ``generatedImage(sessionId:imageId:)``.
    public func scratchlistAttachment(
        sessionId: String,
        attachmentId: String
    ) async throws -> (data: Data, mimeType: String?) {
        let (data, response) = try await requestBytes(
            "/api/sessions/\(encodePathComponent(sessionId))/scratchlist/attachments/\(encodePathComponent(attachmentId))"
        )
        return (data, response.value(forHTTPHeaderField: "Content-Type"))
    }

    /// `DELETE /api/sessions/:id/scratchlist/attachments/:attachmentId` — 409
    /// `scratchlist_attachment_in_use` while an entry still references it.
    public func deleteScratchlistAttachment(sessionId: String, attachmentId: String) async throws {
        try await requestVoid(
            .delete,
            "/api/sessions/\(encodePathComponent(sessionId))/scratchlist/attachments/\(encodePathComponent(attachmentId))"
        )
    }
}
