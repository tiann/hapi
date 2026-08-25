import Foundation
import HapiClient
import HapiProtocol
import Testing

@Suite("APIClient auth & errors")
struct APIClientTests {
    @Test func retriesOnceAfter401WithRefreshedToken() async throws {
        let initial = freshJWT()
        let harness = try makeHarness(jwt: initial)
        let rotated = makeJWT(exp: testEpochSeconds + 5 * 3600)
        await harness.performer.enqueue(status: 401, json: "{\"error\":\"Invalid token\"}")
        await harness.performer.enqueue(json: authResponseJSON(token: rotated))
        await harness.performer.enqueue(json: "{\"sessions\":[]}")

        let sessions = try await harness.client.listSessions()
        #expect(sessions.isEmpty)

        let requests = await harness.performer.requests
        try #require(requests.count == 3)
        #expect(requests[0].url?.absoluteString == "\(testHubURLString)/api/sessions")
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer \(initial)")
        #expect(requests[1].url?.absoluteString == "\(testHubURLString)/api/auth")
        #expect(requests[1].value(forHTTPHeaderField: "Authorization") == nil)
        #expect(requests[2].url?.absoluteString == "\(testHubURLString)/api/sessions")
        #expect(requests[2].value(forHTTPHeaderField: "Authorization") == "Bearer \(rotated)")
    }

    @Test func secondConsecutive401IsTerminal() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        let rotated = makeJWT(exp: testEpochSeconds + 5 * 3600)
        await harness.performer.enqueue(status: 401, json: "{\"error\":\"Invalid token\"}")
        await harness.performer.enqueue(json: authResponseJSON(token: rotated))
        await harness.performer.enqueue(status: 401, json: "{\"error\":\"Invalid token\"}")

        let error = await capturedError { try await harness.client.listSessions() }
        let apiError = error as? APIError
        #expect(apiError?.status == 401)
        let failed = await harness.auth.isAuthenticationFailed
        #expect(failed)
        let countAfterFailure = await harness.performer.requests.count
        #expect(countAfterFailure == 3)

        // Follow-up calls surface "re-pair needed" without touching the hub.
        let followUp = await capturedError { try await harness.client.listSessions() }
        #expect(followUp as? AuthError == .reauthenticationRequired)
        let countAfterFollowUp = await harness.performer.requests.count
        #expect(countAfterFollowUp == 3)
    }

    @Test func rejectedAccessTokenSurfacesReauthenticationRequired() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(status: 401, json: "{\"error\":\"Invalid token\"}")
        await harness.performer.enqueue(status: 401, json: "{\"error\":\"Invalid access token\"}")

        let error = await capturedError { try await harness.client.listSessions() }
        #expect(error as? AuthError == .reauthenticationRequired)
        let requestCount = await harness.performer.requests.count
        #expect(requestCount == 2)
    }

    @Test func parsesErrorBodyWithCode() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(
            status: 409,
            json: "{\"error\":\"Session is inactive\",\"code\":\"session_inactive\"}"
        )
        let error = await capturedError { try await harness.client.abortSession(id: "s1") }
        let apiError = error as? APIError
        #expect(apiError?.status == 409)
        #expect(apiError?.code == "session_inactive")
        #expect(apiError?.body == "{\"error\":\"Session is inactive\",\"code\":\"session_inactive\"}")
    }

    @Test func fallsBackToErrorStringAsPseudoCode() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(status: 503, json: "{\"error\":\"Not connected\"}")
        let error = await capturedError { try await harness.client.listSessions() }
        #expect((error as? APIError)?.code == "Not connected")
    }

    @Test func nonJSONBodyYieldsNilCode() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(status: 500, json: "boom")
        let error = await capturedError { try await harness.client.listSessions() }
        let apiError = error as? APIError
        #expect(apiError?.status == 500)
        #expect(apiError?.code == nil)
        #expect(apiError?.body == "boom")
    }

    @Test func healthIsUnauthenticated() async throws {
        // Deliberately unpaired: /health must not consult AuthManager.
        let harness = try makeHarness(paired: false)
        await harness.performer.enqueue(json: "{\"status\":\"ok\",\"protocolVersion\":1}")
        let health = try await harness.client.health()
        #expect(health.status == "ok")
        #expect(health.protocolVersion == 1)
        let requests = await harness.performer.requests
        try #require(requests.count == 1)
        #expect(requests[0].url?.absoluteString == "\(testHubURLString)/health")
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func authenticateExchangesAccessToken() async throws {
        let harness = try makeHarness(paired: false)
        let issued = freshJWT()
        await harness.performer.enqueue(json: authResponseJSON(token: issued))
        let response = try await harness.client.authenticate(accessToken: "base:team")
        #expect(response.token == issued)
        #expect(response.user.id == 1)
        let requests = await harness.performer.requests
        try #require(requests.count == 1)
        #expect(requests[0].url?.absoluteString == "\(testHubURLString)/api/auth")
        let body = requests[0].httpBody.flatMap { String(data: $0, encoding: .utf8) }
        #expect(body == "{\"accessToken\":\"base:team\"}")
        #expect(requests[0].value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func requestBytesReturnsRawPayload() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(
            json: "not-json-bytes",
            headers: ["Content-Type": "image/png"]
        )
        let image = try await harness.client.generatedImage(sessionId: "s1", imageId: "img1")
        #expect(image.data == Data("not-json-bytes".utf8))
        #expect(image.mimeType == "image/png")
        let requests = await harness.performer.requests
        try #require(requests.count == 1)
        #expect(
            requests[0].url?.absoluteString
                == "\(testHubURLString)/api/sessions/s1/generated-images/img1"
        )
    }
}
