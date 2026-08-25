import Foundation
import HapiClient
import Testing

/// The normative `hapi-push-v1` test vector (shared with the hub producer;
/// also published as `shared/fixtures/push/envelope-v1.json`). Hardcoded so
/// this suite stands alone: key = bytes 0x00…0x1f, nonce = bytes 0x00…0x0b.
enum PushVector {
    static let key = Data((0..<32).map { UInt8($0) })
    static let plaintext =
        #"{"body":"Ready for input","contractVersion":"1","sessionId":"s1","title":"HAPI","type":"ready"}"#
    static let envelopeBase64 =
        "AAECAwQFBgcICQoLPCC0dKGc4CGvE/Lq1ZBYC+ykp12eCyoIGkvH5nIHdMBgc9qqyrNh8RvKXdeqtgoUzCoF/im/"
        + "zLR28wgjOpDEzNweshOnvUNDJnbiL7/GLMQa/rASE0FpSo+Y/6gB0sShxRvIOvgJGpKK+MjRlFlu"

    /// The vector envelope with the byte at `index` XOR-flipped.
    static func tampered(at index: Int) -> String {
        var bytes = Data(base64Encoded: envelopeBase64)!
        bytes[index] ^= 0x01
        return bytes.base64EncodedString()
    }
}

@Suite("Push envelope (hapi-push-v1)")
struct PushEnvelopeTests {
    // MARK: - Structural validation (runs everywhere)

    @Test func rejectsWrongKeyLength() {
        #expect(throws: PushEnvelopeError.invalidKeyLength) {
            try PushEnvelope.decrypt(
                envelopeBase64: PushVector.envelopeBase64,
                key: Data(count: 16)
            )
        }
    }

    @Test func rejectsNonBase64Envelope() {
        #expect(throws: PushEnvelopeError.malformedEnvelope) {
            try PushEnvelope.decrypt(envelopeBase64: "not-base64!!", key: PushVector.key)
        }
    }

    @Test func rejectsTruncatedEnvelope() {
        // 27 bytes < nonce (12) + tag (16): structurally impossible.
        let short = Data(count: 27).base64EncodedString()
        #expect(throws: PushEnvelopeError.malformedEnvelope) {
            try PushEnvelope.decrypt(envelopeBase64: short, key: PushVector.key)
        }
    }

    // MARK: - AES-GCM (CryptoKit; Darwin-only, skipped in the Linux container)

    #if canImport(CryptoKit)
    @Test func decryptsTheNormativeVector() throws {
        let plaintext = try PushEnvelope.decrypt(
            envelopeBase64: PushVector.envelopeBase64,
            key: PushVector.key
        )
        #expect(String(data: plaintext, encoding: .utf8) == PushVector.plaintext)
    }

    @Test func vectorPlaintextParsesToPayload() throws {
        let plaintext = try PushEnvelope.decrypt(
            envelopeBase64: PushVector.envelopeBase64,
            key: PushVector.key
        )
        let payload = try #require(PushPayload.parse(plaintext: plaintext))
        #expect(payload.type == .ready)
        #expect(payload.sessionId == "s1")
        #expect(payload.title == "HAPI")
        #expect(payload.body == "Ready for input")
        #expect(payload.contractVersion == "1")
        #expect(payload.isKnownContractVersion)
        #expect(payload.supportsActions)
        #expect(payload.categoryIdentifier == "ready")
    }

    @Test func rejectsTamperedCiphertext() {
        // Byte 20 sits inside the ciphertext region (after the 12-byte nonce).
        #expect(throws: PushEnvelopeError.authenticationFailed) {
            try PushEnvelope.decrypt(
                envelopeBase64: PushVector.tampered(at: 20),
                key: PushVector.key
            )
        }
    }

    @Test func rejectsTamperedTag() {
        let last = Data(base64Encoded: PushVector.envelopeBase64)!.count - 1
        #expect(throws: PushEnvelopeError.authenticationFailed) {
            try PushEnvelope.decrypt(
                envelopeBase64: PushVector.tampered(at: last),
                key: PushVector.key
            )
        }
    }

    @Test func rejectsTamperedNonce() {
        #expect(throws: PushEnvelopeError.authenticationFailed) {
            try PushEnvelope.decrypt(
                envelopeBase64: PushVector.tampered(at: 0),
                key: PushVector.key
            )
        }
    }

    @Test func rejectsWrongKey() {
        var wrong = PushVector.key
        wrong[0] ^= 0xFF
        #expect(throws: PushEnvelopeError.authenticationFailed) {
            try PushEnvelope.decrypt(envelopeBase64: PushVector.envelopeBase64, key: wrong)
        }
    }
    #else
    @Test func decryptReportsCryptoUnavailable() {
        // Linux container: structure is validated, the AES-GCM open is not
        // implemented (no CryptoKit, and no new dependencies allowed).
        #expect(throws: PushEnvelopeError.cryptoUnavailable) {
            try PushEnvelope.decrypt(
                envelopeBase64: PushVector.envelopeBase64,
                key: PushVector.key
            )
        }
    }
    #endif
}

@Suite("Push device key")
struct PushDeviceKeyTests {
    @Test func generatesDistinct32ByteKeys() {
        let first = PushDeviceKey.generate()
        let second = PushDeviceKey.generate()
        #expect(first.data.count == 32)
        #expect(second.data.count == 32)
        #expect(first != second)
    }

    @Test func base64RoundTrips() throws {
        let key = PushDeviceKey.generate()
        let restored = try #require(PushDeviceKey(base64: key.base64))
        #expect(restored == key)
        #expect(restored.base64 == key.base64)
    }

    @Test func rejectsWrongLengthOrGarbage() {
        #expect(PushDeviceKey(data: Data(count: 31)) == nil)
        #expect(PushDeviceKey(data: Data(count: 33)) == nil)
        #expect(PushDeviceKey(base64: Data(count: 16).base64EncodedString()) == nil)
        #expect(PushDeviceKey(base64: "***") == nil)
    }
}
