import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiClient
import HapiProtocol
import Testing

/// Passkey-session credentials: storage shape, the silent re-auth exchange
/// body, terminal 401 handling, and the URL-only passkey sign-in.
@Suite("Passkey credentials")
struct PasskeyAuthTests {
    private func makePasskeyHarness(session: String = "passkey-session", jwt: String? = nil) throws -> Harness {
        let harness = try makeHarness(paired: false)
        try harness.store.store(HubCredentials(
            hubUrl: testHubURLString,
            credential: .passkeySession(session),
            jwt: jwt
        ))
        return harness
    }

    // MARK: - Storage

    @Test func passkeyRecordRoundTripsWithoutAccessToken() throws {
        let record = HubCredentials(
            hubUrl: "https://hub.test",
            credential: .passkeySession("ps"),
            jwt: "j",
            jwtObtainedAt: 1
        )
        let data = try JSONEncoder().encode(record)
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["passkeySession"] as? String == "ps")
        #expect(object["accessToken"] == nil)
        let decoded = try JSONDecoder().decode(HubCredentials.self, from: data)
        #expect(decoded == record)
        #expect(decoded.accessToken == nil)
        #expect(decoded.passkeySession == "ps")
    }

    @Test func legacyAccessTokenRecordStillDecodes() throws {
        // Records written before passkeys carried only `accessToken`.
        let data = Data("{\"hubUrl\":\"https://hub.test\",\"accessToken\":\"tok\",\"jwt\":\"j\"}".utf8)
        let decoded = try JSONDecoder().decode(HubCredentials.self, from: data)
        #expect(decoded.credential == .accessToken("tok"))
        #expect(decoded.jwt == "j")
    }

    @Test func recordWithoutCredentialFailsToDecode() {
        let data = Data("{\"hubUrl\":\"https://hub.test\"}".utf8)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(HubCredentials.self, from: data)
        }
    }

    // MARK: - Re-auth exchange

    @Test func refreshExchangesPasskeySession() async throws {
        let harness = try makePasskeyHarness()
        let issued = freshJWT()
        await harness.performer.enqueue(json: authResponseJSON(token: issued))

        let token = try await harness.auth.validToken()
        #expect(token == issued)
        let requests = await harness.performer.requests
        try #require(requests.count == 1)
        #expect(requests[0].url?.absoluteString == "\(testHubURLString)/api/auth")
        let body = requests[0].httpBody.flatMap { String(data: $0, encoding: .utf8) }
        #expect(body == "{\"passkeySession\":\"passkey-session\"}")

        // The refreshed JWT is persisted next to the session, which is kept.
        let stored = try harness.store.credentials(forHub: testHubURLString)
        #expect(stored?.jwt == issued)
        #expect(stored?.credential == .passkeySession("passkey-session"))
    }

    @Test func exchangeBodiesPerCredentialKind() {
        #expect(HubAuthCredential.accessToken("t").exchangeBody == ["accessToken": "t"])
        #expect(HubAuthCredential.passkeySession("s").exchangeBody == ["passkeySession": "s"])
    }

    @Test func passkeySessionInvalidIsTerminal() async throws {
        let harness = try makePasskeyHarness()
        await harness.performer.setFallback(status: 401, json: "{\"error\":\"passkey_session_invalid\"}")

        let first = await capturedError { try await harness.auth.validToken() }
        #expect(first as? AuthError == .reauthenticationRequired)
        let failed = await harness.auth.isAuthenticationFailed
        #expect(failed)
        let second = await capturedError { try await harness.auth.validToken() }
        #expect(second as? AuthError == .reauthenticationRequired)
        let count = await harness.performer.requests.count
        #expect(count == 1)
    }

    @Test func expiredJWTOnRequestReexchangesPasskeySession() async throws {
        let stale = freshJWT(ns: "stale")
        let harness = try makePasskeyHarness(jwt: stale)
        let issued = freshJWT()
        await harness.performer.enqueue(status: 401, json: "{\"error\":\"Invalid token\"}")
        await harness.performer.enqueue(json: authResponseJSON(token: issued))
        await harness.performer.enqueue(json: "{\"passkeys\":[]}")

        _ = try await harness.client.listPasskeys()
        let requests = await harness.performer.requests
        try #require(requests.count == 3)
        #expect(requests[1].httpBody.flatMap { String(data: $0, encoding: .utf8) } == "{\"passkeySession\":\"passkey-session\"}")
        #expect(requests[2].value(forHTTPHeaderField: "Authorization") == "Bearer \(issued)")
    }

    // MARK: - Sign-in with passkey

    private struct World {
        let defaults: UserDefaults
        let suiteName: String
        let registry: HubRegistry
        let store: InMemoryCredentialStore
        let performer: RecordingPerformer
        let service: HubPairingService

        func tearDown() {
            defaults.removePersistentDomain(forName: suiteName)
        }
    }

    private func makeWorld() throws -> World {
        let suiteName = "PasskeyAuthTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        let registry = HubRegistry(defaults: defaults)
        let store = InMemoryCredentialStore()
        let performer = RecordingPerformer()
        let service = HubPairingService(registry: registry, credentialStore: store, performer: performer, now: { testNow })
        return World(defaults: defaults, suiteName: suiteName, registry: registry, store: store, performer: performer, service: service)
    }

    private let healthJSON = "{\"status\":\"ok\",\"protocolVersion\":\(ProtocolVersion.supported)}"

    private func loginOptionsJSON(rpId: String = "auth.hapi.run") -> String {
        "{\"challenge\":\"\(Base64URL.encode(boundPasskeyChallenge()))\",\"rpId\":\"\(rpId)\",\"allowCredentials\":[{\"id\":\"aWQ\"}]}"
    }

    @Test func signInStoresPasskeySessionAndActivatesHub() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        let jwt = freshJWT()
        await world.performer.enqueue(json: healthJSON)
        await world.performer.enqueue(json: loginOptionsJSON())
        await world.performer.enqueue(json: "{\"token\":\"\(jwt)\",\"user\":{\"id\":1},\"passkeySession\":\"ps-1\"}")
        let authenticator = ScriptedAuthenticator()

        let paired = try await world.service.signInWithPasskey(rawHubUrl: "https://Hub.Test/", authenticator: authenticator)

        #expect(paired.hubUrl == "https://hub.test")
        #expect(paired.claims?.ns == "default")
        let stored = try world.store.credentials(forHub: "https://hub.test")
        #expect(stored?.credential == .passkeySession("ps-1"))
        #expect(stored?.accessToken == nil)
        #expect(stored?.jwt == jwt)
        #expect(world.registry.activeHub == "https://hub.test")
        let assertions = await authenticator.assertions
        #expect(assertions.first?.allowedCredentialIDs == [Data("id".utf8)])
        let paths = await world.performer.requests.map { $0.url?.path }
        #expect(paths == ["/health", "/api/passkey/login/options", "/api/passkey/login/verify"])
    }

    @Test func signInWithoutPasskeysReportsNoPasskeys() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(json: healthJSON)
        await world.performer.enqueue(status: 404, json: "{\"error\":\"no_passkeys\"}")
        let authenticator = ScriptedAuthenticator()

        let error = await capturedError {
            try await world.service.signInWithPasskey(rawHubUrl: "https://hub.test", authenticator: authenticator)
        }
        #expect(error as? PairingFailure == .noPasskeys)
        let assertions = await authenticator.assertions
        #expect(assertions.isEmpty)
        #expect(world.registry.hubs.isEmpty)
    }

    @Test func signInRefusesForeignRelyingPartyBeforeCeremony() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(json: healthJSON)
        await world.performer.enqueue(json: loginOptionsJSON(rpId: "hub.test"))
        let authenticator = ScriptedAuthenticator()

        let error = await capturedError {
            try await world.service.signInWithPasskey(rawHubUrl: "https://hub.test", authenticator: authenticator)
        }
        #expect(error as? PairingFailure == .passkeyRejected)
        let assertions = await authenticator.assertions
        #expect(assertions.isEmpty)
    }

    @Test func canceledSheetPropagatesCancellationWithoutPersisting() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(json: healthJSON)
        await world.performer.enqueue(json: loginOptionsJSON())
        let authenticator = ScriptedAuthenticator(assertionError: PasskeyError.canceled)

        let error = await capturedError {
            try await world.service.signInWithPasskey(rawHubUrl: "https://hub.test", authenticator: authenticator)
        }
        #expect(error as? PasskeyError == .canceled)
        #expect(try world.store.credentials(forHub: "https://hub.test") == nil)
        let count = await world.performer.requests.count
        #expect(count == 2)
    }

    @Test func revokedPasskeyIsRejected() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(json: healthJSON)
        await world.performer.enqueue(json: loginOptionsJSON())
        await world.performer.enqueue(status: 401, json: "{\"error\":\"passkey_revoked\"}")

        let error = await capturedError {
            try await world.service.signInWithPasskey(rawHubUrl: "https://hub.test", authenticator: ScriptedAuthenticator())
        }
        #expect(error as? PairingFailure == .passkeyRejected)
        #expect(world.registry.hubs.isEmpty)
    }

    @Test func platformFailureIsReportedAsUnavailable() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(json: healthJSON)
        await world.performer.enqueue(json: loginOptionsJSON())
        let authenticator = ScriptedAuthenticator(assertionError: PasskeyError.platform("not entitled"))

        let error = await capturedError {
            try await world.service.signInWithPasskey(rawHubUrl: "https://hub.test", authenticator: authenticator)
        }
        #expect(error as? PairingFailure == .passkeyUnavailable)
    }
}
