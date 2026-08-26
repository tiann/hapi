import Foundation

// Wire types of the owner-only usage/storage dashboards
// (`docs/api/client-contract/rest.md#usage--storage-owner-only`;
// `UsageSummaryResponse` / `SqliteStorageUsageResponse` in
// `shared/src/apiTypes.ts`). Both endpoints answer `403` unless the caller's
// namespace is `default` (hub owner).
//
// Token counts are `Int` — 64-bit on every Apple platform, so `range=all`
// totals over a long-lived hub (past 2^31) decode fine.

/// One aggregation bucket (a day / an agent / a model), keyed by ``key``.
public struct UsageSummaryBucket: Codable, Equatable, Sendable {
    /// Day buckets: `YYYY-MM-DD` in the requested timeZone; else agent/model id.
    public var key: String
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheCreationTokens: Int
    public var totalTokens: Int
    /// Input that missed the cache: `inputTokens - cacheReadTokens`.
    public var uncachedTokens: Int
    public var requests: Int

    public init(
        key: String,
        inputTokens: Int,
        outputTokens: Int,
        cacheReadTokens: Int,
        cacheCreationTokens: Int,
        totalTokens: Int,
        uncachedTokens: Int,
        requests: Int
    ) {
        self.key = key
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreationTokens = cacheCreationTokens
        self.totalTokens = totalTokens
        self.uncachedTokens = uncachedTokens
        self.requests = requests
    }
}

/// Epoch-ms window the summary covers; ``from`` is null for `range=all`.
public struct UsageSummaryRange: Codable, Equatable, Sendable {
    public var from: Int?
    public var to: Int?

    public init(from: Int? = nil, to: Int? = nil) {
        self.from = from
        self.to = to
    }
}

/// Grand totals over the window (bucket counters + distinct ``sessions``).
public struct UsageSummaryTotals: Codable, Equatable, Sendable {
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheCreationTokens: Int
    public var totalTokens: Int
    public var uncachedTokens: Int
    public var requests: Int
    public var sessions: Int

    public init(
        inputTokens: Int,
        outputTokens: Int,
        cacheReadTokens: Int,
        cacheCreationTokens: Int,
        totalTokens: Int,
        uncachedTokens: Int,
        requests: Int,
        sessions: Int
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreationTokens = cacheCreationTokens
        self.totalTokens = totalTokens
        self.uncachedTokens = uncachedTokens
        self.requests = requests
        self.sessions = sessions
    }
}

/// Body of `GET /api/usage/summary?range=7d|30d|all&timeZone=<IANA>`.
///
/// ``daily`` is ascending by key and **sparse** — only days with usage appear.
/// ``byAgent``/``byModel`` are sorted by descending
/// ``UsageSummaryBucket/totalTokens`` (the dashboards show the top 8).
public struct UsageSummaryResponse: Codable, Equatable, Sendable {
    public var range: UsageSummaryRange
    public var totals: UsageSummaryTotals
    public var daily: [UsageSummaryBucket]
    public var byAgent: [UsageSummaryBucket]
    public var byModel: [UsageSummaryBucket]
    public var updatedAt: Int

    public init(
        range: UsageSummaryRange,
        totals: UsageSummaryTotals,
        daily: [UsageSummaryBucket],
        byAgent: [UsageSummaryBucket],
        byModel: [UsageSummaryBucket],
        updatedAt: Int
    ) {
        self.range = range
        self.totals = totals
        self.daily = daily
        self.byAgent = byAgent
        self.byModel = byModel
        self.updatedAt = updatedAt
    }
}

/// Body of `GET /api/storage/sqlite` — hub database file sizes in bytes.
public struct SqliteStorageUsageResponse: Codable, Equatable, Sendable {
    public var path: String
    public var databaseBytes: Int
    public var walBytes: Int
    public var shmBytes: Int
    public var totalBytes: Int

    public init(path: String, databaseBytes: Int, walBytes: Int, shmBytes: Int, totalBytes: Int) {
        self.path = path
        self.databaseBytes = databaseBytes
        self.walBytes = walBytes
        self.shmBytes = shmBytes
        self.totalBytes = totalBytes
    }
}
