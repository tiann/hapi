import Foundation
@testable import HapiClient

#if canImport(CryptoKit)
let passkeyRegistrationAvailable = true
#else
let passkeyRegistrationAvailable = false
#endif

func boundPasskeyChallenge(hub: String = testHubURLString, operation: String = "login", channel: String = "native") -> Data {
    try! JSONSerialization.data(withJSONObject: [
        "v": 1, "hub": hub, "id": String(repeating: "a", count: 43),
        "nonce": String(repeating: "b", count: 43), "operation": operation, "channel": channel
    ], options: [.sortedKeys])
}

func boundPasskeyUser(hub: String = testHubURLString) -> Data {
    PasskeyHubBinding.digest(Data(hub.utf8)) + Data(repeating: 1, count: 32)
}
