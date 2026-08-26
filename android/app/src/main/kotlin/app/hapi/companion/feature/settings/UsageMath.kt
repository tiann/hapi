package app.hapi.companion.feature.settings

import app.hapi.protocol.wire.UsageSummaryBucket
import app.hapi.protocol.wire.UsageSummaryTotals
import java.time.LocalDate
import java.util.Locale
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.min
import kotlin.math.roundToLong

/**
 * Pure derivations behind the usage/storage dashboards — formatting twins of
 * the web reference (`web/src/routes/settings/usage.tsx` `formatTokens`,
 * `web/src/lib/file-metadata.ts` `formatFileSize`) plus the daily-bar series
 * builder. Kept view-free for JVM tests.
 */
object UsageMath {

    /** `1234` → `1.2K`, `4560000` → `4.6M` … (web `formatTokens` thresholds). */
    fun formatTokens(value: Long): String = when {
        value < 1_000 -> value.toString()
        value < 1_000_000 ->
            "${fixed(value / 1_000.0, decimals = if (value < 10_000) 1 else 0)}K"
        value < 1_000_000_000 ->
            "${fixed(value / 1_000_000.0, decimals = if (value < 10_000_000) 1 else 0)}M"
        else -> "${fixed(value / 1_000_000_000.0, decimals = 1)}B"
    }

    /**
     * `87231` → `85.2 KB` (web `formatFileSize`): 1024 steps, ≥ 10 rounds to
     * an integer, < 10 keeps one decimal with a trailing `.0` stripped.
     */
    fun formatBytes(bytes: Long): String {
        if (bytes < 0) return "0 B"
        if (bytes < 1024) return "$bytes B"
        val unitIndex = min(floor(ln(bytes.toDouble()) / ln(1024.0)).toInt(), BYTE_UNITS.lastIndex)
        val value = bytes / Math.pow(1024.0, unitIndex.toDouble())
        val formatted = if (value >= 10) {
            value.roundToLong().toString()
        } else {
            fixed(value, decimals = 1).removeSuffix(".0")
        }
        return "$formatted ${BYTE_UNITS[unitIndex]}"
    }

    /** `cacheReadTokens / inputTokens` as `"37.4%"`; `"0%"` when there is no input. */
    fun cacheHitRate(totals: UsageSummaryTotals): String =
        if (totals.inputTokens > 0) {
            "${fixed(totals.cacheReadTokens * 100.0 / totals.inputTokens, decimals = 1)}%"
        } else {
            "0%"
        }

    /** One bar of the daily chart; [bucket] is null for a zero-usage fill day. */
    data class DailyBar(
        /** `YYYY-MM-DD` in the summary's timeZone. */
        val key: String,
        val totalTokens: Long,
        val bucket: UsageSummaryBucket? = null,
    )

    /**
     * Bars for the daily chart. The hub's `daily` list is sparse (only days
     * with usage); a bounded range ([days] = 7/30) is filled to a complete
     * calendar window ending [today] so the time axis is honest. `range=all`
     * ([days] = null) keeps the sparse buckets as-is — the span is unbounded.
     */
    fun dailyBars(daily: List<UsageSummaryBucket>, days: Int?, today: LocalDate): List<DailyBar> {
        if (days == null) {
            return daily.map { DailyBar(key = it.key, totalTokens = it.totalTokens, bucket = it) }
        }
        val byKey = daily.associateBy { it.key }
        return (days - 1 downTo 0).map { offset ->
            val key = today.minusDays(offset.toLong()).toString()
            val bucket = byKey[key]
            DailyBar(key = key, totalTokens = bucket?.totalTokens ?: 0, bucket = bucket)
        }
    }

    /**
     * Bar slot under a tap at [x] px in a chart [width] px wide holding
     * [count] equal slots; null when outside `[0, width)` or the chart is empty.
     */
    fun barIndexAt(x: Float, width: Float, count: Int): Int? {
        if (count <= 0 || width <= 0f || x < 0f || x >= width) return null
        return min((x / (width / count)).toInt(), count - 1)
    }

    /** `"2026-08-07"` → `"08-07"` for compact x-axis labels; junk passes through. */
    fun shortDayLabel(key: String): String =
        if (key.length == 10 && key[4] == '-') key.substring(5) else key

    /** JS `toFixed` twin: US decimal separator, HALF_UP is close enough here. */
    private fun fixed(value: Double, decimals: Int): String =
        String.format(Locale.US, "%.${decimals}f", value)

    private val BYTE_UNITS = listOf("B", "KB", "MB", "GB", "TB")
}
