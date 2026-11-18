import Foundation
@testable import HapiClient
import Testing

@Suite("Passkey Hub isolation")
struct PasskeyHubBindingTests {
    let hub = URL(string: "https://hub.test")!

    @Test func challengeCannotBeForwardedBetweenHubsOrChannels() throws {
        try PasskeyHubBinding.validate(boundPasskeyChallenge(), hub: hub, operation: "login")
        for data in [
            boundPasskeyChallenge(hub: "https://other.test"),
            boundPasskeyChallenge(operation: "register"),
            boundPasskeyChallenge(channel: "browser"),
            Data("{}".utf8), Data("null".utf8)
        ] {
            #expect(throws: PasskeyError.malformedOptions) {
                try PasskeyHubBinding.validate(data, hub: hub, operation: "login")
            }
        }
    }

    @Test func originCanonicalizationIsStrict() throws {
        #expect(try PasskeyHubBinding.origin(URL(string: "https://HUB.test:443/")!) == "https://hub.test")
        for value in ["http://hub.test", "https://u:p@hub.test", "https://hub.test/path", "https://hub.test?q=1", "https://hub.test#fragment"] {
            #expect(throws: PasskeyError.malformedOptions) { try PasskeyHubBinding.origin(URL(string: value)!) }
        }
    }

    @Test func accountHandleCannotOverwriteAnotherHubsAccount() throws {
        try PasskeyHubBinding.validateUser(boundPasskeyUser(), hub: hub)
        #expect(throws: PasskeyError.malformedOptions) {
            try PasskeyHubBinding.validateUser(boundPasskeyUser(), hub: URL(string: "https://other.test")!)
        }
        #expect(throws: PasskeyError.malformedOptions) { try PasskeyHubBinding.validateUser(Data(repeating: 0, count: 32), hub: hub) }

    }

    @Test func nativeLoginChallengeIsNotHubBound() throws {
        // A self-issued login challenge can never pass as a Hub-issued one.
        let challenge = PasskeyAssertionRequest.nativeLogin(now: Date()).challenge
        for operation in ["login", "register"] {
            #expect(throws: PasskeyError.malformedOptions) {
                try PasskeyHubBinding.validate(challenge, hub: hub, operation: operation)
            }
        }
    }

    @Test func locatorEncodingMatchesOtherClientsAndRejectsMalformedOrigins() throws {
        #expect(boundPasskeyUser().map { String(format: "%02x", $0) }.joined() == "02086875622e7465737401010101010101010101010101010101")
        #expect(try PasskeyHubBinding.userHub(boundPasskeyUser()) == "https://hub.test")
        for origin in ["https://hub.test:8443", "https://[2001:db8::1]:8443"] {
            let authority = Data(origin.dropFirst("https://".count).utf8)
            let handle = Data([2, UInt8(authority.count)]) + authority + Data(repeating: 1, count: 16)
            #expect(try PasskeyHubBinding.userHub(handle) == origin)
            try PasskeyHubBinding.validateUser(handle, hub: URL(string: origin)!)
        }
        for authority in ["hub.test/path", "hub.test?x", "u:p@hub.test", "HUB.test", "hub.test:443", "hub.test/", "hub.test#x"] {
            let bytes = Data(authority.utf8)
            #expect(throws: PasskeyError.malformedOptions) {
                try PasskeyHubBinding.userHub(Data([2, UInt8(bytes.count)]) + bytes + Data(repeating: 1, count: 16))
            }
        }
        let opaque = Data([2, 0]) + PasskeyHubBinding.digest(Data("https://hub.test".utf8)) + Data(repeating: 1, count: 16)
        #if canImport(CryptoKit)
        #expect(try PasskeyHubBinding.userHub(opaque) == nil)
        try PasskeyHubBinding.validateUser(opaque, hub: hub)
        #expect(throws: PasskeyError.malformedOptions) { try PasskeyHubBinding.validateUser(opaque, hub: URL(string: "https://other.test")!) }
        #endif
    }

}
