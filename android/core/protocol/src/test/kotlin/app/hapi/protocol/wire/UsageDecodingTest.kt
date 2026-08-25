package app.hapi.protocol.wire

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Decoding of the owner-only dashboard payloads (`GET /api/usage/summary`,
 * `GET /api/storage/sqlite`) — shaped like `hub/src/sync/usageService.ts`
 * output: sparse ascending `daily`, desc-sorted `byAgent`/`byModel`,
 * `range.from = null` on `range=all`, plus the [HapiJson] unknown-key rule.
 */
class UsageDecodingTest {

    @Test
    fun `decodes a realistic usage summary`() {
        val summary = HapiJson.decodeFromString(
            UsageSummaryResponse.serializer(),
            """
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
            """.trimIndent(),
        )

        assertEquals(1754995200000, summary.range.from)
        assertEquals(1755600000000, summary.range.to)
        assertEquals(12710000, summary.totals.totalTokens)
        assertEquals(2600000, summary.totals.uncachedTokens)
        assertEquals(23, summary.totals.sessions)
        assertEquals(listOf("2026-08-12", "2026-08-16"), summary.daily.map { it.key })
        assertEquals(720, summary.daily[1].requests)
        assertEquals("claude", summary.byAgent.single().key)
        assertEquals(8820000, summary.byModel.single().totalTokens)
        assertEquals(1755600000000, summary.updatedAt)
    }

    @Test
    fun `range=all carries a null from and token counts may exceed Int range`() {
        val summary = HapiJson.decodeFromString(
            UsageSummaryResponse.serializer(),
            """
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
            """.trimIndent(),
        )

        assertNull(summary.range.from)
        assertEquals(5_300_000_000, summary.totals.totalTokens)
        assertTrue(summary.totals.totalTokens > Int.MAX_VALUE.toLong())
        assertTrue(summary.daily.isEmpty())
    }

    @Test
    fun `decodes sqlite storage usage`() {
        val storage = HapiJson.decodeFromString(
            SqliteStorageUsageResponse.serializer(),
            """
            {
              "path": "/home/hapi/.hapi/hapi.db",
              "databaseBytes": 84930560,
              "walBytes": 4194304,
              "shmBytes": 32768,
              "totalBytes": 89157632,
              "futureField": 1
            }
            """.trimIndent(),
        )

        assertEquals("/home/hapi/.hapi/hapi.db", storage.path)
        assertEquals(84_930_560, storage.databaseBytes)
        assertEquals(4_194_304, storage.walBytes)
        assertEquals(32_768, storage.shmBytes)
        assertEquals(89_157_632, storage.totalBytes)
    }
}
