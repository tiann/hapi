import Foundation

/// The per-install end-to-end push key: 32 random bytes, generated **once**
/// per install, registered with every paired hub (`pushKey` on
/// `POST /api/devices/register`, base64) and used by the hub to AES-256-GCM
/// encrypt every push envelope (``PushEnvelope``).
///
/// The app stores it in the Keychain (shared access group, so the
/// Notification Service Extension can decrypt); it is regenerated only when
/// lost — a new key simply re-registers on the next registration pass.
public struct PushDeviceKey: Equatable, Sendable {
    /// AES-256 key size in bytes (= ``PushEnvelope/keyLength``).
    public static let keyLength = 32

    /// The raw 32-byte key.
    public let data: Data

    /// Wraps existing key material; nil unless exactly 32 bytes.
    public init?(data: Data) {
        guard data.count == Self.keyLength else { return nil }
        self.data = data
    }

    /// Decodes a stored/base64 key; nil when not base64 or not 32 bytes.
    public init?(base64: String) {
        guard let decoded = Data(base64Encoded: base64) else { return nil }
        self.init(data: decoded)
    }

    /// The registration wire form (`pushKey` field).
    public var base64: String {
        data.base64EncodedString()
    }

    /// Draws a fresh key from the system CSPRNG
    /// (`SystemRandomNumberGenerator` is cryptographically secure on every
    /// supported platform per its documentation).
    public static func generate() -> PushDeviceKey {
        var generator = SystemRandomNumberGenerator()
        var bytes = [UInt8]()
        bytes.reserveCapacity(keyLength)
        for _ in 0..<(keyLength / 8) {
            withUnsafeBytes(of: generator.next().littleEndian) { bytes.append(contentsOf: $0) }
        }
        guard let key = PushDeviceKey(data: Data(bytes)) else {
            preconditionFailure("generated key has fixed length \(keyLength)")
        }
        return key
    }
}
