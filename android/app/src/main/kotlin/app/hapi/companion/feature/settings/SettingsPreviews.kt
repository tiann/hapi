package app.hapi.companion.feature.settings

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import app.hapi.companion.ui.theme.HapiTheme
import app.hapi.protocol.wire.SqliteStorageUsageResponse
import app.hapi.protocol.wire.UsageSummaryBucket
import app.hapi.protocol.wire.UsageSummaryRange
import app.hapi.protocol.wire.UsageSummaryResponse
import app.hapi.protocol.wire.UsageSummaryTotals
import java.time.LocalDate

/**
 * Compile-checked previews doubling as visual regressions for the B-M4e
 * dashboards: stat tiles, the daily bar chart, the ranked bar list, and the
 * storage donut — light, dark, and OLED.
 */

private fun bucket(
    key: String,
    input: Long,
    output: Long,
    cacheRead: Long = 0,
    cacheCreation: Long = 0,
    requests: Long = 10,
): UsageSummaryBucket = UsageSummaryBucket(
    key = key,
    inputTokens = input,
    outputTokens = output,
    cacheReadTokens = cacheRead,
    cacheCreationTokens = cacheCreation,
    totalTokens = input + output,
    uncachedTokens = input - cacheRead,
    requests = requests,
)

internal val SAMPLE_USAGE_SUMMARY: UsageSummaryResponse = UsageSummaryResponse(
    range = UsageSummaryRange(from = 1755000000000, to = 1755600000000),
    totals = UsageSummaryTotals(
        inputTokens = 12_400_000,
        outputTokens = 310_000,
        cacheReadTokens = 9_800_000,
        cacheCreationTokens = 1_100_000,
        totalTokens = 12_710_000,
        uncachedTokens = 2_600_000,
        requests = 1_842,
        sessions = 23,
    ),
    daily = listOf(
        bucket("2026-08-12", 1_200_000, 40_000, requests = 210),
        bucket("2026-08-13", 3_400_000, 90_000, requests = 480),
        bucket("2026-08-15", 900_000, 25_000, requests = 130),
        bucket("2026-08-16", 5_100_000, 120_000, requests = 720),
        bucket("2026-08-18", 1_800_000, 35_000, requests = 302),
    ),
    byAgent = listOf(
        bucket("claude", 8_600_000, 220_000, requests = 1_300),
        bucket("codex", 3_100_000, 70_000, requests = 420),
        bucket("gemini", 700_000, 20_000, requests = 122),
    ),
    byModel = listOf(
        bucket("claude-sonnet-4-5", 7_900_000, 190_000, requests = 1_150),
        bucket("gpt-5.1-codex", 3_100_000, 70_000, requests = 420),
        bucket("unknown", 1_400_000, 50_000, requests = 272),
    ),
    updatedAt = 1755600000000,
)

internal val SAMPLE_STORAGE_USAGE: SqliteStorageUsageResponse = SqliteStorageUsageResponse(
    path = "/home/hapi/.hapi/hapi.db",
    databaseBytes = 84_930_560,
    walBytes = 4_194_304,
    shmBytes = 32_768,
    totalBytes = 89_157_632,
)

private val SAMPLE_DAILY_BARS: List<UsageMath.DailyBar> =
    UsageMath.dailyBars(SAMPLE_USAGE_SUMMARY.daily, days = 7, today = LocalDate.of(2026, 8, 18))

@Preview(name = "Usage tiles", showBackground = true)
@Composable
private fun UsageStatTilesPreview() {
    HapiTheme(darkTheme = false, dynamicColor = false) {
        Surface { UsageStatTiles(summary = SAMPLE_USAGE_SUMMARY) }
    }
}

@Preview(name = "Daily bars", showBackground = true)
@Composable
private fun DailyBarChartPreview() {
    HapiTheme(darkTheme = false, dynamicColor = false) {
        Surface { DailyBarChart(bars = SAMPLE_DAILY_BARS, modifier = Modifier.padding(12.dp)) }
    }
}

@Preview(name = "Daily bars · dark", showBackground = true, backgroundColor = 0xFF1B1B1F)
@Composable
private fun DailyBarChartDarkPreview() {
    HapiTheme(darkTheme = true, dynamicColor = false) {
        Surface { DailyBarChart(bars = SAMPLE_DAILY_BARS, modifier = Modifier.padding(12.dp)) }
    }
}

@Preview(name = "Bar list", showBackground = true)
@Composable
private fun UsageBarListPreview() {
    HapiTheme(darkTheme = false, dynamicColor = false) {
        Surface { UsageBarList(rows = SAMPLE_USAGE_SUMMARY.byAgent) }
    }
}

@Preview(name = "Usage · full body", showBackground = true, heightDp = 1400)
@Composable
private fun UsageSummaryContentPreview() {
    HapiTheme(darkTheme = false, dynamicColor = false) {
        Surface {
            UsageSummaryContent(
                summary = SAMPLE_USAGE_SUMMARY,
                dailyBars = SAMPLE_DAILY_BARS,
            )
        }
    }
}

@Preview(name = "Storage donut", showBackground = true)
@Composable
private fun StorageCardPreview() {
    HapiTheme(darkTheme = false, dynamicColor = false) {
        Surface { StorageUsageCard(usage = SAMPLE_STORAGE_USAGE) }
    }
}

@Preview(name = "Storage donut · OLED", showBackground = true, backgroundColor = 0xFF000000)
@Composable
private fun StorageCardOledPreview() {
    HapiTheme(oled = true) {
        Surface { StorageUsageCard(usage = SAMPLE_STORAGE_USAGE) }
    }
}
