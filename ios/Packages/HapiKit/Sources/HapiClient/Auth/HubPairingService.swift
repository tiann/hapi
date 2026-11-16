import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiProtocol

/// Why a pairing attempt failed, shaped for direct UI presentation
/// (the pairing screen's error states).
public enum PairingFailure: Error, Equatable, Sendable {
    /// The typed/scanned hub URL is not an absolute http(s) URL.
    case invalidHubURL
    /// The hub could not be reached, or whatever answered `GET /health` was
    /// not a healthy HAPI hub (non-2xx, undecodable body, `status != "ok"`).
    case unreachable
    /// The hub speaks a different protocol generation than this build.
    case protocolMismatch(hubVersion: Int, supportedVersion: Int)
    /// `POST /api/auth` answered 401 — the access token is wrong or rotated.
    case invalidAccessToken
    /// `POST /api/auth` answered an unexpected status.
    case hubError(status: Int)
    /// The exchange succeeded but the credentials could not be persisted
    /// (Keychain write failure).
    case storageFailure
    /// Passkey sign-in: the hub has no valid native passkeys
    /// (`404 no_passkeys`) — pair with the access token and add one first.
    case noPasskeys
    /// Passkey sign-in: the hub rejected the assertion (revoked, unknown,
    /// expired challenge) or asked for a foreign RP ID.
    case passkeyRejected
    /// Passkey sign-in: the system could not run the ceremony (missing
    /// Associated Domains entitlement, AASA unreachable, …).
    case passkeyUnavailable
}

/// Result of a successful pairing.
public struct PairedHub: Equatable, Sendable {
    /// Normalized hub origin — the key everything else uses.
    public let hubUrl: String
    /// Claims of the freshly issued JWT (`ns == "default"` gates owner-only
    /// surfaces). `nil` only if the hub issued an unparseable token.
    public let claims: JWTClaims?

    public init(hubUrl: String, claims: JWTClaims?) {
        self.hubUrl = hubUrl
        self.claims = claims
    }
}

/// The pairing/unpairing sequence, kept UI-free so it is testable through the
/// ``HTTPPerforming`` seam (see `PairingLogicTests`).
///
/// `pair` follows `docs/api/client-contract/auth.md`:
/// 1. normalize the hub URL (`HubURLNormalization`),
/// 2. `GET /health` — reachability plus `protocolVersion` compatibility,
/// 3. `POST /api/auth {accessToken}` — the token is opaque, passed verbatim,
/// 4. persist ``HubCredentials`` (access token + first JWT) in the credential
///    store, register the hub, and make it active.
///
/// `signInWithPasskey` replaces step 3 with the native passkey ceremony and
/// persists a passkey session instead of an access token.
///
/// `unpair` deletes the credentials, drops the hub from the registry, and
/// reports which hub (if any) is active afterwards. The app layer owns
/// everything session-shaped (building/tearing down `HubSession`).
public struct HubPairingService: Sendable {
    private let registry: HubRegistry
    private let credentialStore: any CredentialStoring
    private let performer: any HTTPPerforming
    private let now: @Sendable () -> Date

    public init(
        registry: HubRegistry,
        credentialStore: any CredentialStoring,
        performer: any HTTPPerforming = URLSessionHTTPPerformer.shared,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.registry = registry
        self.credentialStore = credentialStore
        self.performer = performer
        self.now = now
    }

    /// Pairs with the hub at `rawHubUrl` using `accessToken`. On success the
    /// hub is registered, active, and its credentials are persisted (an
    /// existing record for the same hub is replaced — re-pairing refreshes a
    /// rotated token). Throws ``PairingFailure``.
    public func pair(rawHubUrl: String, accessToken: String) async throws -> PairedHub {
        guard let normalized = HubURLNormalization.normalize(rawHubUrl),
              let baseURL = URL(string: normalized) else {
            throw PairingFailure.invalidHubURL
        }
        let token = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            throw PairingFailure.invalidAccessToken
        }

        let client = makeUnauthenticatedClient(baseURL: baseURL)
        try await checkHealth(client)

        // Token exchange.
        let auth: AuthResponse
        do {
            auth = try await client.authenticate(accessToken: token)
        } catch let error as APIError {
            throw error.status == 401
                ? PairingFailure.invalidAccessToken
                : PairingFailure.hubError(status: error.status)
        } catch {
            throw PairingFailure.unreachable
        }

        return try persist(
            HubCredentials(
                hubUrl: normalized,
                credential: .accessToken(token),
                jwt: auth.token,
                jwtObtainedAt: Int(now().timeIntervalSince1970 * 1000)
            )
        )
    }

    /// Signs in to the hub at `rawHubUrl` with a native passkey — only the
    /// hub URL is needed. Same health check as ``pair(rawHubUrl:accessToken:)``,
    /// then login options (`{client: "native"}`) → RP check → system sheet →
    /// verify; the returned passkey session is stored as the hub's
    /// credential (no access token). Throws ``PairingFailure``, or
    /// ``PasskeyError/canceled`` when the user dismissed the sheet.
    public func signInWithPasskey(
        rawHubUrl: String,
        authenticator: any PasskeyAuthenticating
    ) async throws -> PairedHub {
        guard let normalized = HubURLNormalization.normalize(rawHubUrl),
              let baseURL = URL(string: normalized) else {
            throw PairingFailure.invalidHubURL
        }
        let client = makeUnauthenticatedClient(baseURL: baseURL)
        try await checkHealth(client)

        let request: PasskeyAssertionRequest
        do {
            request = try PasskeyAssertionRequest(options: try await client.passkeyLoginOptions())
        } catch PasskeyError.noPasskeys {
            throw PairingFailure.noPasskeys
        } catch is PasskeyError {
            throw PairingFailure.passkeyRejected
        } catch let error as APIError {
            throw PairingFailure.hubError(status: error.status)
        } catch {
            throw PairingFailure.unreachable
        }

        let assertion: PasskeyAssertionResult
        do {
            assertion = try await authenticator.authenticate(request)
        } catch PasskeyError.canceled {
            throw PasskeyError.canceled
        } catch {
            throw PairingFailure.passkeyUnavailable
        }

        let login: PasskeyLoginResponse
        do {
            login = try await client.verifyPasskeyLogin(PasskeyAssertionResponseJSON(assertion))
        } catch let error as APIError {
            // 401 = revoked / unknown / expired challenge; 400 = bad body.
            throw (error.status == 401 || error.status == 400)
                ? PairingFailure.passkeyRejected
                : PairingFailure.hubError(status: error.status)
        } catch {
            throw PairingFailure.unreachable
        }

        return try persist(
            HubCredentials(
                hubUrl: normalized,
                credential: .passkeySession(login.passkeySession),
                jwt: login.token,
                jwtObtainedAt: Int(now().timeIntervalSince1970 * 1000)
            )
        )
    }

    // MARK: - Steps

    /// Throwaway client: pairing calls are unauthenticated, so the auth
    /// manager is wiring-only and never consulted.
    private func makeUnauthenticatedClient(baseURL: URL) -> APIClient {
        APIClient(
            baseURL: baseURL,
            authManager: AuthManager(baseURL: baseURL, credentialStore: credentialStore, performer: performer),
            performer: performer
        )
    }

    /// Reachability + protocol compatibility.
    private func checkHealth(_ client: APIClient) async throws {
        let health: HubHealthResponse
        do {
            health = try await client.health()
        } catch {
            // Non-2xx, transport failure, or a 200 that does not decode as a
            // hub health body — nothing at this address we can pair with.
            throw PairingFailure.unreachable
        }
        guard health.status == "ok" else {
            throw PairingFailure.unreachable
        }
        // The protocol generation is a single integer (shared/src/version.ts);
        // this build understands exactly one.
        guard health.protocolVersion == ProtocolVersion.supported else {
            throw PairingFailure.protocolMismatch(
                hubVersion: health.protocolVersion,
                supportedVersion: ProtocolVersion.supported
            )
        }
    }

    /// Persists the record — credentials first: a hub registered without
    /// credentials would restore as paired-but-dead — then registers the hub
    /// and makes it active.
    private func persist(_ credentials: HubCredentials) throws -> PairedHub {
        do {
            try credentialStore.store(credentials)
        } catch {
            throw PairingFailure.storageFailure
        }
        registry.register(credentials.hubUrl)
        registry.setActiveHub(credentials.hubUrl)
        return PairedHub(hubUrl: credentials.hubUrl, claims: credentials.jwt.flatMap(JWT.claims(from:)))
    }

    /// Removes a hub: credentials deleted, registry entry dropped, active
    /// selection falls back per ``HubRegistry`` rules. Returns the hub that is
    /// active afterwards, or `nil` when none remain (back to unpaired).
    ///
    /// TODO(M4a-push): once device push registration exists, unregister the
    /// device here first, while a valid JWT is still obtainable.
    @discardableResult
    public func unpair(hubUrl: String) -> String? {
        let normalized = HubURLNormalization.normalize(hubUrl) ?? hubUrl
        try? credentialStore.deleteCredentials(forHub: normalized)
        registry.remove(normalized)
        return registry.activeHub
    }
}
