import Foundation

/// Decoded payload of a hub JWT.
///
/// The hub signs `{uid, ns}` plus standard `iat`/`exp` (HS256, 4 h expiry —
/// `docs/api/client-contract/auth.md`). Clients treat the token as opaque for
/// auth purposes but may read the payload for proactive refresh scheduling
/// and namespace gating (`ns == "default"` is the hub owner).
public struct JWTClaims: Equatable, Sendable {
    public let uid: Int
    /// Namespace the token operates in (`"default"` = hub owner).
    public let ns: String
    /// Expiry, seconds since the Unix epoch; `nil` when the payload has none.
    public let exp: Int?

    public init(uid: Int, ns: String, exp: Int? = nil) {
        self.uid = uid
        self.ns = ns
        self.exp = exp
    }

    public var expiresAt: Date? {
        exp.map { Date(timeIntervalSince1970: TimeInterval($0)) }
    }
}

/// Payload-only JWT reader. No signature verification — only the hub can
/// verify HS256 tokens, and the client merely schedules around `exp`.
public enum JWT {
    /// Decodes the base64url middle segment of `token` into ``JWTClaims``.
    /// Returns `nil` for anything that is not a well-formed hub JWT payload
    /// (wrong segment count, invalid base64url, non-JSON, missing `uid`/`ns`).
    public static func claims(from token: String) -> JWTClaims? {
        // `components(separatedBy:)` keeps empty segments, so "a..b" cannot
        // shift the payload position the way `split` would.
        let segments = token.components(separatedBy: ".")
        guard segments.count >= 2 else { return nil }
        guard let payload = decodeBase64URLSegment(segments[1]) else { return nil }

        struct RawClaims: Decodable {
            let uid: Int
            let ns: String
            let exp: Double?
        }
        guard let raw = try? JSONDecoder().decode(RawClaims.self, from: payload) else { return nil }
        return JWTClaims(uid: raw.uid, ns: raw.ns, exp: raw.exp.flatMap(safeInt))
    }

    /// base64url → `Data`: translate the URL-safe alphabet and restore the
    /// stripped `=` padding. A length of 1 (mod 4) is not valid base64.
    static func decodeBase64URLSegment(_ segment: String) -> Data? {
        var base64 = segment
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        switch base64.count % 4 {
        case 0:
            break
        case 2:
            base64 += "=="
        case 3:
            base64 += "="
        default:
            return nil
        }
        return Data(base64Encoded: base64)
    }

    /// `Int(_:)` traps on out-of-range doubles; a hostile token must not
    /// crash the app.
    private static func safeInt(_ value: Double) -> Int? {
        guard value.isFinite,
              value >= -9_000_000_000_000_000_000,
              value <= 9_000_000_000_000_000_000 else { return nil }
        return Int(value)
    }
}
