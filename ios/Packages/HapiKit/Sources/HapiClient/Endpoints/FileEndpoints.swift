import Foundation
import HapiProtocol

/// Git & files surface (A-M4a): RAW-stdout contract
/// (`docs/api/client-contract/rest.md` "Git & files") — the hub relays git
/// output verbatim inside `GitCommandResponse.stdout`; parsing happens
/// client-side in `HapiProtocol/Git/`. All six are RPC-wrapped: check
/// `success` on the body (HTTP 200 + `{success: false}` is a normal failure,
/// e.g. `Session path not available` before the session has a workspace).
/// Mirrors the Android `HapiApi` git & files section.
extension APIClient {
    /// `GET /api/sessions/:id/git-status` — raw
    /// `git status --porcelain=v2 --branch` stdout.
    public func gitStatus(sessionId: String) async throws -> GitCommandResponse {
        try await request(
            .get,
            "/api/sessions/\(encodePathComponent(sessionId))/git-status"
        )
    }

    /// `GET /api/sessions/:id/git-diff-numstat?staged=` — raw
    /// `git diff --numstat` stdout for one side.
    public func gitDiffNumstat(sessionId: String, staged: Bool) async throws -> GitCommandResponse {
        try await request(
            .get,
            "/api/sessions/\(encodePathComponent(sessionId))/git-diff-numstat",
            query: [URLQueryItem(name: "staged", value: staged ? "true" : "false")]
        )
    }

    /// `GET /api/sessions/:id/git-diff-file?path=&staged=` — raw unified diff
    /// for one file (`staged` omitted = unstaged side).
    public func gitDiffFile(
        sessionId: String,
        path: String,
        staged: Bool? = nil
    ) async throws -> GitCommandResponse {
        var query = [URLQueryItem(name: "path", value: path)]
        if let staged {
            query.append(URLQueryItem(name: "staged", value: staged ? "true" : "false"))
        }
        return try await request(
            .get,
            "/api/sessions/\(encodePathComponent(sessionId))/git-diff-file",
            query: query
        )
    }

    /// `GET /api/sessions/:id/file?path=` — `content` is base64; decode
    /// before display.
    public func readSessionFile(sessionId: String, path: String) async throws -> FileReadResponse {
        try await request(
            .get,
            "/api/sessions/\(encodePathComponent(sessionId))/file",
            query: [URLQueryItem(name: "path", value: path)]
        )
    }

    /// `GET /api/sessions/:id/files?query=&limit=` — ripgrep-backed search
    /// (limit 1–500, hub default 200). An empty query is omitted, like the
    /// Android/web clients.
    public func searchSessionFiles(
        sessionId: String,
        query: String,
        limit: Int? = nil
    ) async throws -> FileSearchResponse {
        var queryItems: [URLQueryItem] = []
        if !query.isEmpty {
            queryItems.append(URLQueryItem(name: "query", value: query))
        }
        if let limit {
            queryItems.append(URLQueryItem(name: "limit", value: String(limit)))
        }
        return try await request(
            .get,
            "/api/sessions/\(encodePathComponent(sessionId))/files",
            query: queryItems
        )
    }

    /// `GET /api/sessions/:id/directory?path=` — omitted/empty path lists the
    /// session root.
    public func listSessionDirectory(
        sessionId: String,
        path: String? = nil
    ) async throws -> ListDirectoryResponse {
        var query: [URLQueryItem] = []
        if let path, !path.isEmpty {
            query.append(URLQueryItem(name: "path", value: path))
        }
        return try await request(
            .get,
            "/api/sessions/\(encodePathComponent(sessionId))/directory",
            query: query
        )
    }
}
