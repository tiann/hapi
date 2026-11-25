package app.hapi.protocol.wire

import kotlin.math.roundToInt
import kotlinx.serialization.Serializable

/**
 * Session-attached long-running work (tiann/hapi#1404): the primary job on a
 * [SessionSummary], independent of agent `active` / `thinking` — work that
 * outlives the agent. Mirrors `AttachedJobSchema` (`shared/src/schemas.ts`);
 * supervisor-only fields (`runId`, wake options) are ignored on decode.
 * [status] stays a string so a status this client does not know cannot fail
 * the whole list; only [STATUS_RUNNING] is live work.
 */
@Serializable
data class AttachedJob(
    val key: String,
    val label: String,
    val status: String = STATUS_RUNNING,
    val done: Double? = null,
    val total: Double? = null,
    val remaining: Double? = null,
    val unit: String? = null,
    val detail: String? = null,
    val heartbeatAt: Long,
    val startedAt: Long,
    val updatedAt: Long,
) {
    val isRunning: Boolean get() = status == STATUS_RUNNING

    /** No heartbeat for [STALE_AFTER_MS]: the row turns amber but keeps its progress. */
    fun isStale(nowMs: Long): Boolean = nowMs - heartbeatAt > STALE_AFTER_MS

    /**
     * Whole percent from `done`/`total`, capped at 100; null without a positive
     * total. `remaining` takes precedence in labels (web
     * `formatAttachedJobProgress`), so callers check it first.
     */
    val percent: Int?
        get() {
            val done = done ?: return null
            val total = total?.takeIf { it > 0 } ?: return null
            return minOf(100, (done / total * 100).roundToInt())
        }

    /**
     * Determinate bar fill in 0..1, or null for an indeterminate bar (web
     * `attachedJobFraction`: `remaining` wins over `done`/`total`).
     */
    val fraction: Float?
        get() {
            val total = total?.takeIf { it > 0 } ?: return null
            val done = remaining?.let { maxOf(0.0, total - it) } ?: done ?: return null
            return (done / total).coerceIn(0.0, 1.0).toFloat()
        }

    companion object {
        const val STATUS_RUNNING: String = "running"

        /** Web `ATTACHED_JOB_STALE_MS`. */
        const val STALE_AFTER_MS: Long = 15 * 60 * 1000L
    }
}

/**
 * Lettered elapsed time for list chrome, at most two units (web
 * `formatCompactElapsed`), never an ETA. Rows tick per minute, so anything
 * under a minute reads `<1m` rather than a seconds count that would freeze.
 */
fun formatCompactElapsed(elapsedMs: Long): String {
    if (elapsedMs < 60_000) return "<1m"
    val totalMinutes = elapsedMs / 60_000
    if (totalMinutes < 60) return "${totalMinutes}m"
    val hours = totalMinutes / 60
    val minutes = totalMinutes % 60
    if (hours < 24) return if (minutes > 0) "${hours}h ${minutes}m" else "${hours}h"
    val days = hours / 24
    val remainingHours = hours % 24
    return if (remainingHours > 0) "${days}d ${remainingHours}h" else "${days}d"
}

/** Progress counts as the hub sent them: integers without a decimal point. */
fun formatJobQuantity(value: Double): String =
    if (value % 1.0 == 0.0 && kotlin.math.abs(value) < 1e15) value.toLong().toString() else value.toString()
