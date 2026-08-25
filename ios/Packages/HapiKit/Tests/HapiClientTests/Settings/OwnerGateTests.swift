import Foundation
import HapiClient
import Testing

/// The `ns == "default"` owner gate for the usage/storage settings entries —
/// web twin `getNamespaceFromToken(token) === 'default'`, Android twin
/// `isOwnerNamespace`. Everything unreadable fails closed.
@Suite("OwnerGate")
struct OwnerGateTests {

    @Test func defaultNamespaceIsOwner() {
        #expect(OwnerGate.isOwnerNamespace(jwt: makeJWT(ns: "default")))
    }

    @Test(arguments: ["team", "alice", "Default", "default ", ""])
    func otherNamespacesAreNot(ns: String) {
        #expect(!OwnerGate.isOwnerNamespace(jwt: makeJWT(ns: ns)))
    }

    @Test func missingTokenFailsClosed() {
        #expect(!OwnerGate.isOwnerNamespace(jwt: nil))
    }

    @Test(arguments: ["", "garbage", "a.!!!.c", "a..c"])
    func undecodableTokensFailClosed(jwt: String) {
        #expect(!OwnerGate.isOwnerNamespace(jwt: jwt))
    }

    @Test func payloadWithoutNsClaimFailsClosed() {
        // Well-formed base64url JSON payload, but no `ns` — claims parse
        // rejects it, so the gate stays shut.
        let token = "h.\(base64URLEncode(Data("{\"uid\":1}".utf8))).s"
        #expect(!OwnerGate.isOwnerNamespace(jwt: token))
    }
}
