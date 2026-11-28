import Foundation
#if canImport(Security)
import Security
#endif

/// The durable secret a paired hub is authenticated with, exchanged for a JWT
/// via `POST /api/auth` (`docs/api/client-contract/auth.md`).
public enum HubAuthCredential: Equatable, Sendable {
    /// Pairing secret (`CLI_API_TOKEN[:namespace]`), sent as `{accessToken}`.
    case accessToken(String)
    /// Refresh credential from `POST /api/passkey/login/verify`, sent as
    /// `{passkeySession}`.
    case passkeySession(String)

    /// Body of the `POST /api/auth` exchange for this credential.
    public var exchangeBody: [String: String] {
        switch self {
        case .accessToken(let token): ["accessToken": token]
        case .passkeySession(let session): ["passkeySession": session]
        }
    }

    var isEmpty: Bool {
        switch self {
        case .accessToken(let value), .passkeySession(let value): value.isEmpty
        }
    }
}

/// The per-hub credential record (`docs/api/client-contract/auth.md`).
///
/// The credential (access token or passkey session) is the durable secret;
/// the JWT is a 4-hour cache persisted only to save one `/api/auth`
/// round-trip at cold start. Exactly one credential kind is stored, encoded
/// as an `accessToken` or `passkeySession` field.
public struct HubCredentials: Codable, Equatable, Sendable {
    /// Normalized hub origin (see ``HubURLNormalization``); also the storage key.
    public var hubUrl: String
    /// Secret exchanged by the silent re-auth loop.
    public var credential: HubAuthCredential
    /// Optional proxy credential for this hub's HTTPS origin.
    public var cloudflareAccessToken: String?
    /// Last issued JWT, if any.
    public var jwt: String?
    /// When `jwt` was obtained, epoch ms.
    public var jwtObtainedAt: Int?

    public init(
        hubUrl: String,
        credential: HubAuthCredential,
        jwt: String? = nil,
        jwtObtainedAt: Int? = nil,
        cloudflareAccessToken: String? = nil
    ) {
        self.hubUrl = hubUrl
        self.credential = credential
        self.cloudflareAccessToken = cloudflareAccessToken
        self.jwt = jwt
        self.jwtObtainedAt = jwtObtainedAt
    }

    /// Access-token record (QR / manual / deep-link pairing).
    public init(hubUrl: String, accessToken: String, jwt: String? = nil, jwtObtainedAt: Int? = nil) {
        self.init(hubUrl: hubUrl, credential: .accessToken(accessToken), jwt: jwt, jwtObtainedAt: jwtObtainedAt)
    }

    /// Long-lived pairing secret, when the hub was paired by access token.
    public var accessToken: String? {
        if case .accessToken(let token) = credential { return token }
        return nil
    }

    /// Passkey refresh credential, when the hub was signed in by passkey.
    public var passkeySession: String? {
        if case .passkeySession(let session) = credential { return session }
        return nil
    }

    private enum CodingKeys: String, CodingKey {
        case hubUrl, accessToken, passkeySession, jwt, jwtObtainedAt, cloudflareAccessToken
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hubUrl = try container.decode(String.self, forKey: .hubUrl)
        if let token = try container.decodeIfPresent(String.self, forKey: .accessToken) {
            credential = .accessToken(token)
        } else if let session = try container.decodeIfPresent(String.self, forKey: .passkeySession) {
            credential = .passkeySession(session)
        } else {
            throw DecodingError.keyNotFound(CodingKeys.accessToken, DecodingError.Context(
                codingPath: container.codingPath,
                debugDescription: "Credential record has neither accessToken nor passkeySession"
            ))
        }
        jwt = try container.decodeIfPresent(String.self, forKey: .jwt)
        jwtObtainedAt = try container.decodeIfPresent(Int.self, forKey: .jwtObtainedAt)
        cloudflareAccessToken = try container.decodeIfPresent(String.self, forKey: .cloudflareAccessToken)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(hubUrl, forKey: .hubUrl)
        switch credential {
        case .accessToken(let token): try container.encode(token, forKey: .accessToken)
        case .passkeySession(let session): try container.encode(session, forKey: .passkeySession)
        }
        try container.encodeIfPresent(jwt, forKey: .jwt)
        try container.encodeIfPresent(jwtObtainedAt, forKey: .jwtObtainedAt)
        try container.encodeIfPresent(cloudflareAccessToken, forKey: .cloudflareAccessToken)
    }
}

/// Storage seam so `AuthManager` and the pairing flow are testable without
/// touching the real Keychain.
public protocol CredentialStoring: Sendable {
    /// Returns the record for a normalized hub origin, or `nil` when unpaired.
    func credentials(forHub hubUrl: String) throws -> HubCredentials?
    /// Inserts or replaces the record keyed by `credentials.hubUrl`.
    func store(_ credentials: HubCredentials) throws
    /// Removes the record; deleting a non-existent record is not an error.
    func deleteCredentials(forHub hubUrl: String) throws
}

// The Keychain-backed implementation is Darwin-only (Security framework).
// On Linux the `CredentialStoring` seam keeps everything testable via
// `InMemoryCredentialStore`; there is no production credential store there.
#if canImport(Security)
/// A Keychain operation failed with the given `SecItem` status.
public struct KeychainError: Error, Equatable, Sendable {
    public let status: OSStatus

    public init(status: OSStatus) {
        self.status = status
    }
}

/// Keychain-backed credential store: one generic-password item per hub under
/// service `run.hapi.companion`, account = normalized hub origin, value =
/// JSON-encoded ``HubCredentials``.
///
/// Items use `kSecAttrAccessibleAfterFirstUnlock` so a background refresh
/// after reboot (pre-unlock) fails gracefully instead of silently losing
/// credentials, and the data-protection keychain so behavior matches across
/// iOS and macOS (CI).
public struct KeychainCredentialStore: CredentialStoring {
    public static let service = "run.hapi.companion"

    public init() {}

    public func credentials(forHub hubUrl: String) throws -> HubCredentials? {
        var query = Self.baseQuery(account: hubUrl)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else {
                throw KeychainError(status: errSecInternalError)
            }
            return try JSONDecoder().decode(HubCredentials.self, from: data)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError(status: status)
        }
    }

    public func store(_ credentials: HubCredentials) throws {
        let data = try JSONEncoder().encode(credentials)
        let query = Self.baseQuery(account: credentials.hubUrl)
        let update: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainError(status: updateStatus)
        }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError(status: addStatus)
        }
    }

    public func deleteCredentials(forHub hubUrl: String) throws {
        let status = SecItemDelete(Self.baseQuery(account: hubUrl) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }

    private static func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }
}
#endif

/// Dictionary-backed test double (also handy for previews).
public final class InMemoryCredentialStore: CredentialStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var records: [String: HubCredentials] = [:]

    public init() {}

    public func credentials(forHub hubUrl: String) throws -> HubCredentials? {
        lock.lock()
        defer { lock.unlock() }
        return records[hubUrl]
    }

    public func store(_ credentials: HubCredentials) throws {
        lock.lock()
        defer { lock.unlock() }
        records[credentials.hubUrl] = credentials
    }

    public func deleteCredentials(forHub hubUrl: String) throws {
        lock.lock()
        defer { lock.unlock() }
        records[hubUrl] = nil
    }
}
