package app.hapi.companion.feature.sessions

import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * JVM tests for the running-bucket predicates — semantics pinned to
 * `bucketRunningSessions` / `isPinnedInProgressSession` in
 * `web/src/components/SessionList.tsx`.
 */
class SessionBucketsTest {
    private fun summary(
        id: String,
        active: Boolean = false,
        thinking: Boolean = false,
        backgroundTasks: Int = 0,
        pending: Int = 0,
        lifecycleState: String? = null,
        pinned: Boolean? = null,
        globalPinned: Boolean? = null,
    ): SessionSummary = SessionSummary(
        id = id,
        active = active,
        thinking = thinking,
        backgroundTaskCount = backgroundTasks,
        pendingRequestsCount = pending,
        pinned = pinned,
        globalPinned = globalPinned,
        metadata = SessionSummaryMetadata(path = "/repo/app", flavor = "claude", lifecycleState = lifecycleState),
    )

    private fun row(summary: SessionSummary) = SessionRowUi(
        summary = summary,
        title = summary.id,
        subtitle = null,
        meta = null,
        flavor = null,
        unread = false,
    )

    // -------------------------------------------------------- predicates --

    @Test
    fun `bucket chain resolves working before pending before idle`() {
        // Thinking is working, even while a permission request pends.
        assertEquals(RunningBucket.WORKING, SessionBuckets.bucketOf(summary("w1", active = true, thinking = true, pending = 3)))
        // A background task alone is working too.
        assertEquals(RunningBucket.WORKING, SessionBuckets.bucketOf(summary("w2", active = true, backgroundTasks = 2)))
        // Pending only when not thinking/working.
        assertEquals(RunningBucket.PENDING, SessionBuckets.bucketOf(summary("p1", active = true, pending = 1)))
        // Idle: connected, quiet, but the hub has seen nothing but keepalives.
        assertEquals(RunningBucket.IDLE, SessionBuckets.bucketOf(summary("i1", active = true, lifecycleState = SESSION_LIFECYCLE_IDLE)))
        // Quiet but alive: finished executing, still connected.
        assertEquals(RunningBucket.ACTIVE, SessionBuckets.bucketOf(summary("a1", active = true)))
        // A non-idle lifecycle string is still a quiet active session.
        assertEquals(RunningBucket.ACTIVE, SessionBuckets.bucketOf(summary("a2", active = true, lifecycleState = "busy")))
    }

    @Test
    fun `pinned and disconnected sessions never float`() {
        assertNull(SessionBuckets.bucketOf(summary("inactive", pending = 2))) // disconnected despite pending data
        assertNull(SessionBuckets.bucketOf(summary("pinned", active = true, thinking = true, pinned = true)))
        assertNull(SessionBuckets.bucketOf(summary("global", active = true, thinking = true, globalPinned = true)))
        // Any connected session floats — that is the reference's
        // isPinnedInProgressSession, used for the group-hiding half.
        assertTrue(SessionBuckets.isPinnedInProgressSession(summary("live", active = true)))
        assertFalse(SessionBuckets.isPinnedInProgressSession(summary("dead")))
    }

    // --------------------------------------------------------- splitting --

    @Test
    fun `bucketSessionRows splits the pinned prefix buckets and rest in order`() {
        val rows = listOf(
            row(summary("pin", active = true, thinking = true, globalPinned = true)), // stays pinned
            row(summary("think", active = true, thinking = true)),
            row(summary("wait", active = true, pending = 1)),
            row(summary("zombie", active = true, lifecycleState = SESSION_LIFECYCLE_IDLE)),
            row(summary("quiet", active = true)),
            row(summary("gone")),
            row(summary("live-again", active = true)), // second quiet-active row, after the rest row
        )
        val buckets = SessionBuckets.bucketSessionRows(rows)
        assertEquals(listOf("pin"), buckets.pinned.map { it.id })
        assertEquals(listOf("think"), buckets.working.map { it.id })
        assertEquals(listOf("wait"), buckets.pending.map { it.id })
        assertEquals(listOf("quiet", "live-again"), buckets.active.map { it.id }) // order-preserving
        assertEquals(listOf("zombie"), buckets.idle.map { it.id })
        assertEquals(listOf("gone"), buckets.rest.map { it.id })
        // A partition: every row lands exactly once.
        assertEquals(rows.size, buckets.pinned.size + buckets.working.size + buckets.pending.size +
            buckets.active.size + buckets.idle.size + buckets.rest.size)
    }

    @Test
    fun `bucketSessionRows with no pinned prefix buckets everything`() {
        val rows = listOf(row(summary("work", active = true, thinking = true)), row(summary("off")))
        val buckets = SessionBuckets.bucketSessionRows(rows)
        assertTrue(buckets.pinned.isEmpty())
        assertEquals(listOf("work"), buckets.working.map { it.id })
        assertEquals(listOf("off"), buckets.rest.map { it.id })
    }
}
