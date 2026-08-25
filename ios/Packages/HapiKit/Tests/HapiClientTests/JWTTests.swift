import Foundation
import HapiClient
import Testing

@Suite("JWT payload decoding")
struct JWTTests {
    @Test func decodesHubShapedPayload() {
        let token = makeJWT(uid: 7, ns: "team", exp: 1_800_000_000)
        let claims = JWT.claims(from: token)
        #expect(claims == JWTClaims(uid: 7, ns: "team", exp: 1_800_000_000))
        #expect(claims?.expiresAt == Date(timeIntervalSince1970: 1_800_000_000))
    }

    @Test func missingExpIsAllowed() {
        let claims = JWT.claims(from: makeJWT(uid: 1, ns: "default"))
        #expect(claims == JWTClaims(uid: 1, ns: "default", exp: nil))
        #expect(claims?.expiresAt == nil)
    }

    /// Payload lengths spanning every base64 padding remainder must all
    /// decode (the middle segment arrives with its `=` padding stripped).
    @Test(arguments: ["a", "ab", "abc", "abcd", "abcde"])
    func decodesAcrossPaddingLengths(ns: String) {
        #expect(JWT.claims(from: makeJWT(ns: ns))?.ns == ns)
    }

    /// `???` encodes to a base64 block containing `/`, `>>>` to one
    /// containing `+` — both must round-trip through the url-safe alphabet.
    @Test(arguments: ["???", ">>>"])
    func decodesURLSafeAlphabet(ns: String) {
        #expect(JWT.claims(from: makeJWT(ns: ns))?.ns == ns)
    }

    @Test(arguments: [
        "",
        "garbage",
        "only.one-real-segment",
        "a.!!!.c",       // invalid base64 characters
        "a.b.c",         // payload length 1 (mod 4) is not valid base64
        "a..c",          // empty payload
    ])
    func garbageYieldsNil(token: String) {
        #expect(JWT.claims(from: token) == nil)
    }

    @Test func nonJSONPayloadYieldsNil() {
        let token = "h.\(base64URLEncode(Data("hello".utf8))).s"
        #expect(JWT.claims(from: token) == nil)
    }

    @Test func payloadWithoutRequiredClaimsYieldsNil() {
        let token = "h.\(base64URLEncode(Data("{\"exp\":123}".utf8))).s"
        #expect(JWT.claims(from: token) == nil)
    }

    /// A hostile out-of-range `exp` must not trap `Int(_:)`.
    @Test func absurdExpIsDropped() {
        let payload = "{\"uid\":1,\"ns\":\"default\",\"exp\":1e300}"
        let token = "h.\(base64URLEncode(Data(payload.utf8))).s"
        #expect(JWT.claims(from: token) == JWTClaims(uid: 1, ns: "default", exp: nil))
    }
}
