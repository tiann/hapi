#if canImport(CryptoKit)
import CryptoKit
#endif
import Foundation

/// Why a push envelope could not be opened.
public enum PushEnvelopeError: Error, Equatable, Sendable {
    /// Not base64, or shorter than nonce + tag — nothing to decrypt.
    case malformedEnvelope
    /// The key is not exactly ``PushEnvelope/keyLength`` bytes.
    case invalidKeyLength
    /// AES-GCM authentication failed: wrong key, tampered ciphertext, or a
    /// nonce/AAD mismatch. Indistinguishable by design.
    case authenticationFailed
    /// No AES-GCM implementation on this platform (Linux test builds; the
    /// dependency-free rule forbids swift-crypto). Production targets are
    /// all Darwin, where CryptoKit is always available.
    case cryptoUnavailable
}

/// The end-to-end push envelope (`hapi-push-v1`): the hub encrypts the FCM
/// data-contract JSON with the device's per-install `pushKey` so APNs (and
/// any relay in between) only ever sees an opaque blob plus a generic alert.
///
/// Wire format: `base64(nonce || ciphertext || tag)` where the cipher is
/// AES-256-GCM, the nonce is 12 bytes, the tag 16 bytes, and the additional
/// authenticated data is the ASCII string `hapi-push-v1`.
///
/// The hub-side producer implements the same construction; the Notification
/// Service Extension carries a small self-contained copy of ``decrypt`` (see
/// `ios/HapiNotificationService/NotificationService.swift`) because an appex
/// should not link HapiKit.
public enum PushEnvelope {
    /// AAD binding the ciphertext to this envelope version.
    public static let aad = "hapi-push-v1"
    /// AES-256 key size in bytes.
    public static let keyLength = 32
    /// GCM nonce prefix length in bytes.
    public static let nonceLength = 12
    /// GCM authentication tag suffix length in bytes.
    public static let tagLength = 16

    /// Opens `base64(nonce || ciphertext || tag)` with `key`, returning the
    /// plaintext (the FCM data-contract JSON, see ``PushPayload``).
    ///
    /// Structural problems throw ``PushEnvelopeError/malformedEnvelope`` /
    /// ``PushEnvelopeError/invalidKeyLength`` on every platform; the AES-GCM
    /// open itself requires CryptoKit and throws
    /// ``PushEnvelopeError/cryptoUnavailable`` where that is missing.
    public static func decrypt(envelopeBase64: String, key: Data) throws -> Data {
        guard key.count == keyLength else {
            throw PushEnvelopeError.invalidKeyLength
        }
        guard let envelope = Data(base64Encoded: envelopeBase64),
              envelope.count >= nonceLength + tagLength else {
            throw PushEnvelopeError.malformedEnvelope
        }
        #if canImport(CryptoKit)
        // Data slices keep the parent's indices; work with explicit ranges.
        let nonceBytes = envelope.subdata(in: 0..<nonceLength)
        let ciphertext = envelope.subdata(in: nonceLength..<(envelope.count - tagLength))
        let tag = envelope.subdata(in: (envelope.count - tagLength)..<envelope.count)
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: nonceBytes),
                ciphertext: ciphertext,
                tag: tag
            )
            return try AES.GCM.open(
                box,
                using: SymmetricKey(data: key),
                authenticating: Data(aad.utf8)
            )
        } catch {
            throw PushEnvelopeError.authenticationFailed
        }
        #else
        throw PushEnvelopeError.cryptoUnavailable
        #endif
    }
}
