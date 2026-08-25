package app.hapi.protocol.wire

import kotlinx.serialization.Serializable

/**
 * Session-list row returned by `GET /api/sessions` (`SessionSummary`,
 * `shared/src/sessionSummary.ts`). Hub-computed projection of [Session]:
 * carries the version watermarks so list caches can gate structured SSE
 * patches without a detail query.
 */
@Serializable
data class SessionSummary(
    val id: String,
    val active: Boolean,
    val thinking: Boolean = false,
    val activeAt: Long = 0,
    val updatedAt: Long = 0,
    val pinned: Boolean? = null,
    val globalPinned: Boolean? = null,
    val metadata: SessionSummaryMetadata? = null,
    val metadataVersion: Long = 0,
    val agentStateVersion: Long = 0,
    val todosUpdatedAt: Long = 0,
    val todoProgress: TodoProgress? = null,
    /** Authoritative total — may exceed `pendingRequests.size` (capped at 5). */
    val pendingRequestsCount: Int = 0,
    /** `'permission'` / `'input'`, deduplicated. */
    val pendingRequestKinds: List<String> = emptyList(),
    /** Capped (≤ 5), oldest-first slice for per-row hover copy. */
    val pendingRequests: List<PendingRequest> = emptyList(),
    val backgroundTaskCount: Int = 0,
    val futureScheduledMessageCount: Int = 0,
    /** Epoch ms of the soonest uninvoked future scheduled message, or null. */
    val nextScheduledAt: Long? = null,
    val model: String? = null,
    val modelReasoningEffort: String? = null,
    val effort: String? = null,
)

/** `SessionSummaryMetadata` — list-sized metadata projection. */
@Serializable
data class SessionSummaryMetadata(
    val name: String? = null,
    val path: String,
    val machineId: String? = null,
    /** Summary text only — no `updatedAt` in the list projection. */
    val summary: SummaryText? = null,
    val flavor: String? = null,
    val worktree: WorktreeMetadata? = null,
    val agentSessionId: String? = null,
    val lifecycleState: String? = null,
    val hapiMcpUrl: String? = null,
)

@Serializable
data class SummaryText(
    val text: String,
)

@Serializable
data class TodoProgress(
    val completed: Int,
    val total: Int,
)

/**
 * One pending request in the capped summary slice (`PendingRequest`,
 * `shared/src/sessionSummary.ts`).
 */
@Serializable
data class PendingRequest(
    val id: String,
    /** `'permission' | 'input'`. */
    val kind: String,
    val tool: String,
    /** Epoch ms when raised (hub falls back to `session.updatedAt`). */
    val since: Long,
)
