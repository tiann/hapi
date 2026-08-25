package app.hapi.protocol.wire

import kotlin.test.Test
import kotlin.test.assertEquals

/** Pins the exact `sortSessionSummaries` order from `web/src/hooks/useSSE.ts`. */
class SessionSortingTest {

    private fun summary(
        id: String,
        active: Boolean = false,
        updatedAt: Long = 0,
        pinned: Boolean? = null,
        globalPinned: Boolean? = null,
        pendingRequestsCount: Int = 0,
    ): SessionSummary = SessionSummary(
        id = id,
        active = active,
        thinking = false,
        activeAt = 0,
        updatedAt = updatedAt,
        pinned = pinned,
        globalPinned = globalPinned,
        metadata = null,
        metadataVersion = 0,
        agentStateVersion = 0,
        todosUpdatedAt = 0,
        todoProgress = null,
        pendingRequestsCount = pendingRequestsCount,
        pendingRequestKinds = emptyList(),
        pendingRequests = emptyList(),
        backgroundTaskCount = 0,
        futureScheduledMessageCount = 0,
        nextScheduledAt = null,
        model = null,
        modelReasoningEffort = null,
        effort = null,
    )

    @Test
    fun `globalPinned beats pinned beats active beats recency`() {
        val sorted = sortSessionSummaries(
            listOf(
                summary("recent-inactive", updatedAt = 9_000),
                summary("active", active = true, updatedAt = 1_000),
                summary("pinned", pinned = true, updatedAt = 500),
                summary("global", globalPinned = true, updatedAt = 100),
            )
        )
        assertEquals(listOf("global", "pinned", "active", "recent-inactive"), sorted.map { it.id })
    }

    @Test
    fun `among active sessions pendingRequestsCount descends before updatedAt`() {
        val sorted = sortSessionSummaries(
            listOf(
                summary("a", active = true, updatedAt = 9_000, pendingRequestsCount = 0),
                summary("b", active = true, updatedAt = 1_000, pendingRequestsCount = 2),
                summary("c", active = true, updatedAt = 5_000, pendingRequestsCount = 1),
            )
        )
        assertEquals(listOf("b", "c", "a"), sorted.map { it.id })
    }

    @Test
    fun `inactive sessions ignore pendingRequestsCount (web left-active guard)`() {
        val sorted = sortSessionSummaries(
            listOf(
                summary("low-pending-recent", updatedAt = 9_000, pendingRequestsCount = 0),
                summary("high-pending-old", updatedAt = 1_000, pendingRequestsCount = 5),
            )
        )
        assertEquals(listOf("low-pending-recent", "high-pending-old"), sorted.map { it.id })
    }

    @Test
    fun `pinned sections sort by recency within themselves`() {
        val sorted = sortSessionSummaries(
            listOf(
                summary("g-old", globalPinned = true, updatedAt = 100),
                summary("p-new", pinned = true, updatedAt = 9_000),
                summary("g-new", globalPinned = true, updatedAt = 5_000),
                summary("p-old", pinned = true, updatedAt = 200),
            )
        )
        assertEquals(listOf("g-new", "g-old", "p-new", "p-old"), sorted.map { it.id })
    }

    @Test
    fun `null pin flags count as false and ties keep prior order (stable)`() {
        val a = summary("a", updatedAt = 1_000, pinned = null)
        val b = summary("b", updatedAt = 1_000, pinned = false)
        val c = summary("c", updatedAt = 1_000)
        assertEquals(listOf("a", "b", "c"), sortSessionSummaries(listOf(a, b, c)).map { it.id })
        assertEquals(listOf("c", "b", "a"), sortSessionSummaries(listOf(c, b, a)).map { it.id })
    }

    @Test
    fun `updatedAt comparison survives long deltas`() {
        // Long-range timestamps must not overflow an Int subtraction.
        val sorted = sortSessionSummaries(
            listOf(
                summary("old", updatedAt = 1_000L),
                summary("new", updatedAt = 1_000L + Int.MAX_VALUE.toLong() * 3),
            )
        )
        assertEquals(listOf("new", "old"), sorted.map { it.id })
    }
}
