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

    @Test func discoveryUsesALocalChallengeAndReturnsOnlyALocator() async throws {
        let result = PasskeyAssertionResult(credentialID: Data("id".utf8), clientDataJSON: Data(), authenticatorData: Data(), signature: Data(), userID: boundPasskeyUser())
        let authenticator = ScriptedAuthenticator(assertion: result)
        #expect(try await NativePasskeys.discoverHub(authenticator: authenticator) == "https://hub.test")
        let request = try #require(await authenticator.assertions.first)
        #expect(request.relyingPartyID == "auth.hapi.run")
        #expect(request.allowedCredentialIDs.isEmpty)
        let json = try #require(JSONSerialization.jsonObject(with: request.challenge) as? [String: Any])
        #expect(json["operation"] as? String == "discover")
        #expect(json["channel"] as? String == "native")
        #expect(json["hub"] == nil)
        #expect(request.challenge != PasskeyAssertionRequest.discovery().challenge)
        #expect(throws: PasskeyError.malformedOptions) {
            try PasskeyHubBinding.validate(request.challenge, hub: hub, operation: "login")
        }
    }

    @Test func discoveryRefusesMissingOrOpaqueHandles() async throws {
        for handle: Data? in [nil, Data(), Data(repeating: 0, count: 64), Data([2, 0]) + Data(repeating: 1, count: 48)] {
            let result = PasskeyAssertionResult(credentialID: Data(), clientDataJSON: Data(), authenticatorData: Data(), signature: Data(), userID: handle)
            await #expect(throws: PasskeyError.hubDiscoveryUnavailable) {
                try await NativePasskeys.discoverHub(authenticator: ScriptedAuthenticator(assertion: result))
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
