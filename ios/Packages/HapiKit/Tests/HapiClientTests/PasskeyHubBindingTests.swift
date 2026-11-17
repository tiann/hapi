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

    @Test(.enabled(if: passkeyRegistrationAvailable)) func accountHandleCannotOverwriteAnotherHubsAccount() throws {
        try PasskeyHubBinding.validateUser(boundPasskeyUser(), hub: hub)
        #expect(throws: PasskeyError.malformedOptions) {
            try PasskeyHubBinding.validateUser(boundPasskeyUser(), hub: URL(string: "https://other.test")!)
        }
        #expect(throws: PasskeyError.malformedOptions) { try PasskeyHubBinding.validateUser(Data(repeating: 0, count: 32), hub: hub) }
        // Cross-language SHA-256 vector, also used by the Hub's account prefix.
        #expect(PasskeyHubBinding.digest(Data("https://hub.test".utf8)).map { String(format: "%02x", $0) }.joined()
            == "96c5db5fa93f9ae43b5a061e2e69edc818a05634fb139bbd45dd887da3bfd27f")
    }
}
