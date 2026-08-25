import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiProtocol

/// Generated images and message-attachment uploads
/// (`docs/api/client-contract/rest.md`).
extension APIClient {
    /// `GET /api/sessions/:id/generated-images/:imageId` — raw bytes.
    ///
    /// The image id is a content fingerprint doubling as the `ETag`, and the
    /// hub sends `Cache-Control: private, max-age=31536000, immutable`, so
    /// the configured `URLCache` (see ``URLSessionHTTPPerformer``) serves
    /// repeats locally and revalidates with `If-None-Match` transparently.
    public func generatedImage(
        sessionId: String,
        imageId: String
    ) async throws -> (data: Data, mimeType: String?) {
        let (data, response) = try await requestBytes(
            "/api/sessions/\(encodePathComponent(sessionId))/generated-images/\(encodePathComponent(imageId))"
        )
        return (data, response.value(forHTTPHeaderField: "Content-Type"))
    }

    /// `POST /api/sessions/:id/upload` — JSON + base64, **not** multipart.
    /// Decoded size limit 50 MB (413 above). Requires an active session.
    /// Pass the returned `path` in the `attachments` metadata of a
    /// subsequent send-message.
    public func uploadFile(
        sessionId: String,
        filename: String,
        data: Data,
        mimeType: String
    ) async throws -> UploadFileResponse {
        try await request(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/upload",
            body: UploadFileRequest(
                filename: filename,
                content: data.base64EncodedString(),
                mimeType: mimeType
            )
        )
    }

    /// `POST /api/sessions/:id/upload/delete` — removes a pending upload.
    public func deleteUpload(sessionId: String, path: String) async throws -> DeleteUploadResponse {
        struct DeleteUploadRequest: Encodable {
            let path: String
        }
        return try await request(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/upload/delete",
            body: DeleteUploadRequest(path: path)
        )
    }
}
