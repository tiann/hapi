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
    /// The Access gateway requested an interactive login.
    case cloudflareAccessRequired
    /// The provided Access token was malformed or used with an HTTP hub.
    case invalidCloudflareAccessToken
    /// `POST /api/auth` answered an unexpected status.
    case hubError(status: Int)
    /// The exchange succeeded but the credentials could not be persisted
    /// (Keychain write failure).
    case storageFailure
    /// Passkey sign-in: the hub rejected the assertion (revoked, unknown,
    /// expired challenge, failed verification).
    case passkeyRejected
    /// Passkey sign-in without a hub URL: the selected passkey does not name
    /// its hub (missing, malformed, or deliberately opaque long-address user
    /// handle). Offer manual entry; nothing was sent anywhere.
    case passkeyHubAddressRequired
    /// Passkey sign-in with a hub URL: the selected passkey belongs to a
    /// different hub. The assertion was not sent anywhere.
    case passkeyWrongHub
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
/// `signInWithPasskey` replaces step 3 with one native passkey ceremony
/// (the hub may come from the credential itself) and persists a passkey
/// session instead of an access token.
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
    public func pair(
        rawHubUrl: String,
        accessToken: String,
        cloudflareAccessToken: String? = nil
    ) async throws -> PairedHub {
        guard let normalized = HubURLNormalization.normalize(rawHubUrl),
              let baseURL = URL(string: normalized) else {
            throw PairingFailure.invalidHubURL
        }
        let token = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            throw PairingFailure.invalidAccessToken
        }

        let cloudflareAccess: CloudflareAccess?
        if let cloudflareAccessToken {
            guard let access = CloudflareAccess(hubURL: baseURL, token: cloudflareAccessToken) else {
                throw PairingFailure.invalidCloudflareAccessToken
            }
            cloudflareAccess = access
        } else {
            cloudflareAccess = nil
        }
        let client = makeUnauthenticatedClient(baseURL: baseURL, cloudflareAccess: cloudflareAccess)
        try await checkHealth(client)

        // Token exchange.
        let auth: AuthResponse
        do {
            auth = try await client.authenticate(accessToken: token)
        } catch CloudflareAccessError.signInRequired {
            throw PairingFailure.cloudflareAccessRequired
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
                jwtObtainedAt: Int(now().timeIntervalSince1970 * 1000),
                cloudflareAccessToken: client.authManager.cloudflareAccess?.token
            )
        )
    }

    /// Signs in with a native passkey in a single system ceremony over a
    /// self-issued challenge (``PasskeyAssertionRequest/nativeLogin(now:)``).
    ///
    /// - Without `rawHubUrl`: ceremony → hub from the credential's user handle
    ///   → `GET /health` → `POST /api/passkey/login/verify`. A handle that does
    ///   not name its hub throws ``PairingFailure/passkeyHubAddressRequired``
    ///   before any request.
    /// - With `rawHubUrl` (manual entry): `GET /health` first (no prompt for
    ///   an unreachable hub) → ceremony → the handle must belong to that hub
    ///   (``PairingFailure/passkeyWrongHub`` otherwise) → verify.
    ///
    /// The returned passkey session is stored as the hub's credential (no
    /// access token). Throws ``PairingFailure``, or ``PasskeyError/canceled``
    /// when the user dismissed the sheet.
    public func signInWithPasskey(
        rawHubUrl: String? = nil,
        authenticator: any PasskeyAuthenticating
    ) async throws -> PairedHub {
        var expectedHub: String?
        if let rawHubUrl {
            guard let normalized = HubURLNormalization.normalize(rawHubUrl),
                  let baseURL = URL(string: normalized),
                  // Passkeys bind HTTPS origins only; no credential can match.
                  (try? PasskeyHubBinding.origin(baseURL)) != nil else {
                throw PairingFailure.invalidHubURL
            }
            try await checkHealth(makeUnauthenticatedClient(baseURL: baseURL))
            expectedHub = normalized
        }

        let assertion: PasskeyAssertionResult
        do {
            assertion = try await authenticator.authenticate(.nativeLogin(now: now()))
        } catch PasskeyError.canceled {
            throw PasskeyError.canceled
        } catch {
            throw PairingFailure.passkeyUnavailable
        }

        let hub: String
        if let expectedHub {
            guard let user = assertion.userID, let url = URL(string: expectedHub),
                  (try? PasskeyHubBinding.validateUser(user, hub: url)) != nil else {
                throw PairingFailure.passkeyWrongHub
            }
            hub = expectedHub
        } else {
            // A locator only: the hub authenticates the assertion itself.
            guard let user = assertion.userID,
                  let located = try? PasskeyHubBinding.userHub(user),
                  let normalized = HubURLNormalization.normalize(located) else {
                throw PairingFailure.passkeyHubAddressRequired
            }
            hub = normalized
        }
        guard let baseURL = URL(string: hub) else { throw PairingFailure.invalidHubURL }
        let client = makeUnauthenticatedClient(baseURL: baseURL)
        if expectedHub == nil {
            try await checkHealth(client)
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
                hubUrl: hub,
                credential: .passkeySession(login.passkeySession),
                jwt: login.token,
                jwtObtainedAt: Int(now().timeIntervalSince1970 * 1000),
                cloudflareAccessToken: client.authManager.cloudflareAccess?.token
            )
        )
    }

    // MARK: - Steps

    /// Pairing calls skip HAPI JWT authentication. The auth manager supplies
    /// the Cloudflare credential when the hub is protected by Access.
    private func makeUnauthenticatedClient(baseURL: URL, cloudflareAccess: CloudflareAccess? = nil) -> APIClient {
        APIClient(
            baseURL: baseURL,
            authManager: AuthManager(
                baseURL: baseURL,
                credentialStore: credentialStore,
                performer: performer,
                cloudflareAccess: cloudflareAccess
            ),
            performer: performer
        )
    }

    /// Reachability + protocol compatibility.
    private func checkHealth(_ client: APIClient) async throws {
        let health: HubHealthResponse
        do {
            health = try await client.health()
        } catch CloudflareAccessError.signInRequired {
            throw PairingFailure.cloudflareAccessRequired
        } catch let error as APIError where error.status == 403 && client.authManager.cloudflareAccess != nil {
            throw PairingFailure.cloudflareAccessRequired
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
