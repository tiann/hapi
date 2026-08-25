import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiProtocol

/// Authentication failures surfaced by ``AuthManager``.
public enum AuthError: Error, Equatable, Sendable {
    /// No stored credentials for this hub — never paired, or unpaired.
    case notPaired
    /// Terminal: the hub rejected the stored access token (`POST /api/auth`
    /// answered 401) or refused a freshly issued JWT. Only re-pairing
    /// recovers from this state.
    case reauthenticationRequired
    /// `POST /api/auth` answered an unexpected status. Recoverable — the
    /// next call retries (throttled).
    case refreshFailed(status: Int)
}

/// Owns the JWT for one hub and keeps it valid.
///
/// Contract (`docs/api/client-contract/auth.md`):
/// - JWTs expire after 4 h, so 401s are routine: re-exchange the stored
///   access token via `POST /api/auth {accessToken}` and let the caller
///   retry exactly once.
/// - Refreshes are **single-flight**: concurrent callers share one in-flight
///   exchange instead of racing N of them.
/// - Refresh is proactive when `exp` is within ``proactiveRefreshWindow``,
///   so long-lived work (SSE reconnects) rarely sees a stale token.
/// - A 401 from `/api/auth` itself is terminal (`authFailed`): the access
///   token was rotated or revoked, and the UI must offer re-pairing.
///
/// The HTTP performer and clock are injectable for tests.
public actor AuthManager {
    /// Refresh proactively when the token expires within 10 minutes.
    public static let proactiveRefreshWindow: TimeInterval = 10 * 60
    /// Minimum spacing between *failed* proactive attempts, so a dead hub
    /// does not cause a refresh storm while the current token still works.
    public static let failedRefreshThrottle: TimeInterval = 15

    /// Origin of the hub this manager authenticates against.
    public let baseURL: URL
    /// Normalized origin used as the ``CredentialStoring`` key.
    public let storageKey: String

    private let credentialStore: any CredentialStoring
    private let performer: any HTTPPerforming
    private let now: @Sendable () -> Date

    private var jwt: String?
    private var claims: JWTClaims?
    private var didLoadPersistedJWT = false
    private var refreshTask: Task<String, Error>?
    private var authFailed = false
    private var lastFailedRefreshAt: Date?

    public init(
        baseURL: URL,
        credentialStore: any CredentialStoring,
        performer: any HTTPPerforming = URLSessionHTTPPerformer.shared,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.baseURL = baseURL
        self.storageKey = HubURLNormalization.normalize(baseURL.absoluteString) ?? baseURL.absoluteString
        self.credentialStore = credentialStore
        self.performer = performer
        self.now = now
    }

    /// `true` once the hub has terminally rejected the credentials
    /// ("re-pair needed"). Cleared by ``reset()``.
    public var isAuthenticationFailed: Bool {
        authFailed
    }

    /// Claims of the current JWT (drives `ns == "default"` owner gating).
    public var currentClaims: JWTClaims? {
        claims
    }

    /// Returns a JWT expected to be accepted by the hub: the cached one when
    /// it is comfortably fresh, otherwise the result of a (single-flight)
    /// refresh. A failed *proactive* refresh falls back to the cached token,
    /// which is still temporally valid.
    public func validToken() async throws -> String {
        if authFailed {
            throw AuthError.reauthenticationRequired
        }
        loadPersistedJWTIfNeeded()
        guard let current = jwt else {
            return try await singleFlightRefresh()
        }
        let reference = now()
        if isExpired(at: reference) {
            return try await singleFlightRefresh()
        }
        guard needsProactiveRefresh(at: reference) else {
            return current
        }
        if let lastFailed = lastFailedRefreshAt,
           reference.timeIntervalSince(lastFailed) < Self.failedRefreshThrottle {
            return current
        }
        do {
            return try await singleFlightRefresh()
        } catch AuthError.reauthenticationRequired {
            throw AuthError.reauthenticationRequired
        } catch {
            // Best effort: the current token has not expired yet.
            return current
        }
    }

    /// Called by ``APIClient`` after a request 401'd with `failedToken`.
    /// If another flight already rotated the JWT, returns it without a new
    /// exchange; otherwise refreshes (single-flight).
    public func refreshAfterUnauthorized(failedToken: String?) async throws -> String {
        if authFailed {
            throw AuthError.reauthenticationRequired
        }
        loadPersistedJWTIfNeeded()
        if let current = jwt, current != failedToken {
            return current
        }
        return try await singleFlightRefresh()
    }

    /// Enters the terminal failed state. ``APIClient`` calls this when a
    /// request still 401s right after a successful refresh.
    public func markAuthenticationFailed() {
        authFailed = true
    }

    /// Clears all cached state (including the terminal flag). Call after the
    /// pairing flow stored new credentials for this hub.
    public func reset() {
        authFailed = false
        jwt = nil
        claims = nil
        didLoadPersistedJWT = false
        refreshTask = nil
        lastFailedRefreshAt = nil
    }

    // MARK: - Internals

    private func loadPersistedJWTIfNeeded() {
        guard !didLoadPersistedJWT else { return }
        didLoadPersistedJWT = true
        guard jwt == nil,
              let stored = try? credentialStore.credentials(forHub: storageKey),
              let persisted = stored.jwt,
              !persisted.isEmpty else { return }
        jwt = persisted
        claims = JWT.claims(from: persisted)
    }

    private func isExpired(at reference: Date) -> Bool {
        guard let expiresAt = claims?.expiresAt else { return false }
        return expiresAt <= reference
    }

    private func needsProactiveRefresh(at reference: Date) -> Bool {
        guard let expiresAt = claims?.expiresAt else { return false }
        return expiresAt.timeIntervalSince(reference) < Self.proactiveRefreshWindow
    }

    /// Shares one in-flight exchange among concurrent callers.
    private func singleFlightRefresh() async throws -> String {
        if let inFlight = refreshTask {
            return try await inFlight.value
        }
        let task = Task<String, Error> {
            try await self.performRefresh()
        }
        refreshTask = task
        defer {
            // Only the creator clears the slot, and only if it still holds
            // this flight (a later flight must not be discarded).
            if refreshTask == task {
                refreshTask = nil
            }
        }
        return try await task.value
    }

    private func performRefresh() async throws -> String {
        let stored = try? credentialStore.credentials(forHub: storageKey)
        guard let credentials = stored, !credentials.accessToken.isEmpty else {
            throw AuthError.notPaired
        }
        do {
            let request = try makeAuthRequest(accessToken: credentials.accessToken)
            let (data, response) = try await performer.perform(request)
            switch response.statusCode {
            case 200:
                let auth = try HapiJSON.decoder.decode(AuthResponse.self, from: data)
                adopt(token: auth.token, credentials: credentials)
                return auth.token
            case 401:
                // "Invalid access token" — rotated or revoked. Terminal.
                authFailed = true
                throw AuthError.reauthenticationRequired
            default:
                throw AuthError.refreshFailed(status: response.statusCode)
            }
        } catch {
            if !authFailed {
                lastFailedRefreshAt = now()
            }
            throw error
        }
    }

    private func makeAuthRequest(accessToken: String) throws -> URLRequest {
        struct AuthRequestBody: Encodable {
            let accessToken: String
        }
        let url = try HubRequestURL.make(baseURL: baseURL, path: "/api/auth", query: [])
        var request = URLRequest(url: url)
        request.httpMethod = HTTPMethod.post.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try HapiJSON.encoder.encode(AuthRequestBody(accessToken: accessToken))
        return request
    }

    private func adopt(token: String, credentials: HubCredentials) {
        jwt = token
        claims = JWT.claims(from: token)
        var updated = credentials
        updated.jwt = token
        updated.jwtObtainedAt = Int(now().timeIntervalSince1970 * 1000)
        // Persisting the JWT is an optimization; failure to write it must
        // not fail the refresh.
        try? credentialStore.store(updated)
    }
}
