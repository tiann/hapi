import Foundation

/// `AttachedJobStatus` (`shared/src/schemas.ts`). Open-ended on decode so a
/// status this client does not know cannot fail the whole session list; only
/// `running` means live work.
public struct AttachedJobStatus: RawRepresentable, Codable, Hashable, Sendable {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let running = AttachedJobStatus(rawValue: "running")
    public static let completed = AttachedJobStatus(rawValue: "completed")
    public static let failed = AttachedJobStatus(rawValue: "failed")
}

/// Session-attached long-running work (tiann/hapi#1404): the primary job on a
/// `SessionSummary`, independent of agent `active` / `thinking` — work that
/// outlives the agent. Mirrors `AttachedJobSchema`; supervisor-only fields
/// (`runId`, wake options) are not decoded.
public struct AttachedJob: Codable, Equatable, Sendable {
    public var key: String
    public var label: String
    public var status: AttachedJobStatus
    public var done: Double?
    public var total: Double?
    public var remaining: Double?
    public var unit: String?
    public var detail: String?
    public var heartbeatAt: Int
    public var startedAt: Int
    public var updatedAt: Int

    public init(
        key: String,
        label: String,
        status: AttachedJobStatus = .running,
        done: Double? = nil,
        total: Double? = nil,
        remaining: Double? = nil,
        unit: String? = nil,
        detail: String? = nil,
        heartbeatAt: Int,
        startedAt: Int,
        updatedAt: Int
    ) {
        self.key = key
        self.label = label
        self.status = status
        self.done = done
        self.total = total
        self.remaining = remaining
        self.unit = unit
        self.detail = detail
        self.heartbeatAt = heartbeatAt
        self.startedAt = startedAt
        self.updatedAt = updatedAt
    }

    /// No heartbeat for this long: the row turns amber but keeps its progress
    /// (web `ATTACHED_JOB_STALE_MS`).
    public static let staleAfterMs = 15 * 60 * 1000

    public var isRunning: Bool { status == .running }

    public func isStale(nowMs: Int) -> Bool {
        nowMs - heartbeatAt > Self.staleAfterMs
    }

    /// Whole percent from `done`/`total`, capped at 100; `nil` without a
    /// positive total. `remaining` takes precedence in labels (web
    /// `formatAttachedJobProgress`), so callers check it first.
    public var percent: Int? {
        guard let done, let total, total > 0 else { return nil }
        return min(100, Int((done / total * 100).rounded()))
    }
}

/// Lettered elapsed time for list chrome, at most two units (web
/// `formatCompactElapsed`), never an ETA. Rows tick per minute, so anything
/// under a minute reads `<1m` rather than a seconds count that would freeze.
public func formatCompactElapsed(ms elapsedMs: Int) -> String {
    guard elapsedMs >= 60_000 else { return "<1m" }
    let totalMinutes = elapsedMs / 60_000
    if totalMinutes < 60 { return "\(totalMinutes)m" }
    let hours = totalMinutes / 60
    let minutes = totalMinutes % 60
    if hours < 24 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
    let days = hours / 24
    let remainingHours = hours % 24
    return remainingHours > 0 ? "\(days)d \(remainingHours)h" : "\(days)d"
}

/// Progress counts as the hub sent them: integers without a decimal point.
public func formatJobQuantity(_ value: Double) -> String {
    if value.rounded() == value, abs(value) < 1e15 { return String(Int(value)) }
    return String(value)
}
