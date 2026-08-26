import Foundation
import HapiProtocol

/// The git/files REST surface the files feature consumes — a seam over
/// ``APIClient`` so ``FilesModel``/``FileViewerModel`` tests run against
/// fakes (same pattern as `MessagesProviding`; mirror of the Android
/// `FilesGateway`). All six endpoints are RPC-wrapped: check `success` on the
/// body; transport failures throw.
public protocol FilesRequesting: Sendable {
    func gitStatus(sessionId: String) async throws -> GitCommandResponse
    func gitDiffNumstat(sessionId: String, staged: Bool) async throws -> GitCommandResponse
    func gitDiffFile(sessionId: String, path: String, staged: Bool?) async throws -> GitCommandResponse
    func readSessionFile(sessionId: String, path: String) async throws -> FileReadResponse
    func searchSessionFiles(sessionId: String, query: String, limit: Int) async throws -> FileSearchResponse

    /// `path` is relative to the session root; nil lists the root itself.
    func listSessionDirectory(sessionId: String, path: String?) async throws -> ListDirectoryResponse
}

extension APIClient: FilesRequesting {
    // `gitStatus`, `gitDiffNumstat`, `gitDiffFile`, `readSessionFile` and
    // `listSessionDirectory` from Endpoints/FileEndpoints.swift already
    // satisfy their requirements; the search endpoint's optional `limit`
    // needs this exact-signature shim.
    public func searchSessionFiles(
        sessionId: String,
        query: String,
        limit: Int
    ) async throws -> FileSearchResponse {
        try await searchSessionFiles(sessionId: sessionId, query: query, limit: limit as Int?)
    }
}
