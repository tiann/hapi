import Foundation
import HapiClient
import Testing

private let usageSummaryJSON = """
{"range":{"from":null,"to":1755600000000},\
"totals":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":4,\
"cacheCreationTokens":1,"totalTokens":12,"uncachedTokens":6,"requests":3,"sessions":1},\
"daily":[],"byAgent":[],"byModel":[],"updatedAt":1755600000000}
"""

/// Request construction + error mapping of the owner-only dashboard
/// endpoints (kept out of `EndpointRequestTests` so parallel feature
/// packages don't collide in one file).
@Suite("Usage/storage endpoints")
struct UsageEndpointTests {

    @Test func usageSummarySendsRangeAndTimeZone() async throws {
        let token = freshJWT()
        let harness = try makeHarness(jwt: token)
        await harness.performer.enqueue(json: usageSummaryJSON)

        let summary = try await harness.client.usageSummary(range: "30d", timeZone: "Asia/Shanghai")
        #expect(summary.range.from == nil)
        #expect(summary.totals.totalTokens == 12)

        let request = await harness.performer.requests.first
        #expect(
            request?.url?.absoluteString
                == "\(testHubURLString)/api/usage/summary?range=30d&timeZone=Asia%2FShanghai"
        )
        #expect(request?.httpMethod == "GET")
        #expect(request?.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
    }

    @Test func sqliteStorageUsageHitsThePlainPath() async throws {
        let harness = try makeHarness(jwt: freshJWT())
        await harness.performer.enqueue(
            json: """
            {"path":"/x/hapi.db","databaseBytes":100,"walBytes":20,"shmBytes":5,"totalBytes":125}
            """
        )

        let usage = try await harness.client.sqliteStorageUsage()
        #expect(usage.totalBytes == 125)

        let request = await harness.performer.requests.first
        #expect(request?.url?.absoluteString == "\(testHubURLString)/api/storage/sqlite")
        #expect(request?.httpMethod == "GET")
    }

    /// Non-owner namespaces get a 403 — surfaced as `APIError` so the
    /// dashboards can show the owner-only explanation instead of a retry.
    @Test func forbiddenSurfacesAsAPIErrorWith403() async throws {
        let harness = try makeHarness(jwt: freshJWT(ns: "team"))
        await harness.performer.enqueue(status: 403, json: "{\"error\":\"Forbidden\"}")

        let error = await capturedError {
            try await harness.client.usageSummary()
        }
        #expect((error as? APIError)?.status == 403)
    }
}
