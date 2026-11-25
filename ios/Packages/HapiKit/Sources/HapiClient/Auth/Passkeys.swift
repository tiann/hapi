import Foundation

/// Native passkeys (`docs/api/client-contract/auth.md#passkeys-native`).
///
/// The official apps share one relying party, ``nativeRelyingPartyID``,
/// compiled into the Associated Domains entitlement. This file holds the
/// platform-free half: wire models for the WebAuthn options/response JSON,
/// base64url coding, RP validation, and the ``PasskeyAuthenticating`` seam
/// the app implements with AuthenticationServices.
public enum NativePasskeys {
    /// RP ID of every native passkey (`webcredentials:auth.hapi.run`).
    public static let nativeRelyingPartyID = "auth.hapi.run"
    /// Transports reported for a platform (iCloud Keychain) credential.
    public static let registrationTransports = ["internal", "hybrid"]
}

// MARK: - Errors

/// Why a passkey ceremony or exchange did not complete.
public enum PasskeyError: Error, Equatable, Sendable {
    /// The hub asked for a different RP ID than the one this build is
    /// entitled to (`rp.id` / `rpId` != ``NativePasskeys/nativeRelyingPartyID``).
    case relyingPartyMismatch(String)
    /// The options JSON lacked a field or carried invalid base64url.
    case malformedOptions
    /// The platform returned a registration without an attestation object.
    case missingAttestation
    /// The user dismissed the system sheet. Callers treat this as silent.
    case canceled
    /// The platform refused the request (no Associated Domains entitlement,
    /// AASA unreachable, no matching credential, …).
    case platform(String)
}

// MARK: - base64url

/// RFC 4648 §5 base64url without padding, the WebAuthn JSON encoding.
public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Accepts padded or unpadded input; `nil` for invalid characters.
    public static func decode(_ string: String) -> Data? {
        var base64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 = base64.replacingOccurrences(of: "=", with: "")
        let remainder = base64.count % 4
        if remainder == 1 { return nil }
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: base64)
    }
}

// MARK: - Options (hub → app)

/// `{ "client": "native" }` — asks the hub for the fixed native RP.
public struct PasskeyOptionsRequest: Encodable, Equatable, Sendable {
    public let client: String

    public init(client: String = "native") {
        self.client = client
    }
}

/// `PublicKeyCredentialDescriptorJSON` (only `id` is used).
public struct PasskeyCredentialDescriptor: Codable, Equatable, Sendable {
    public var id: String
    public var transports: [String]?

    public init(id: String, transports: [String]? = nil) {
        self.id = id
        self.transports = transports
    }
}

/// `PublicKeyCredentialCreationOptionsJSON` — the fields a platform
/// registration needs.
public struct PasskeyRegistrationOptions: Decodable, Equatable, Sendable {
    public struct RelyingParty: Decodable, Equatable, Sendable {
        public var id: String?
        public var name: String?
    }

    public struct User: Decodable, Equatable, Sendable {
        public var id: String
        public var name: String
        public var displayName: String?
    }

    public var challenge: String
    public var rp: RelyingParty
    public var user: User
    public var excludeCredentials: [PasskeyCredentialDescriptor]?
}

// MARK: - Platform requests (decoded options)

/// Input for a platform registration, already validated and decoded.
public struct PasskeyRegistrationRequest: Equatable, Sendable {
    public let relyingPartyID: String
    public let challenge: Data
    public let userID: Data
    public let userName: String
    public let excludedCredentialIDs: [Data]

    /// Validates `rp.id` against ``NativePasskeys/nativeRelyingPartyID``
    /// and decodes the base64url fields.
    public init(
        options: PasskeyRegistrationOptions,
        hubURL: URL,
        expectedRelyingPartyID: String = NativePasskeys.nativeRelyingPartyID
    ) throws {
        guard let rpId = options.rp.id, rpId == expectedRelyingPartyID else {
            throw PasskeyError.relyingPartyMismatch(options.rp.id ?? "")
        }
        guard let challenge = Base64URL.decode(options.challenge), !challenge.isEmpty,
              let userID = Base64URL.decode(options.user.id), !userID.isEmpty,
              !options.user.name.isEmpty else {
            throw PasskeyError.malformedOptions
        }
        try PasskeyHubBinding.validate(challenge, hub: hubURL, operation: "register")
        try PasskeyHubBinding.validateUser(userID, hub: hubURL)
        let authority = try PasskeyHubBinding.origin(hubURL).dropFirst("https://".count)
        guard options.user.name.hasSuffix("@\(authority)") else { throw PasskeyError.malformedOptions }
        let excluded = try (options.excludeCredentials ?? []).map { descriptor in
            guard let id = Base64URL.decode(descriptor.id) else { throw PasskeyError.malformedOptions }
            return id
        }
        self.relyingPartyID = rpId
        self.challenge = challenge
        self.userID = userID
        self.userName = options.user.name
        self.excludedCredentialIDs = excluded
    }
}

/// Input for a platform sign-in assertion: always the shared RP, user
/// verification required, no allow list (resident credentials only, so the
/// user picks the account and with it the Hub), no extensions. Built only from
/// ``nativeLogin(now:)``, never from Hub-supplied options.
public struct PasskeyAssertionRequest: Equatable, Sendable {
    public let relyingPartyID: String
    /// Raw challenge bytes: the self-issued native login JSON.
    public let challenge: Data

    /// A fresh self-issued native login challenge
    /// (`shared/src/passkey.ts` `createPasskeyNativeLoginChallenge`):
    /// `{"v":2,"operation":"login","channel":"native","iat":<epoch ms>,"nonce":<32 random bytes, base64url>}`.
    /// The Hub accepts it once, within minutes of `iat`.
    public static func nativeLogin(now: Date = Date()) -> Self {
        let nonce = Data((0..<32).map { _ in UInt8.random(in: .min ... .max) })
        let iat = Int64((now.timeIntervalSince1970 * 1000).rounded(.down))
        let challenge = try! JSONSerialization.data(withJSONObject: [
            "v": 2, "operation": "login", "channel": "native", "iat": iat, "nonce": Base64URL.encode(nonce)
        ] as [String: Any], options: [.sortedKeys])
        return Self(relyingPartyID: NativePasskeys.nativeRelyingPartyID, challenge: challenge)
    }

    private init(relyingPartyID: String, challenge: Data) {
        self.relyingPartyID = relyingPartyID
        self.challenge = challenge
    }
}

// MARK: - Platform results (app → hub)

/// Raw bytes of a new platform credential.
public struct PasskeyRegistrationResult: Equatable, Sendable {
    public let credentialID: Data
    public let clientDataJSON: Data
    public let attestationObject: Data

    public init(credentialID: Data, clientDataJSON: Data, attestationObject: Data) {
        self.credentialID = credentialID
        self.clientDataJSON = clientDataJSON
        self.attestationObject = attestationObject
    }
}

/// Raw bytes of a platform assertion.
public struct PasskeyAssertionResult: Equatable, Sendable {
    public let credentialID: Data
    public let clientDataJSON: Data
    public let authenticatorData: Data
    public let signature: Data
    public let userID: Data?
    public let authenticatorAttachment: String

    public init(credentialID: Data, clientDataJSON: Data, authenticatorData: Data, signature: Data, userID: Data?, authenticatorAttachment: String = "platform") {
        self.credentialID = credentialID
        self.clientDataJSON = clientDataJSON
        self.authenticatorData = authenticatorData
        self.signature = signature
        self.userID = userID
        self.authenticatorAttachment = authenticatorAttachment
    }
}

/// `RegistrationResponseJSON` (base64url binary fields).
public struct PasskeyRegistrationResponseJSON: Encodable, Equatable, Sendable {
    public struct Response: Encodable, Equatable, Sendable {
        public let clientDataJSON: String
        public let attestationObject: String
        public let transports: [String]
    }

    public let id: String
    public let rawId: String
    public let type: String
    public let response: Response
    public let authenticatorAttachment: String
    public let clientExtensionResults: [String: String]

    public init(_ result: PasskeyRegistrationResult) {
        let id = Base64URL.encode(result.credentialID)
        self.id = id
        self.rawId = id
        self.type = "public-key"
        self.response = Response(
            clientDataJSON: Base64URL.encode(result.clientDataJSON),
            attestationObject: Base64URL.encode(result.attestationObject),
            transports: NativePasskeys.registrationTransports
        )
        self.authenticatorAttachment = "platform"
        self.clientExtensionResults = [:]
    }
}

/// `AuthenticationResponseJSON` (base64url binary fields).
public struct PasskeyAssertionResponseJSON: Encodable, Equatable, Sendable {
    public struct Response: Encodable, Equatable, Sendable {
        public let clientDataJSON: String
        public let authenticatorData: String
        public let signature: String
        public let userHandle: String?
    }

    public let id: String
    public let rawId: String
    public let type: String
    public let response: Response
    public let authenticatorAttachment: String
    public let clientExtensionResults: [String: String]

    public init(_ result: PasskeyAssertionResult) {
        let id = Base64URL.encode(result.credentialID)
        self.id = id
        self.rawId = id
        self.type = "public-key"
        self.response = Response(
            clientDataJSON: Base64URL.encode(result.clientDataJSON),
            authenticatorData: Base64URL.encode(result.authenticatorData),
            signature: Base64URL.encode(result.signature),
            userHandle: result.userID.flatMap { $0.isEmpty ? nil : Base64URL.encode($0) }
        )
        self.authenticatorAttachment = result.authenticatorAttachment
        self.clientExtensionResults = [:]
    }
}

// MARK: - Hub responses

/// `POST /api/passkey/login/verify` → `{token, user, passkeySession}`.
public struct PasskeyLoginResponse: Decodable, Equatable, Sendable {
    public var token: String
    public var passkeySession: String
}

/// One entry of `GET /api/passkeys`.
public struct PasskeySummary: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String?
    public var rpId: String
    /// Epoch ms.
    public var createdAt: Int
    /// Epoch ms; `nil` until first sign-in.
    public var lastUsedAt: Int?
    /// `false` once `CLI_API_TOKEN` has been rotated since registration.
    public var valid: Bool

    public init(id: String, name: String?, rpId: String, createdAt: Int, lastUsedAt: Int?, valid: Bool) {
        self.id = id
        self.name = name
        self.rpId = rpId
        self.createdAt = createdAt
        self.lastUsedAt = lastUsedAt
        self.valid = valid
    }

    /// Registered for the supported shared Web/App RP ID.
    public var isNative: Bool {
        rpId == NativePasskeys.nativeRelyingPartyID
    }

    public var createdDate: Date {
        Date(timeIntervalSince1970: TimeInterval(createdAt) / 1000)
    }

    public var lastUsedDate: Date? {
        lastUsedAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) }
    }
}

/// `GET /api/passkeys`.
public struct PasskeyListResponse: Decodable, Equatable, Sendable {
    public var passkeys: [PasskeySummary]
}

// MARK: - Platform seam

/// The system passkey sheet. The app implements it with
/// AuthenticationServices; tests script it. Implementations throw
/// ``PasskeyError/canceled`` when the user dismisses the sheet.
public protocol PasskeyAuthenticating: Sendable {
    func register(_ request: PasskeyRegistrationRequest) async throws -> PasskeyRegistrationResult
    func authenticate(_ request: PasskeyAssertionRequest) async throws -> PasskeyAssertionResult
}
