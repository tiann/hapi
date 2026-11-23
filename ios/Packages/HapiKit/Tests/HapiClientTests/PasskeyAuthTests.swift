import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
@testable import HapiClient
import HapiProtocol
import Testing

/// Passkey-session credentials: storage shape, the silent re-auth exchange
/// body, terminal 401 handling, and the single-ceremony passkey sign-in.
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

    private func loginJSON(_ jwt: String = freshJWT(), session: String = "ps-1") -> String {
        "{\"token\":\"\(jwt)\",\"user\":{\"id\":1},\"passkeySession\":\"\(session)\"}"
    }

    private func authenticator(user: Data? = boundPasskeyUser(), error: (any Error & Sendable)? = nil) -> ScriptedAuthenticator {
        ScriptedAuthenticator(
            assertion: PasskeyAssertionResult(
                credentialID: Data("id".utf8), clientDataJSON: Data("{}".utf8),
                authenticatorData: Data([0x01]), signature: Data([0x02]), userID: user
            ),
            assertionError: error
        )
    }

    // MARK: Without a hub URL (hub from the credential)

    @Test func signInLocatesHubFromCredentialInOneCeremony() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        let jwt = freshJWT()
        await world.performer.enqueue(json: healthJSON)
        await world.performer.enqueue(json: loginJSON(jwt))
        let authenticator = authenticator()

        let paired = try await world.service.signInWithPasskey(authenticator: authenticator)

        #expect(paired.hubUrl == "https://hub.test")
        #expect(paired.claims?.ns == "default")
        let stored = try world.store.credentials(forHub: "https://hub.test")
        #expect(stored?.credential == .passkeySession("ps-1"))
        #expect(stored?.accessToken == nil)
        #expect(stored?.jwt == jwt)
        #expect(world.registry.activeHub == "https://hub.test")

        let assertions = await authenticator.assertions
        try #require(assertions.count == 1)
        #expect(assertions[0].relyingPartyID == "auth.hapi.run")
        let challenge = try #require(try JSONSerialization.jsonObject(with: assertions[0].challenge) as? [String: Any])
        #expect(challenge["iat"] as? Int64 == Int64(testEpochSeconds) * 1000)

        let requests = await world.performer.requests
        #expect(requests.map { $0.url?.absoluteString } == [
            "https://hub.test/health", "https://hub.test/api/passkey/login/verify"
        ])
        #expect(requests.map { $0.url?.path } == ["/health", "/api/passkey/login/verify"])
        #expect(requests[1].value(forHTTPHeaderField: "Authorization") == nil)
        let body = try #require(requests[1].httpBody)
        let object = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        let credential = try #require(object["response"] as? [String: Any])
        #expect(credential["id"] as? String == Base64URL.encode(Data("id".utf8)))
        let response = try #require(credential["response"] as? [String: Any])
        #expect(response["userHandle"] as? String == Base64URL.encode(boundPasskeyUser()))
    }

    @Test func signInWithPortInHandleUsesThatOrigin() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(json: healthJSON)
        await world.performer.enqueue(json: loginJSON())

        let paired = try await world.service.signInWithPasskey(
            authenticator: authenticator(user: boundPasskeyUser(hub: "https://other.test:8443"))
        )
        #expect(paired.hubUrl == "https://other.test:8443")
        let urls = await world.performer.requests.map { $0.url?.absoluteString }
        #expect(urls == ["https://other.test:8443/health", "https://other.test:8443/api/passkey/login/verify"])
    }

    @Test func handleWithoutHubRequiresHubAddressWithoutAnyRequest() async throws {
        let opaque = Data([2, 0]) + Data(repeating: 7, count: 32) + Data(repeating: 1, count: 16)
        for handle: Data? in [nil, Data(), opaque, Data(repeating: 0, count: 64)] {
            let world = try makeWorld()
            defer { world.tearDown() }
            let error = await capturedError {
                try await world.service.signInWithPasskey(authenticator: authenticator(user: handle))
            }
            #expect(error as? PairingFailure == .passkeyHubAddressRequired)
            let count = await world.performer.requests.count
            #expect(count == 0)
            #expect(world.registry.hubs.isEmpty)
        }
    }

    @Test func unreachableLocatedHubDoesNotVerify() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(status: 503, json: "{}")

        let error = await capturedError {
            try await world.service.signInWithPasskey(authenticator: authenticator())
        }
        #expect(error as? PairingFailure == .unreachable)
        let paths = await world.performer.requests.map { $0.url?.path }
        #expect(paths == ["/health"])
    }

    @Test func canceledSheetIsSilentAndSendsNothing() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }

        let error = await capturedError {
            try await world.service.signInWithPasskey(authenticator: authenticator(error: PasskeyError.canceled))
        }
        #expect(error as? PasskeyError == .canceled)
        let count = await world.performer.requests.count
        #expect(count == 0)
        #expect(world.registry.hubs.isEmpty)
    }

    @Test func rejectedAssertionsMapToPasskeyRejected() async throws {
        for reason in ["Passkey challenge expired", "Unknown passkey", "passkey_revoked", "Passkey verification failed"] {
            let world = try makeWorld()
            defer { world.tearDown() }
            await world.performer.enqueue(json: healthJSON)
            await world.performer.enqueue(status: 401, json: "{\"error\":\"\(reason)\"}")

            let error = await capturedError {
                try await world.service.signInWithPasskey(authenticator: authenticator())
            }
            #expect(error as? PairingFailure == .passkeyRejected)
            #expect(world.registry.hubs.isEmpty)
        }
    }

    @Test func platformFailureIsReportedAsUnavailable() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }

        let error = await capturedError {
            try await world.service.signInWithPasskey(
                authenticator: authenticator(error: PasskeyError.platform("not entitled"))
            )
        }
        #expect(error as? PairingFailure == .passkeyUnavailable)
    }

    // MARK: With a hub URL (manual entry)

    @Test func expectedHubChecksHealthBeforeTheCeremony() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(json: healthJSON)
        await world.performer.enqueue(json: loginJSON())
        let authenticator = authenticator()

        let paired = try await world.service.signInWithPasskey(rawHubUrl: "https://Hub.Test/", authenticator: authenticator)

        #expect(paired.hubUrl == "https://hub.test")
        #expect(try world.store.credentials(forHub: "https://hub.test")?.credential == .passkeySession("ps-1"))
        let paths = await world.performer.requests.map { $0.url?.path }
        #expect(paths == ["/health", "/api/passkey/login/verify"])
        let count = await authenticator.assertions.count
        #expect(count == 1)
    }

    @Test func unreachableExpectedHubNeverPrompts() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(status: 502, json: "{}")
        let authenticator = authenticator()

        let error = await capturedError {
            try await world.service.signInWithPasskey(rawHubUrl: "https://hub.test", authenticator: authenticator)
        }
        #expect(error as? PairingFailure == .unreachable)
        let assertions = await authenticator.assertions
        #expect(assertions.isEmpty)
    }

    @Test func expectedHubRejectsAnotherHubsPasskeyWithoutVerifying() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(json: healthJSON)

        let error = await capturedError {
            try await world.service.signInWithPasskey(
                rawHubUrl: "https://hub.test",
                authenticator: authenticator(user: boundPasskeyUser(hub: "https://other.test"))
            )
        }
        #expect(error as? PairingFailure == .passkeyWrongHub)
        let paths = await world.performer.requests.map { $0.url?.path }
        #expect(paths == ["/health"])
        #expect(world.registry.hubs.isEmpty)
    }

    @Test func expectedHubRejectsMissingHandle() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(json: healthJSON)

        let error = await capturedError {
            try await world.service.signInWithPasskey(rawHubUrl: "https://hub.test", authenticator: authenticator(user: nil))
        }
        #expect(error as? PairingFailure == .passkeyWrongHub)
        let count = await world.performer.requests.count
        #expect(count == 1)
    }

    #if canImport(CryptoKit)
    @Test func expectedHubAcceptsItsOpaqueHandle() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(json: healthJSON)
        await world.performer.enqueue(json: loginJSON())
        let opaque = Data([2, 0]) + PasskeyHubBinding.digest(Data("https://hub.test".utf8)) + Data(repeating: 1, count: 16)

        let paired = try await world.service.signInWithPasskey(
            rawHubUrl: "https://hub.test", authenticator: authenticator(user: opaque)
        )
        #expect(paired.hubUrl == "https://hub.test")
    }
    #endif

    @Test func plainHTTPHubCannotUsePasskeys() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        let authenticator = authenticator()

        let error = await capturedError {
            try await world.service.signInWithPasskey(rawHubUrl: "http://hub.test", authenticator: authenticator)
        }
        #expect(error as? PairingFailure == .invalidHubURL)
        let count = await world.performer.requests.count
        #expect(count == 0)
        let assertions = await authenticator.assertions
        #expect(assertions.isEmpty)
    }
}
