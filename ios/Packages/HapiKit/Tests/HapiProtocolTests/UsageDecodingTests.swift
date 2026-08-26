import Foundation
import HapiProtocol
import Testing

/// Decoding of the owner-only dashboard payloads (`GET /api/usage/summary`,
/// `GET /api/storage/sqlite`) — shaped like `hub/src/sync/usageService.ts`
/// output: sparse ascending `daily`, desc-sorted `byAgent`/`byModel`,
/// `range.from = null` on `range=all`, unknown keys ignored. Transcribed
/// from the Android `UsageDecodingTest`.
@Suite("Usage/storage wire decoding")
struct UsageDecodingTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    @Test func decodesARealisticUsageSummary() throws {
        let summary = try decode(UsageSummaryResponse.self, """
        {
          "range": {"from": 1754995200000, "to": 1755600000000},
          "totals": {
            "inputTokens": 12400000,
            "outputTokens": 310000,
            "cacheReadTokens": 9800000,
            "cacheCreationTokens": 1100000,
            "totalTokens": 12710000,
            "uncachedTokens": 2600000,
            "requests": 1842,
            "sessions": 23
          },
          "daily": [
            {"key": "2026-08-12", "inputTokens": 1200000, "outputTokens": 40000,
             "cacheReadTokens": 900000, "cacheCreationTokens": 100000,
             "totalTokens": 1240000, "uncachedTokens": 300000, "requests": 210},
            {"key": "2026-08-16", "inputTokens": 5100000, "outputTokens": 120000,
             "cacheReadTokens": 4000000, "cacheCreationTokens": 500000,
             "totalTokens": 5220000, "uncachedTokens": 1100000, "requests": 720}
          ],
          "byAgent": [
            {"key": "claude", "inputTokens": 8600000, "outputTokens": 220000,
             "cacheReadTokens": 7000000, "cacheCreationTokens": 800000,
             "totalTokens": 8820000, "uncachedTokens": 1600000, "requests": 1300}
          ],
          "byModel": [
            {"key": "claude-sonnet-4-5", "inputTokens": 8600000, "outputTokens": 220000,
             "cacheReadTokens": 7000000, "cacheCreationTokens": 800000,
             "totalTokens": 8820000, "uncachedTokens": 1600000, "requests": 1300,
             "futureField": {"nested": true}}
          ],
          "updatedAt": 1755600000000,
          "unknownTopLevel": "ignored"
        }
        """)

        #expect(summary.range.from == 1_754_995_200_000)
        #expect(summary.range.to == 1_755_600_000_000)
        #expect(summary.totals.totalTokens == 12_710_000)
        #expect(summary.totals.uncachedTokens == 2_600_000)
        #expect(summary.totals.sessions == 23)
        #expect(summary.daily.map(\.key) == ["2026-08-12", "2026-08-16"])
        #expect(summary.daily[1].requests == 720)
        #expect(summary.byAgent.count == 1)
        #expect(summary.byAgent[0].key == "claude")
        #expect(summary.byModel.count == 1)
        #expect(summary.byModel[0].totalTokens == 8_820_000)
        #expect(summary.updatedAt == 1_755_600_000_000)
    }

    @Test func rangeAllCarriesANullFromAndTokenCountsMayExceedInt32() throws {
        let summary = try decode(UsageSummaryResponse.self, """
        {
          "range": {"from": null, "to": 1755600000000},
          "totals": {
            "inputTokens": 5100000000,
            "outputTokens": 200000000,
            "cacheReadTokens": 4000000000,
            "cacheCreationTokens": 300000000,
            "totalTokens": 5300000000,
            "uncachedTokens": 1100000000,
            "requests": 250000,
            "sessions": 4100
          },
          "daily": [],
          "byAgent": [],
          "byModel": [],
          "updatedAt": 1755600000000
        }
        """)

        #expect(summary.range.from == nil)
        #expect(summary.totals.totalTokens == 5_300_000_000)
        #expect(summary.totals.totalTokens > Int(Int32.max))
        #expect(summary.daily.isEmpty)
    }

    @Test func decodesSqliteStorageUsage() throws {
        let storage = try decode(SqliteStorageUsageResponse.self, """
        {
          "path": "/home/hapi/.hapi/hapi.db",
          "databaseBytes": 84930560,
          "walBytes": 4194304,
          "shmBytes": 32768,
          "totalBytes": 89157632,
          "futureField": 1
        }
        """)

        #expect(storage.path == "/home/hapi/.hapi/hapi.db")
        #expect(storage.databaseBytes == 84_930_560)
        #expect(storage.walBytes == 4_194_304)
        #expect(storage.shmBytes == 32_768)
        #expect(storage.totalBytes == 89_157_632)
    }
}
