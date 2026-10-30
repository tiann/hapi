package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.SessionSummary

/**
 * Running-session buckets — port of `bucketRunningSessions` /
 * `isPinnedInProgressSession` from `web/src/components/SessionList.tsx`.
 * Pure Kotlin so JVM tests pin the bucketing semantics without Compose.
 *
 * When the pin-in-progress view is on, connected sessions that are not
 * explicitly pinned float into sections above the plain list: working and
 * pending first, then quiet active sessions, then keepalive-only idlers
 * (tiann/hapi#1820 — a fleet of zombies must not read as a fleet of ready
 * sessions). Explicit pins stay above them.
 */

/** `SESSION_LIFECYCLE_IDLE` (`shared/src/sessionLifecycle.ts`). */
const val SESSION_LIFECYCLE_IDLE: String = "idle"

/** The four in-progress buckets, in render order. */
enum class RunningBucket { WORKING, PENDING, ACTIVE, IDLE }

/** Row lists per bucket: pinned first, then the buckets, then the rest. */
data class SessionBucketsUi(
    val pinned: List<SessionRowUi>,
    val working: List<SessionRowUi>,
    val pending: List<SessionRowUi>,
    val active: List<SessionRowUi>,
    val idle: List<SessionRowUi>,
    /** Sessions that do not float: disconnected (and not selected-pinned) rows. */
    val rest: List<SessionRowUi>,
)

object SessionBuckets {

    /** `isPinnedInProgressSession`: any connected session floats. */
    fun isPinnedInProgressSession(summary: SessionSummary): Boolean = summary.active

    /**
     * Which in-progress bucket a session floats into, or null when it stays
     * in the plain list — pinned rows keep their pinned section and
     * disconnected rows never float. Chain order matters: thinking or a
     * background task reads as "working" even while a permission request
     * pends; lifecycle `idle` only when otherwise quiet.
     */
    fun bucketOf(summary: SessionSummary): RunningBucket? {
        if (summary.globalPinned == true || summary.pinned == true) return null
        if (!summary.active) return null
        return when {
            summary.thinking || summary.backgroundTaskCount > 0 -> RunningBucket.WORKING
            summary.pendingRequestsCount > 0 -> RunningBucket.PENDING
            summary.metadata?.lifecycleState == SESSION_LIFECYCLE_IDLE -> RunningBucket.IDLE
            else -> RunningBucket.ACTIVE
        }
    }

    /**
     * Split the rendered rows (canonical order, pinned prefix first — the sort
     * contract) into the pinned section, the running buckets, and the rest.
     * Order-preserving: unlike the reference, which re-sorts each bucket by
     * `updatedAt` descending, the canonical Android sort already orders the
     * active rows, so within-bucket order follows it.
     */
    fun bucketSessionRows(rows: List<SessionRowUi>): SessionBucketsUi {
        val pinned = rows.takeWhile { it.summary.globalPinned == true || it.summary.pinned == true }
        val working = mutableListOf<SessionRowUi>()
        val pending = mutableListOf<SessionRowUi>()
        val active = mutableListOf<SessionRowUi>()
        val idle = mutableListOf<SessionRowUi>()
        val rest = mutableListOf<SessionRowUi>()
        for (row in rows.drop(pinned.size)) {
            when (bucketOf(row.summary)) {
                RunningBucket.WORKING -> working += row
                RunningBucket.PENDING -> pending += row
                RunningBucket.ACTIVE -> active += row
                RunningBucket.IDLE -> idle += row
                null -> rest += row
            }
        }
        return SessionBucketsUi(
            pinned = pinned,
            working = working,
            pending = pending,
            active = active,
            idle = idle,
            rest = rest,
        )
    }
}
