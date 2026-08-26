import Foundation
import HapiProtocol

/// Permission resolution (`docs/api/client-contract/rest.md`). Pending
/// requests are **not messages** — they live in `session.agentState.requests`
/// and move to `completedRequests` once decided. Both endpoints 404 when the
/// request id is no longer pending and 409 `session_inactive` when the
/// session is inactive.
extension APIClient {
    /// `POST /api/sessions/:id/permissions/:requestId/approve`.
    public func approvePermission(
        sessionId: String,
        requestId: String,
        _ body: PermissionApproveRequest = PermissionApproveRequest()
    ) async throws {
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/permissions/\(encodePathComponent(requestId))/approve",
            body: body
        )
    }

    /// `POST /api/sessions/:id/permissions/:requestId/deny`.
    public func denyPermission(
        sessionId: String,
        requestId: String,
        decision: PermissionDecision? = nil
    ) async throws {
        try await requestVoid(
            .post,
            "/api/sessions/\(encodePathComponent(sessionId))/permissions/\(encodePathComponent(requestId))/deny",
            body: PermissionDenyRequest(decision: decision)
        )
    }
}
