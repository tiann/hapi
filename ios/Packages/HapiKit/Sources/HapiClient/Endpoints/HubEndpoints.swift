import Foundation
import HapiProtocol

/// Hub-level endpoints: health, auth exchange, visibility.
///
/// Pattern for feature packages adding endpoints later (git/files,
/// scratchlist, voice, usage): one `extension APIClient` per feature,
/// paths composed with `encodePathComponent`, bodies as HapiProtocol
/// request models (or private single-field structs), calls through
/// `request`/`requestVoid`/`requestBytes`.
extension APIClient {
    /// `GET /health` (unauthenticated). Capability flags are additive.
    public func health() async throws -> HubHealthResponse {
        try await request(.get, "/health", authenticated: false)
    }

    /// `POST /api/auth` (unauthenticated) — exchanges a pairing access token
    /// for a JWT. The pairing flow persists the credentials afterwards;
    /// routine refreshes go through ``AuthManager`` instead.
    public func authenticate(accessToken: String) async throws -> AuthResponse {
        struct AuthRequestBody: Encodable {
            let accessToken: String
        }
        return try await request(
            .post,
            "/api/auth",
            body: AuthRequestBody(accessToken: accessToken),
            authenticated: false
        )
    }

    /// `POST /api/visibility` — reports foreground/background transitions so
    /// the hub can suppress redundant pushes while the app is visible.
    /// `subscriptionId` comes from the SSE `connection-changed` handshake;
    /// a stale one answers 404.
    public func setVisibility(subscriptionId: String, visibility: VisibilityState) async throws {
        try await requestVoid(
            .post,
            "/api/visibility",
            body: VisibilityRequest(subscriptionId: subscriptionId, visibility: visibility)
        )
    }
}

/// Empty JSON object body (`{}`) for endpoints whose contract expects one.
struct EmptyRequestBody: Encodable {
}
