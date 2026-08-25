import Foundation
import HapiProtocol

/// Wire values of the usage dashboard's `range` query param (web `UsageRange`).
public enum UsageRange: String, CaseIterable, Sendable {
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case all = "all"

    /// Calendar window length for the daily-bar fill; `nil` = unbounded.
    public var days: Int? {
        switch self {
        case .sevenDays: return 7
        case .thirtyDays: return 30
        case .all: return nil
        }
    }
}

/// Pure derivations behind the usage/storage dashboards — formatting twins of
/// the web reference (`web/src/routes/settings/usage.tsx` `formatTokens`,
/// `web/src/lib/file-metadata.ts` `formatFileSize`) via the Android port
/// (`feature/settings/UsageMath.kt`), plus the daily-bar series builder.
/// Kept view-free so `swift test` covers it.
public enum UsageMath {

    /// `1234` → `1.2K`, `4560000` → `4.6M` … (web `formatTokens` thresholds).
    public static func formatTokens(_ value: Int) -> String {
        if value < 1_000 {
            return String(value)
        }
        if value < 1_000_000 {
            return fixed(Double(value) / 1_000, decimals: value < 10_000 ? 1 : 0) + "K"
        }
        if value < 1_000_000_000 {
            return fixed(Double(value) / 1_000_000, decimals: value < 10_000_000 ? 1 : 0) + "M"
        }
        return fixed(Double(value) / 1_000_000_000, decimals: 1) + "B"
    }

    /// `87231` → `85.2 KB` (web `formatFileSize`): 1024 steps, ≥ 10 rounds to
    /// an integer, < 10 keeps one decimal with a trailing `.0` stripped.
    public static func formatBytes(_ bytes: Int) -> String {
        if bytes < 0 { return "0 B" }
        if bytes < 1024 { return "\(bytes) B" }
        let unitIndex = min(
            Int(floor(log(Double(bytes)) / log(1024))),
            byteUnits.count - 1
        )
        let value = Double(bytes) / pow(1024, Double(unitIndex))
        let formatted: String
        if value >= 10 {
            // Half-up like the web's Math.round (positive values only here).
            formatted = String(Int(value.rounded(.toNearestOrAwayFromZero)))
        } else {
            let oneDecimal = fixed(value, decimals: 1)
            formatted = oneDecimal.hasSuffix(".0") ? String(oneDecimal.dropLast(2)) : oneDecimal
        }
        return "\(formatted) \(byteUnits[unitIndex])"
    }

    /// `cacheReadTokens / inputTokens` as `"37.4%"`; `"0%"` without input.
    public static func cacheHitRate(_ totals: UsageSummaryTotals) -> String {
        guard totals.inputTokens > 0 else { return "0%" }
        let percent = Double(totals.cacheReadTokens) * 100 / Double(totals.inputTokens)
        return fixed(percent, decimals: 1) + "%"
    }

    /// One bar of the daily chart; ``bucket`` is nil for a zero-usage fill day.
    public struct DailyBar: Equatable, Sendable, Identifiable {
        /// `YYYY-MM-DD` in the summary's timeZone.
        public let key: String
        public let totalTokens: Int
        public let bucket: UsageSummaryBucket?

        public var id: String { key }

        public init(key: String, totalTokens: Int, bucket: UsageSummaryBucket? = nil) {
            self.key = key
            self.totalTokens = totalTokens
            self.bucket = bucket
        }
    }

    /// Bars for the daily chart. The hub's `daily` list is sparse (only days
    /// with usage); a bounded range (`days` = 7/30) is filled to a complete
    /// calendar window ending `todayKey` so the time axis is honest.
    /// `range=all` (`days` = nil) keeps the sparse buckets as-is — the span
    /// is unbounded. An unparseable `todayKey` degrades to the sparse
    /// mapping rather than an empty chart.
    public static func dailyBars(
        daily: [UsageSummaryBucket],
        days: Int?,
        todayKey: String
    ) -> [DailyBar] {
        guard let days, let today = GregorianDay(key: todayKey) else {
            return daily.map { DailyBar(key: $0.key, totalTokens: $0.totalTokens, bucket: $0) }
        }
        var byKey: [String: UsageSummaryBucket] = [:]
        for bucket in daily {
            byKey[bucket.key] = bucket
        }
        return stride(from: days - 1, through: 0, by: -1).map { offset in
            let key = today.adding(days: -offset).key
            let bucket = byKey[key]
            return DailyBar(key: key, totalTokens: bucket?.totalTokens ?? 0, bucket: bucket)
        }
    }

    /// `now` in `timeZone` as a `YYYY-MM-DD` key — the anchor for the
    /// calendar fill. The same zone must be sent as the `timeZone` query
    /// param so hub day buckets and the fill agree on day keys.
    public static func todayKey(now: Date = Date(), timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: now)
        guard let year = parts.year, let month = parts.month, let day = parts.day else {
            return "" // Unreachable for a Gregorian calendar; degrade safely.
        }
        return GregorianDay(year: year, month: month, day: day).key
    }

    /// `"2026-08-07"` → `"08-07"` for compact x-axis labels; junk passes
    /// through.
    public static func shortDayLabel(_ key: String) -> String {
        guard key.count == 10 else { return key }
        let dash = key.index(key.startIndex, offsetBy: 4)
        guard key[dash] == "-" else { return key }
        return String(key[key.index(after: dash)...])
    }

    /// JS `toFixed` twin: US decimal separator; half-up is close enough here
    /// (the reference values never land on exact binary ties).
    private static func fixed(_ value: Double, decimals: Int) -> String {
        String(format: "%.\(decimals)f", locale: Locale(identifier: "en_US_POSIX"), value)
    }

    private static let byteUnits = ["B", "KB", "MB", "GB", "TB"]
}

/// Calendar-day arithmetic on `YYYY-MM-DD` keys via Julian day numbers —
/// pure integer math, so the fill is deterministic and free of time-zone/DST
/// concerns (the zone was already applied when the key was formed).
struct GregorianDay: Equatable, Sendable {
    let year: Int
    let month: Int
    let day: Int

    init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// Parses a strict `YYYY-MM-DD` key; nil for anything else.
    init?(key: String) {
        let parts = key.components(separatedBy: "-")
        guard parts.count == 3,
              parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              (1...12).contains(month), (1...31).contains(day) else {
            return nil
        }
        self.init(year: year, month: month, day: day)
    }

    var key: String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    func adding(days offset: Int) -> GregorianDay {
        GregorianDay(julianDayNumber: julianDayNumber + offset)
    }

    // Standard Fliegel–Van Flandern conversions (valid for all CE dates).

    private var julianDayNumber: Int {
        let a = (14 - month) / 12
        let y = year + 4800 - a
        let m = month + 12 * a - 3
        return day + (153 * m + 2) / 5 + 365 * y + y / 4 - y / 100 + y / 400 - 32045
    }

    private init(julianDayNumber jdn: Int) {
        let a = jdn + 32044
        let b = (4 * a + 3) / 146097
        let c = a - 146097 * b / 4
        let d = (4 * c + 3) / 1461
        let e = c - 1461 * d / 4
        let m = (5 * e + 2) / 153
        self.day = e - (153 * m + 2) / 5 + 1
        self.month = m + 3 - 12 * (m / 10)
        self.year = 100 * b + d - 4800 + m / 10
    }
}
