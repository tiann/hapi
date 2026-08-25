import Foundation
#if canImport(Security)
import Security
#endif

/// The per-hub credential record (`docs/api/client-contract/auth.md`).
///
/// The access token is the durable secret; the JWT is a 4-hour cache
/// persisted only to save one `/api/auth` round-trip at cold start.
public struct HubCredentials: Codable, Equatable, Sendable {
    /// Normalized hub origin (see ``HubURLNormalization``); also the storage key.
    public var hubUrl: String
    /// Long-lived pairing secret, passed verbatim to `POST /api/auth`.
    public var accessToken: String
    /// Last issued JWT, if any.
    public var jwt: String?
    /// When `jwt` was obtained, epoch ms.
    public var jwtObtainedAt: Int?

    public init(hubUrl: String, accessToken: String, jwt: String? = nil, jwtObtainedAt: Int? = nil) {
        self.hubUrl = hubUrl
        self.accessToken = accessToken
        self.jwt = jwt
        self.jwtObtainedAt = jwtObtainedAt
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
