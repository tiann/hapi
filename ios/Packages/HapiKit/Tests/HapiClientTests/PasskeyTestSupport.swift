import Foundation
@testable import HapiClient

func boundPasskeyChallenge(hub: String = testHubURLString, operation: String = "login", channel: String = "native") -> Data {
    try! JSONSerialization.data(withJSONObject: [
        "v": 1, "hub": hub, "id": String(repeating: "a", count: 43),
        "nonce": String(repeating: "b", count: 43), "operation": operation, "channel": channel
    ], options: [.sortedKeys])
}

func boundPasskeyUser(hub: String = testHubURLString) -> Data {
    let authority = Data(try! PasskeyHubBinding.origin(URL(string: hub)!).dropFirst("https://".count).utf8)
    return Data([2, UInt8(authority.count)]) + authority + Data(repeating: 1, count: 16)
}
