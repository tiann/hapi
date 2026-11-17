import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

/// Shared-RP isolation. Validate the connected Hub before opening any system UI.
enum PasskeyHubBinding {
    struct Challenge: Decodable {
        let v: Int
        let hub: String
        let id: String
        let operation: String
        let channel: String
        let nonce: String
    }

    static func origin(_ url: URL) throws -> String {
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              c.scheme?.lowercased() == "https", let host = c.host, !host.isEmpty,
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/" else { throw PasskeyError.malformedOptions }
        c.scheme = "https"
        c.host = host.lowercased()
        c.path = ""
        if c.port == 443 { c.port = nil }
        guard let value = c.url?.absoluteString else { throw PasskeyError.malformedOptions }
        return value.hasSuffix("/") ? String(value.dropLast()) : value
    }

    static func validate(_ challenge: Data, hub: URL, operation: String) throws {
        guard challenge.count <= 3072,
              let value = try? JSONDecoder().decode(Challenge.self, from: challenge),
              value.v == 1, value.hub == (try origin(hub)), value.operation == operation,
              value.channel == "native", validNonce(value.id), validNonce(value.nonce) else {
            throw PasskeyError.malformedOptions
        }
    }

    private static func validNonce(_ value: String) -> Bool {
        value.utf8.count == 43 && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }

    static func validateUser(_ user: Data, hub: URL) throws {
        guard user.count == 64, user.prefix(32) == (try digest(Data(origin(hub).utf8))) else {
            throw PasskeyError.malformedOptions
        }
    }

    static func digest(_ data: Data) -> Data {
        #if canImport(CryptoKit)
        return Data(SHA256.hash(data: data))
        #else
        // Linux package tests have no CryptoKit. Fail closed rather than silently
        // skip an account-binding check; native passkeys run on Apple platforms.
        return Data()
        #endif
    }
}
