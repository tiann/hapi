package app.hapi.companion.feature.settings

import app.hapi.protocol.wire.UsageSummaryBucket
import app.hapi.protocol.wire.UsageSummaryTotals
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Tile/format derivations — thresholds mirror the web reference
 * (`formatTokens` in `usage.tsx`, `formatFileSize` in `file-metadata.ts`).
 */
class UsageMathTest {

    // ------------------------------------------------------- formatTokens --

    @Test
    fun `token formatting mirrors the web thresholds`() {
        assertEquals("0", UsageMath.formatTokens(0))
        assertEquals("999", UsageMath.formatTokens(999))
        assertEquals("1.0K", UsageMath.formatTokens(1_000))
        assertEquals("1.2K", UsageMath.formatTokens(1_234))
        assertEquals("10.0K", UsageMath.formatTokens(9_999))
        assertEquals("10K", UsageMath.formatTokens(10_000))
        assertEquals("1000K", UsageMath.formatTokens(999_999))
        assertEquals("1.5M", UsageMath.formatTokens(1_500_000))
        assertEquals("10.0M", UsageMath.formatTokens(9_999_999))
        assertEquals("12M", UsageMath.formatTokens(12_000_000))
        assertEquals("2.3B", UsageMath.formatTokens(2_300_000_000))
    }

    // -------------------------------------------------------- formatBytes --

    @Test
    fun `byte formatting mirrors the web formatFileSize`() {
        assertEquals("0 B", UsageMath.formatBytes(0))
        assertEquals("512 B", UsageMath.formatBytes(512))
        assertEquals("1 KB", UsageMath.formatBytes(1_024))
        assertEquals("1.5 KB", UsageMath.formatBytes(1_536))
        // < 10 keeps one decimal, trailing .0 stripped; >= 10 rounds whole.
        assertEquals("9.9 KB", UsageMath.formatBytes(10_186))
        assertEquals("10 KB", UsageMath.formatBytes(10_240))
        assertEquals("4 MB", UsageMath.formatBytes(4_194_304))
        assertEquals("81 MB", UsageMath.formatBytes(84_930_560))
        assertEquals("2 GB", UsageMath.formatBytes(2_147_483_648))
        assertEquals("0 B", UsageMath.formatBytes(-5))
    }

    // ------------------------------------------------------- cacheHitRate --

    private fun totals(input: Long, cacheRead: Long): UsageSummaryTotals = UsageSummaryTotals(
        inputTokens = input,
        outputTokens = 0,
        cacheReadTokens = cacheRead,
        cacheCreationTokens = 0,
        totalTokens = input,
        uncachedTokens = input - cacheRead,
        requests = 1,
        sessions = 1,
    )

    @Test
    fun `cache hit rate is cacheRead over input with one decimal`() {
        assertEquals("79.0%", UsageMath.cacheHitRate(totals(input = 12_400_000, cacheRead = 9_800_000)))
        assertEquals("100.0%", UsageMath.cacheHitRate(totals(input = 5, cacheRead = 5)))
        assertEquals("33.3%", UsageMath.cacheHitRate(totals(input = 3, cacheRead = 1)))
    }

    @Test
    fun `cache hit rate degrades to 0 percent without input tokens`() {
        assertEquals("0%", UsageMath.cacheHitRate(totals(input = 0, cacheRead = 0)))
    }

    // ---------------------------------------------------------- dailyBars --

    private fun bucket(key: String, total: Long): UsageSummaryBucket = UsageSummaryBucket(
        key = key,
        inputTokens = total,
        outputTokens = 0,
        cacheReadTokens = 0,
        cacheCreationTokens = 0,
        totalTokens = total,
        uncachedTokens = total,
        requests = 1,
    )

    @Test
    fun `bounded ranges fill the calendar window ending today`() {
        val today = LocalDate.of(2026, 8, 18)
        val sparse = listOf(bucket("2026-08-13", 5), bucket("2026-08-18", 9))

        val bars = UsageMath.dailyBars(sparse, days = 7, today = today)

        assertEquals(7, bars.size)
        assertEquals("2026-08-12", bars.first().key)
        assertEquals("2026-08-18", bars.last().key)
        assertEquals(0, bars.first().totalTokens)
        assertNull(bars.first().bucket)
        assertEquals(5, bars[1].totalTokens)
        assertEquals(9, bars.last().totalTokens)
        assertEquals(sparse[1], bars.last().bucket)
    }

    @Test
    fun `range=all keeps the sparse buckets as-is`() {
        val sparse = listOf(bucket("2025-01-01", 3), bucket("2026-08-18", 4))
        val bars = UsageMath.dailyBars(sparse, days = null, today = LocalDate.of(2026, 8, 18))
        assertEquals(listOf("2025-01-01", "2026-08-18"), bars.map { it.key })
        assertEquals(listOf(3L, 4L), bars.map { it.totalTokens })
    }

    @Test
    fun `calendar fill spans month boundaries`() {
        val bars = UsageMath.dailyBars(emptyList(), days = 30, today = LocalDate.of(2026, 3, 5))
        assertEquals(30, bars.size)
        assertEquals("2026-02-04", bars.first().key)
        assertEquals("2026-03-05", bars.last().key)
    }

    // --------------------------------------------------------- barIndexAt --

    @Test
    fun `tap x maps to bar slots with edges clamped`() {
        assertEquals(0, UsageMath.barIndexAt(0f, width = 700f, count = 7))
        assertEquals(0, UsageMath.barIndexAt(99.9f, width = 700f, count = 7))
        assertEquals(1, UsageMath.barIndexAt(100f, width = 700f, count = 7))
        assertEquals(6, UsageMath.barIndexAt(699.9f, width = 700f, count = 7))
        assertNull(UsageMath.barIndexAt(700f, width = 700f, count = 7))
        assertNull(UsageMath.barIndexAt(-1f, width = 700f, count = 7))
        assertNull(UsageMath.barIndexAt(10f, width = 700f, count = 0))
        assertNull(UsageMath.barIndexAt(10f, width = 0f, count = 7))
    }

    @Test
    fun `short day labels drop the year`() {
        assertEquals("08-18", UsageMath.shortDayLabel("2026-08-18"))
        assertEquals("odd-key", UsageMath.shortDayLabel("odd-key"))
    }
}
