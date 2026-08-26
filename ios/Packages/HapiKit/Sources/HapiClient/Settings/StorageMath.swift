import Foundation
import HapiProtocol

/// Donut geometry for the sqlite storage chart — the Swift twin of
/// `web/src/components/settings/storageUsageSlices.ts` (same fixed slice
/// order, zero-byte filtering, 12-o'clock start, one-decimal percents) via
/// the Android port (`feature/settings/StorageMath.kt`).
///
/// The iOS chart itself is a Swift Charts `SectorMark`, which derives its own
/// proportions from ``Slice/bytes``; the precomputed angles keep the geometry
/// contract test-locked against the web reference regardless.
public enum StorageMath {

    public enum SliceKey: CaseIterable, Sendable {
        case database
        case wal
        case shm
    }

    public struct Slice: Equatable, Sendable {
        public let key: SliceKey
        public let bytes: Int
        /// Share of the drawn total, one decimal (e.g. `97.3`).
        public let percent: Double
        /// Degrees, `-90` = 12 o'clock, clockwise.
        public let startAngle: Double
        public let endAngle: Double

        public init(key: SliceKey, bytes: Int, percent: Double, startAngle: Double, endAngle: Double) {
            self.key = key
            self.bytes = bytes
            self.percent = percent
            self.startAngle = startAngle
            self.endAngle = endAngle
        }
    }

    /// Fixed entity order — colors follow the entity, never its rank.
    private static let sliceOrder: [SliceKey] = [.database, .wal, .shm]

    private static let fullCircle = 360.0

    /// Start at 12 o'clock so the first slice reads top-heavy on mobile.
    public static let startAngle = -90.0

    /// Slices for the donut: zero-byte files are dropped, angles partition
    /// the full circle exactly (the last slice absorbs rounding), empty when
    /// nothing is drawn.
    public static func slices(_ usage: SqliteStorageUsageResponse) -> [Slice] {
        let entries = sliceOrder
            .map { key in (key: key, bytes: max(bytes(of: usage, for: key), 0)) }
            .filter { $0.bytes > 0 }
        let total = entries.reduce(0) { $0 + $1.bytes }
        guard total > 0 else { return [] }

        var cursor = startAngle
        var slices: [Slice] = []
        for (index, entry) in entries.enumerated() {
            let isLast = index == entries.count - 1
            let endAngle = isLast
                ? startAngle + fullCircle
                : cursor + Double(entry.bytes) / Double(total) * fullCircle
            slices.append(Slice(
                key: entry.key,
                bytes: entry.bytes,
                // Half-up like JS Math.round (positive values only here).
                percent: (Double(entry.bytes) * 1000 / Double(total))
                    .rounded(.toNearestOrAwayFromZero) / 10,
                startAngle: cursor,
                endAngle: endAngle
            ))
            cursor = endAngle
        }
        return slices
    }

    /// `97.25` → `"97.3%"` (web `formatStoragePercent`, half-up); whole
    /// numbers drop the decimal (`75.0` → `"75%"`).
    public static func formatPercent(_ percent: Double) -> String {
        let rounded = (percent * 10).rounded(.toNearestOrAwayFromZero) / 10
        if rounded.truncatingRemainder(dividingBy: 1) == 0 {
            return "\(Int(rounded))%"
        }
        return String(format: "%.1f%%", locale: Locale(identifier: "en_US_POSIX"), rounded)
    }

    private static func bytes(of usage: SqliteStorageUsageResponse, for key: SliceKey) -> Int {
        switch key {
        case .database: return usage.databaseBytes
        case .wal: return usage.walBytes
        case .shm: return usage.shmBytes
        }
    }
}
