package app.hapi.protocol.wire

import kotlinx.serialization.Serializable

/**
 * Wire types of the owner-only usage/storage dashboards
 * (`docs/api/client-contract/rest.md#usage--storage-owner-only`;
 * `UsageSummaryResponse` / `SqliteStorageUsageResponse` in
 * `shared/src/apiTypes.ts`). Both endpoints answer `403` unless the caller's
 * namespace is `default` (hub owner).
 *
 * Token counts are [Long]: `range=all` totals over a long-lived hub can pass
 * 2^31.
 */

/** One aggregation bucket (a day / an agent / a model), keyed by [key]. */
@Serializable
data class UsageSummaryBucket(
    /** Day buckets: `YYYY-MM-DD` in the requested timeZone; else agent/model id. */
    val key: String,
    val inputTokens: Long,
    val outputTokens: Long,
    val cacheReadTokens: Long,
    val cacheCreationTokens: Long,
    val totalTokens: Long,
    /** Input that missed the cache: `inputTokens - cacheReadTokens`. */
    val uncachedTokens: Long,
    val requests: Long,
)

/** Epoch-ms window the summary covers; [from] is null for `range=all`. */
@Serializable
data class UsageSummaryRange(
    val from: Long? = null,
    val to: Long? = null,
)

/** Grand totals over the window (bucket counters + distinct [sessions]). */
@Serializable
data class UsageSummaryTotals(
    val inputTokens: Long,
    val outputTokens: Long,
    val cacheReadTokens: Long,
    val cacheCreationTokens: Long,
    val totalTokens: Long,
    val uncachedTokens: Long,
    val requests: Long,
    val sessions: Long,
)

/**
 * `GET /api/usage/summary?range=7d|30d|all&timeZone=<IANA>`.
 *
 * [daily] is ascending by key and **sparse** — only days with usage appear.
 * [byAgent]/[byModel] are sorted by descending [UsageSummaryBucket.totalTokens]
 * (the web dashboard shows the top 8).
 */
@Serializable
data class UsageSummaryResponse(
    val range: UsageSummaryRange,
    val totals: UsageSummaryTotals,
    val daily: List<UsageSummaryBucket>,
    val byAgent: List<UsageSummaryBucket>,
    val byModel: List<UsageSummaryBucket>,
    val updatedAt: Long,
)

/** The quota route reports percentage points and optional epoch-millisecond reset dates. */
@Serializable
data class AgentQuotaBucket(
    val label: String,
    val remainingPercent: Double,
    val usedPercent: Double,
    val resetsAt: Long? = null,
)

@Serializable
data class AgentQuotaAccount(
    val agent: String,
    val available: Boolean,
    val status: String,
    val buckets: List<AgentQuotaBucket>,
    val planLabel: String? = null,
    val accountLabel: String? = null,
    val creditsLabel: String? = null,
    val note: String? = null,
)

@Serializable
data class UsageMachineQuotas(
    val machineId: String,
    val machineName: String,
    val supported: Boolean,
    val accounts: List<AgentQuotaAccount>,
    val error: String? = null,
)

@Serializable
data class UsageQuotasResponse(val machines: List<UsageMachineQuotas>)

/** `GET /api/storage/sqlite` — hub database file sizes in bytes. */
@Serializable
data class SqliteStorageUsageResponse(
    val path: String,
    val databaseBytes: Long,
    val walBytes: Long,
    val shmBytes: Long,
    val totalBytes: Long,
)
