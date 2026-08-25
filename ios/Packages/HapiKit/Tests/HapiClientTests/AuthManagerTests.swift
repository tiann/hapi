import Foundation
import HapiClient
import HapiProtocol
import Testing

@Suite("AuthManager")
struct AuthManagerTests {
    @Test func concurrentCallersShareOneRefresh() async throws {
        let harness = try makeHarness(jwt: nil)
        let issued = freshJWT()
        await harness.performer.enqueue(json: authResponseJSON(token: issued))
        await harness.performer.setDelay(nanoseconds: 20_000_000)

        let tokens = try await withThrowingTaskGroup(of: String.self) { group in
            for _ in 0..<8 {
                group.addTask { try await harness.auth.validToken() }
            }
            var collected: [String] = []
            for try await token in group {
                collected.append(token)
            }
            return collected
        }

        #expect(tokens.count == 8)
        #expect(Set(tokens) == [issued])
        let requests = await harness.performer.requests
        try #require(requests.count == 1)
        #expect(requests[0].url?.absoluteString == "\(testHubURLString)/api/auth")
        #expect(requests[0].httpMethod == "POST")
        let body = requests[0].httpBody.flatMap { String(data: $0, encoding: .utf8) }
        #expect(body == "{\"accessToken\":\"access-token\"}")
    }

    @Test func freshTokenIsReturnedWithoutTraffic() async throws {
        let stored = freshJWT()
        let harness = try makeHarness(jwt: stored)
        let token = try await harness.auth.validToken()
        #expect(token == stored)
        let requestCount = await harness.performer.requests.count
        #expect(requestCount == 0)
    }

    @Test func refreshesProactivelyWithinTenMinutesOfExpiry() async throws {
        let expiring = makeJWT(exp: testEpochSeconds + 5 * 60)
        let harness = try makeHarness(jwt: expiring)
        let issued = freshJWT()
        await harness.performer.enqueue(json: authResponseJSON(token: issued))

        let token = try await harness.auth.validToken()
        #expect(token == issued)
        let requestCount = await harness.performer.requests.count
        #expect(requestCount == 1)
    }

    @Test func failedProactiveRefreshFallsBackAndThrottles() async throws {
        let expiring = makeJWT(exp: testEpochSeconds + 5 * 60)
        let harness = try makeHarness(jwt: expiring)
        await harness.performer.setFallback(status: 503, json: "{\"error\":\"Not connected\"}")

        // First attempt hits the hub, fails, and falls back to the still
        // valid token.
        let first = try await harness.auth.validToken()
        #expect(first == expiring)
        let countAfterFirst = await harness.performer.requests.count
        #expect(countAfterFirst == 1)

        // Within the 15 s throttle no further attempt is made.
        let second = try await harness.auth.validToken()
        #expect(second == expiring)
        let countAfterSecond = await harness.performer.requests.count
        #expect(countAfterSecond == 1)
    }

    @Test func expiredTokenIsRefreshed() async throws {
        let expired = makeJWT(exp: testEpochSeconds - 10)
        let harness = try makeHarness(jwt: expired)
        let issued = freshJWT()
        await harness.performer.enqueue(json: authResponseJSON(token: issued))

        let token = try await harness.auth.validToken()
        #expect(token == issued)
        let requestCount = await harness.performer.requests.count
        #expect(requestCount == 1)
    }

    @Test func authEndpoint401IsTerminal() async throws {
        let harness = try makeHarness(jwt: nil)
        await harness.performer.setFallback(status: 401, json: "{\"error\":\"Invalid access token\"}")

        let firstError = await capturedError { try await harness.auth.validToken() }
        #expect(firstError as? AuthError == .reauthenticationRequired)
        let failed = await harness.auth.isAuthenticationFailed
        #expect(failed)

        // Terminal: no further exchange is attempted.
        let secondError = await capturedError { try await harness.auth.validToken() }
        #expect(secondError as? AuthError == .reauthenticationRequired)
        let requestCount = await harness.performer.requests.count
        #expect(requestCount == 1)
    }

    @Test func missingCredentialsThrowNotPaired() async throws {
        let harness = try makeHarness(paired: false)
        let error = await capturedError { try await harness.auth.validToken() }
        #expect(error as? AuthError == .notPaired)
        let requestCount = await harness.performer.requests.count
        #expect(requestCount == 0)
        // Not terminal: pairing afterwards must be able to proceed.
        let failed = await harness.auth.isAuthenticationFailed
        #expect(failed == false)
    }

    @Test func refreshPersistsJWTNextToAccessToken() async throws {
        let harness = try makeHarness(jwt: nil)
        let issued = freshJWT()
        await harness.performer.enqueue(json: authResponseJSON(token: issued))

        _ = try await harness.auth.validToken()
        let stored = try harness.store.credentials(forHub: testHubURLString)
        #expect(stored?.accessToken == "access-token")
        #expect(stored?.jwt == issued)
        #expect(stored?.jwtObtainedAt == testEpochSeconds * 1000)
    }

    @Test func unauthorizedRefreshSkipsExchangeWhenTokenAlreadyRotated() async throws {
        let current = freshJWT()
        let harness = try makeHarness(jwt: current)
        // Prime the in-memory token.
        _ = try await harness.auth.validToken()

        let token = try await harness.auth.refreshAfterUnauthorized(failedToken: "some-older-token")
        #expect(token == current)
        let requestCount = await harness.performer.requests.count
        #expect(requestCount == 0)
    }

    @Test func claimsExposeNamespaceForOwnerGating() async throws {
        let harness = try makeHarness(jwt: freshJWT(ns: "team"))
        _ = try await harness.auth.validToken()
        let claims = await harness.auth.currentClaims
        #expect(claims?.ns == "team")
    }
}
