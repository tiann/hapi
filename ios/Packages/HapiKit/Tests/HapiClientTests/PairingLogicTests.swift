import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiClient
import Testing

/// The pairing sequence (normalize → health → auth → persist) against the
/// scripted `RecordingPerformer`. The SwiftUI layer on top (`AppModel`) only
/// translates these outcomes into view state.
@Suite("HubPairingService")
struct PairingLogicTests {
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
        let suiteName = "PairingLogicTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        let registry = HubRegistry(defaults: defaults)
        let store = InMemoryCredentialStore()
        let performer = RecordingPerformer()
        let service = HubPairingService(
            registry: registry,
            credentialStore: store,
            performer: performer,
            now: { testNow }
        )
        return World(
            defaults: defaults,
            suiteName: suiteName,
            registry: registry,
            store: store,
            performer: performer,
            service: service
        )
    }

    private func healthJSON(protocolVersion: Int = 1, status: String = "ok") -> String {
        "{\"status\":\"\(status)\",\"protocolVersion\":\(protocolVersion),\"capabilities\":{\"workGraph\":true}}"
    }

    // MARK: - Success

    @Test func successfulPairPersistsCredentialsAndActivatesHub() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        let jwt = freshJWT()
        await world.performer.enqueue(status: 200, json: healthJSON())
        await world.performer.enqueue(status: 200, json: authResponseJSON(token: jwt))

        let paired = try await world.service.pair(
            rawHubUrl: " https://Hub.Example.com/ ",
            accessToken: "tok_9f8:default"
        )

        #expect(paired.hubUrl == "https://hub.example.com")
        #expect(paired.claims?.ns == "default")
        let stored = try #require(try world.store.credentials(forHub: "https://hub.example.com"))
        #expect(stored.accessToken == "tok_9f8:default")
        #expect(stored.jwt == jwt)
        #expect(world.registry.hubs == ["https://hub.example.com"])
        #expect(world.registry.activeHub == "https://hub.example.com")

        // Wire order: unauthenticated GET /health, then POST /api/auth with
        // the token passed through verbatim (opaque, incl. the namespace).
        let requests = await world.performer.requests
        #expect(requests.count == 2)
        #expect(requests[0].url?.absoluteString == "https://hub.example.com/health")
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == nil)
        #expect(requests[1].url?.absoluteString == "https://hub.example.com/api/auth")
        let body = try #require(requests[1].httpBody)
        #expect(String(data: body, encoding: .utf8) == "{\"accessToken\":\"tok_9f8:default\"}")
    }

    @Test func pairingASecondHubMakesItActive() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(status: 200, json: healthJSON())
        await world.performer.enqueue(status: 200, json: authResponseJSON(token: freshJWT()))
        _ = try await world.service.pair(rawHubUrl: "https://one.test", accessToken: "a")

        await world.performer.enqueue(status: 200, json: healthJSON())
        await world.performer.enqueue(status: 200, json: authResponseJSON(token: freshJWT()))
        _ = try await world.service.pair(rawHubUrl: "https://two.test", accessToken: "b")

        #expect(world.registry.hubs == ["https://one.test", "https://two.test"])
        #expect(world.registry.activeHub == "https://two.test")
    }

    @Test func repairingReplacesTheStoredAccessToken() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        try world.store.store(HubCredentials(hubUrl: "https://hub.test", accessToken: "rotated-away"))
        world.registry.register("https://hub.test")
        await world.performer.enqueue(status: 200, json: healthJSON())
        await world.performer.enqueue(status: 200, json: authResponseJSON(token: freshJWT()))

        _ = try await world.service.pair(rawHubUrl: "https://hub.test", accessToken: "fresh-token")

        let stored = try #require(try world.store.credentials(forHub: "https://hub.test"))
        #expect(stored.accessToken == "fresh-token")
        #expect(world.registry.hubs == ["https://hub.test"])
    }

    // MARK: - Failure states (the pairing screen's error cases)

    @Test func rejectsAnInvalidHubURLWithoutTouchingTheNetwork() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }

        let error = await capturedError {
            try await world.service.pair(rawHubUrl: "not a url", accessToken: "x")
        }

        #expect(error as? PairingFailure == .invalidHubURL)
        #expect(await world.performer.requests.isEmpty)
    }

    @Test func transportFailureIsUnreachable() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.setError(URLError(.cannotConnectToHost))

        let error = await capturedError {
            try await world.service.pair(rawHubUrl: "https://hub.test", accessToken: "x")
        }

        #expect(error as? PairingFailure == .unreachable)
    }

    @Test func nonHubResponseBodyIsUnreachable() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(status: 200, json: "<html>captive portal</html>")

        let error = await capturedError {
            try await world.service.pair(rawHubUrl: "https://hub.test", accessToken: "x")
        }

        #expect(error as? PairingFailure == .unreachable)
    }

    @Test func protocolMismatchIsSurfacedWithBothVersions() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(status: 200, json: healthJSON(protocolVersion: 2))

        let error = await capturedError {
            try await world.service.pair(rawHubUrl: "https://hub.test", accessToken: "x")
        }

        #expect(error as? PairingFailure == .protocolMismatch(hubVersion: 2, supportedVersion: 1))
        // Never sends the token to an incompatible hub.
        #expect(await world.performer.requests.count == 1)
    }

    @Test func badTokenIsInvalidAccessTokenAndPersistsNothing() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(status: 200, json: healthJSON())
        await world.performer.enqueue(status: 401, json: "{\"error\":\"Invalid access token\"}")

        let error = await capturedError {
            try await world.service.pair(rawHubUrl: "https://hub.test", accessToken: "wrong")
        }

        #expect(error as? PairingFailure == .invalidAccessToken)
        #expect(try world.store.credentials(forHub: "https://hub.test") == nil)
        #expect(world.registry.hubs.isEmpty)
    }

    @Test func unexpectedAuthStatusIsHubError() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        await world.performer.enqueue(status: 200, json: healthJSON())
        await world.performer.enqueue(status: 500, json: "{\"error\":\"boom\"}")

        let error = await capturedError {
            try await world.service.pair(rawHubUrl: "https://hub.test", accessToken: "x")
        }

        #expect(error as? PairingFailure == .hubError(status: 500))
    }

    // MARK: - Unpairing

    @Test func unpairDeletesCredentialsAndFallsBackToNextHub() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        for hub in ["https://one.test", "https://two.test"] {
            try world.store.store(HubCredentials(hubUrl: hub, accessToken: "t"))
            world.registry.register(hub)
        }
        world.registry.setActiveHub("https://one.test")

        let nextActive = world.service.unpair(hubUrl: "https://one.test")

        #expect(nextActive == "https://two.test")
        #expect(try world.store.credentials(forHub: "https://one.test") == nil)
        #expect(try world.store.credentials(forHub: "https://two.test") != nil)
        #expect(world.registry.hubs == ["https://two.test"])
    }

    @Test func unpairingTheLastHubReturnsNil() async throws {
        let world = try makeWorld()
        defer { world.tearDown() }
        try world.store.store(HubCredentials(hubUrl: "https://one.test", accessToken: "t"))
        world.registry.register("https://one.test")

        let nextActive = world.service.unpair(hubUrl: "https://one.test")

        #expect(nextActive == nil)
        #expect(world.registry.hubs.isEmpty)
        #expect(try world.store.credentials(forHub: "https://one.test") == nil)
    }
}
