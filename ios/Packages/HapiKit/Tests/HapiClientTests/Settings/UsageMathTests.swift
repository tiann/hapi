import Foundation
import HapiClient
import HapiProtocol
import Testing

/// Tile/format derivations — thresholds mirror the web reference
/// (`formatTokens` in `usage.tsx`, `formatFileSize` in `file-metadata.ts`).
/// Transcribed from the Android `UsageMathTest`.
@Suite("UsageMath")
struct UsageMathTests {

    // MARK: - formatTokens

    @Test func tokenFormattingMirrorsTheWebThresholds() {
        #expect(UsageMath.formatTokens(0) == "0")
        #expect(UsageMath.formatTokens(999) == "999")
        #expect(UsageMath.formatTokens(1_000) == "1.0K")
        #expect(UsageMath.formatTokens(1_234) == "1.2K")
        #expect(UsageMath.formatTokens(9_999) == "10.0K")
        #expect(UsageMath.formatTokens(10_000) == "10K")
        #expect(UsageMath.formatTokens(999_999) == "1000K")
        #expect(UsageMath.formatTokens(1_500_000) == "1.5M")
        #expect(UsageMath.formatTokens(9_999_999) == "10.0M")
        #expect(UsageMath.formatTokens(12_000_000) == "12M")
        #expect(UsageMath.formatTokens(2_300_000_000) == "2.3B")
    }

    // MARK: - formatBytes

    @Test func byteFormattingMirrorsTheWebFormatFileSize() {
        #expect(UsageMath.formatBytes(0) == "0 B")
        #expect(UsageMath.formatBytes(512) == "512 B")
        #expect(UsageMath.formatBytes(1_024) == "1 KB")
        #expect(UsageMath.formatBytes(1_536) == "1.5 KB")
        // < 10 keeps one decimal, trailing .0 stripped; >= 10 rounds whole.
        #expect(UsageMath.formatBytes(10_186) == "9.9 KB")
        #expect(UsageMath.formatBytes(10_240) == "10 KB")
        #expect(UsageMath.formatBytes(4_194_304) == "4 MB")
        #expect(UsageMath.formatBytes(84_930_560) == "81 MB")
        #expect(UsageMath.formatBytes(2_147_483_648) == "2 GB")
        #expect(UsageMath.formatBytes(-5) == "0 B")
    }

    // MARK: - cacheHitRate

    private func totals(input: Int, cacheRead: Int) -> UsageSummaryTotals {
        UsageSummaryTotals(
            inputTokens: input,
            outputTokens: 0,
            cacheReadTokens: cacheRead,
            cacheCreationTokens: 0,
            totalTokens: input,
            uncachedTokens: input - cacheRead,
            requests: 1,
            sessions: 1
        )
    }

    @Test func cacheHitRateIsCacheReadOverInputWithOneDecimal() {
        #expect(UsageMath.cacheHitRate(totals(input: 12_400_000, cacheRead: 9_800_000)) == "79.0%")
        #expect(UsageMath.cacheHitRate(totals(input: 5, cacheRead: 5)) == "100.0%")
        #expect(UsageMath.cacheHitRate(totals(input: 3, cacheRead: 1)) == "33.3%")
    }

    @Test func cacheHitRateDegradesToZeroPercentWithoutInputTokens() {
        #expect(UsageMath.cacheHitRate(totals(input: 0, cacheRead: 0)) == "0%")
    }

    // MARK: - dailyBars

    private func bucket(_ key: String, total: Int) -> UsageSummaryBucket {
        UsageSummaryBucket(
            key: key,
            inputTokens: total,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: total,
            uncachedTokens: total,
            requests: 1
        )
    }

    @Test func boundedRangesFillTheCalendarWindowEndingToday() {
        let sparse = [bucket("2026-08-13", total: 5), bucket("2026-08-18", total: 9)]

        let bars = UsageMath.dailyBars(daily: sparse, days: 7, todayKey: "2026-08-18")

        #expect(bars.count == 7)
        #expect(bars.first?.key == "2026-08-12")
        #expect(bars.last?.key == "2026-08-18")
        #expect(bars.first?.totalTokens == 0)
        #expect(bars.first?.bucket == nil)
        #expect(bars[1].totalTokens == 5)
        #expect(bars.last?.totalTokens == 9)
        #expect(bars.last?.bucket == sparse[1])
    }

    @Test func rangeAllKeepsTheSparseBucketsAsIs() {
        let sparse = [bucket("2025-01-01", total: 3), bucket("2026-08-18", total: 4)]
        let bars = UsageMath.dailyBars(daily: sparse, days: nil, todayKey: "2026-08-18")
        #expect(bars.map(\.key) == ["2025-01-01", "2026-08-18"])
        #expect(bars.map(\.totalTokens) == [3, 4])
    }

    @Test func calendarFillSpansMonthBoundaries() {
        let bars = UsageMath.dailyBars(daily: [], days: 30, todayKey: "2026-03-05")
        #expect(bars.count == 30)
        #expect(bars.first?.key == "2026-02-04")
        #expect(bars.last?.key == "2026-03-05")
    }

    @Test func calendarFillHandlesLeapFebruary() {
        let bars = UsageMath.dailyBars(daily: [], days: 7, todayKey: "2024-03-01")
        #expect(bars.map(\.key) == [
            "2024-02-24", "2024-02-25", "2024-02-26", "2024-02-27",
            "2024-02-28", "2024-02-29", "2024-03-01",
        ])
    }

    @Test func calendarFillSpansYearBoundaries() {
        let bars = UsageMath.dailyBars(daily: [], days: 7, todayKey: "2026-01-03")
        #expect(bars.first?.key == "2025-12-28")
        #expect(bars.last?.key == "2026-01-03")
    }

    @Test func corruptTodayKeyDegradesToTheSparseMapping() {
        let sparse = [bucket("2026-08-18", total: 4)]
        let bars = UsageMath.dailyBars(daily: sparse, days: 7, todayKey: "not-a-day")
        #expect(bars.map(\.key) == ["2026-08-18"])
    }

    // MARK: - todayKey

    @Test func todayKeyUsesTheGivenZonesCalendarDay() throws {
        // 2026-08-17T20:00:00Z.
        let now = Date(timeIntervalSince1970: 1_786_996_800)
        let utc = try #require(TimeZone(identifier: "UTC"))
        let shanghai = try #require(TimeZone(identifier: "Asia/Shanghai"))
        #expect(UsageMath.todayKey(now: now, timeZone: utc) == "2026-08-17")
        // UTC+8 has already rolled to the next day.
        #expect(UsageMath.todayKey(now: now, timeZone: shanghai) == "2026-08-18")
    }

    // MARK: - shortDayLabel

    @Test func shortDayLabelsDropTheYear() {
        #expect(UsageMath.shortDayLabel("2026-08-18") == "08-18")
        #expect(UsageMath.shortDayLabel("odd-key") == "odd-key")
    }
}
