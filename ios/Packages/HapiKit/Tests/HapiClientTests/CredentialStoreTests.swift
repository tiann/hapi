import Foundation
import HapiClient
import Testing

// The Keychain-backed store cannot run on CI (no entitlements/keychain), so
// coverage targets the protocol semantics through the in-memory double the
// rest of the suite relies on.
@Suite("InMemoryCredentialStore")
struct CredentialStoreTests {
    @Test func roundTripsPerHubRecords() throws {
        let store = InMemoryCredentialStore()
        let missing = try store.credentials(forHub: "https://one.test")
        #expect(missing == nil)

        let one = HubCredentials(
            hubUrl: "https://one.test",
            accessToken: "token-one",
            jwt: "jwt-one",
            jwtObtainedAt: 1_700_000_000_000
        )
        let two = HubCredentials(hubUrl: "https://two.test", accessToken: "token-two")
        try store.store(one)
        try store.store(two)

        let storedOne = try store.credentials(forHub: "https://one.test")
        let storedTwo = try store.credentials(forHub: "https://two.test")
        #expect(storedOne == one)
        #expect(storedTwo == two)
    }

    @Test func storeReplacesExistingRecord() throws {
        let store = InMemoryCredentialStore()
        try store.store(HubCredentials(hubUrl: "https://one.test", accessToken: "old"))
        let updated = HubCredentials(hubUrl: "https://one.test", accessToken: "new", jwt: "j")
        try store.store(updated)
        let stored = try store.credentials(forHub: "https://one.test")
        #expect(stored == updated)
    }

    @Test func deleteIsIdempotent() throws {
        let store = InMemoryCredentialStore()
        try store.store(HubCredentials(hubUrl: "https://one.test", accessToken: "t"))
        try store.deleteCredentials(forHub: "https://one.test")
        let afterDelete = try store.credentials(forHub: "https://one.test")
        #expect(afterDelete == nil)
        // Deleting again must not throw.
        try store.deleteCredentials(forHub: "https://one.test")
    }

    @Test func hubCredentialsSurviveJSONRoundTrip() throws {
        // The Keychain store persists the record as JSON; make sure the
        // shape round-trips losslessly.
        let record = HubCredentials(
            hubUrl: "https://hub.test",
            accessToken: "base:team",
            jwt: makeJWT(),
            jwtObtainedAt: 1_700_000_123_456
        )
        let data = try JSONEncoder().encode(record)
        let decoded = try JSONDecoder().decode(HubCredentials.self, from: data)
        #expect(decoded == record)
    }
}
