import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking  // URLSession types live here on Linux
#endif
import HapiClient
import Testing

@Suite("Device registration endpoints")
struct DeviceEndpointTests {
    private func bodyString(_ request: URLRequest?) -> String? {
        request?.httpBody.flatMap { String(data: $0, encoding: .utf8) }
    }

    @Test func registerSendsExtendedIOSBody() async throws {
        let token = freshJWT()
        let harness = try makeHarness(jwt: token)
        await harness.performer.enqueue(json: "{\"ok\":true}")

        try await harness.client.registerDevice(
            token: "a1b2c3",
            deviceId: "device-uuid-1",
            pushKey: "KZFhIWo=" // shape only; real keys are 32 bytes
        )

        let request = await harness.performer.requests.first
        #expect(request?.url?.absoluteString == "\(testHubURLString)/api/devices/register")
        #expect(request?.httpMethod == "POST")
        #expect(request?.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request?.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
        #expect(
            bodyString(request)
                == "{\"deviceId\":\"device-uuid-1\",\"platform\":\"ios\",\"pushKey\":\"KZFhIWo=\",\"token\":\"a1b2c3\"}"
        )
    }

    @Test func unregisterSendsDeleteWithTokenBody() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(json: "{\"ok\":true}")

        try await harness.client.unregisterDevice(token: "a1b2c3")

        let request = await harness.performer.requests.first
        #expect(request?.url?.absoluteString == "\(testHubURLString)/api/devices/register")
        #expect(request?.httpMethod == "DELETE")
        #expect(bodyString(request) == "{\"token\":\"a1b2c3\"}")
    }

    @Test func registerSurfacesHubRejection() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(status: 400, json: "{\"error\":\"Invalid body\"}")

        let error = await capturedError {
            try await harness.client.registerDevice(
                token: "t",
                deviceId: "d",
                pushKey: "k"
            )
        }
        let apiError = try #require(error as? APIError)
        #expect(apiError.status == 400)
        #expect(apiError.code == "Invalid body")
    }
}
