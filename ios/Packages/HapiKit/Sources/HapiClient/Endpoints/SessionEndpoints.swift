import Foundation
import HapiProtocol

/// `order` query of `GET /api/sessions`. The default (absent) order is the
/// hub's ranked one (globalPinned → pinned → active → pending requests →
/// recency); `updatedAt` switches to pure recency.
public enum SessionsListOrder: String, Sendable {
    case updatedAt
}

/// Session list, detail, and lifecycle endpoints
/// (`docs/api/client-contract/rest.md`).
extension APIClient {
    /// `GET /api/sessions`.
    public func listSessions(
        limit: Int? = nil,
        order: SessionsListOrder? = nil
    ) async throws -> [SessionSummary] {
        var query: [URLQueryItem] = []
        if let limit {
            query.append(URLQueryItem(name: "limit", value: String(limit)))
        }
        if let order {
            query.append(URLQueryItem(name: "order", value: order.rawValue))
        }
        let response: SessionsResponse = try await request(.get, "/api/sessions", query: query)
        return response.sessions
    }

    /// `GET /api/sessions/:id`.
    public func session(id: String) async throws -> Session {
        let response: SessionResponse = try await request(
            .get,
            "/api/sessions/\(encodePathComponent(id))"
        )
        return response.session
    }

    /// `POST /api/sessions/:id/resume`. The returned session id **may differ**
    /// from `id` (fresh spawn superseding the old row) — navigate to it and
    /// migrate composer drafts.
    public func resumeSession(id: String, permissionMode: PermissionMode? = nil) async throws -> String {
        struct ResumeSessionRequest: Encodable {
            let permissionMode: PermissionMode
        }
        let path = "/api/sessions/\(encodePathComponent(id))/resume"
        let response: ResumeSessionResponse
        if let permissionMode {
            response = try await request(.post, path, body: ResumeSessionRequest(permissionMode: permissionMode))
        } else {
            response = try await request(.post, path)
        }
        return response.sessionId
    }

    /// `POST /api/sessions/:id/reopen`. As with resume, follow the returned
    /// session id. Incomplete metadata answers `422 {error, missing[]}`.
    public func reopenSession(id: String) async throws -> ReopenSessionResponse {
        try await request(
            .post,
            "/api/sessions/\(encodePathComponent(id))/reopen",
            body: EmptyRequestBody()
        )
    }

    /// `POST /api/sessions/:id/abort` (active sessions only).
    public func abortSession(id: String) async throws {
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(id))/abort",
            body: EmptyRequestBody()
        )
    }

    /// `POST /api/sessions/:id/switch` — hands a terminal-controlled session
    /// over to remote control.
    public func switchSession(id: String) async throws {
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(id))/switch",
            body: EmptyRequestBody()
        )
    }

    /// `POST /api/sessions/:id/archive` (409 for a plain inactive session).
    public func archiveSession(id: String) async throws {
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(id))/archive",
            body: EmptyRequestBody()
        )
    }

    /// `DELETE /api/sessions/:id` (409 while active — archive first).
    public func deleteSession(id: String) async throws {
        try await requestVoid(.delete, "/api/sessions/\(encodePathComponent(id))")
    }

    /// `PATCH /api/sessions/:id` — rename (1–255 chars).
    public func renameSession(id: String, name: String) async throws {
        struct RenameSessionRequest: Encodable {
            let name: String
        }
        try await requestVoid(
            .patch,
            "/api/sessions/\(encodePathComponent(id))",
            body: RenameSessionRequest(name: name)
        )
    }

    /// `PATCH /api/sessions/:id/summary` (1–255 chars).
    public func updateSessionSummary(id: String, text: String) async throws {
        struct UpdateSummaryRequest: Encodable {
            let text: String
        }
        try await requestVoid(
            .patch,
            "/api/sessions/\(encodePathComponent(id))/summary",
            body: UpdateSummaryRequest(text: text)
        )
    }

    /// `PUT /api/sessions/:id/pin`.
    public func setSessionPinMode(id: String, mode: SessionPinMode) async throws {
        struct PinRequest: Encodable {
            let mode: SessionPinMode
        }
        try await requestVoid(
            .put,
            "/api/sessions/\(encodePathComponent(id))/pin",
            body: PinRequest(mode: mode)
        )
    }

    // MARK: - Session catalogs (RPC-wrapped — check `success`)

    /// `GET /api/sessions/:id/slash-commands`.
    public func slashCommands(sessionId: String) async throws -> SlashCommandsResponse {
        try await request(.get, "/api/sessions/\(encodePathComponent(sessionId))/slash-commands")
    }

    /// `GET /api/sessions/:id/skills`.
    public func skills(sessionId: String) async throws -> SkillsResponse {
        try await request(.get, "/api/sessions/\(encodePathComponent(sessionId))/skills")
    }

    /// `GET /api/sessions/:id/codex-models` — the per-session codex model
    /// catalog for the config sheet's model picker (A-M3ab).
    public func sessionCodexModels(sessionId: String) async throws -> CodexModelsResponse {
        try await request(.get, "/api/sessions/\(encodePathComponent(sessionId))/codex-models")
    }
}
