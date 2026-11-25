package app.hapi.protocol.wire

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class SessionSortingTest {
    private fun summary(id: String, createdAt: Long? = null, at: Long? = null) =
        SessionSummary(id = id, active = false, createdAt = createdAt, lastUserMessageAt = at)

    @Test
    fun `output and status do not reorder but new input does`() {
        val old = summary("old", 1, 100).copy(updatedAt = 90_000, active = true, thinking = true, pendingRequestsCount = 4)
        val newer = summary("new", 2, 200)
        assertEquals(listOf("new", "old"), sortSessionSummaries(listOf(old, newer)).map { it.id })
        assertEquals(listOf("old", "new"), sortSessionSummaries(listOf(old.copy(lastUserMessageAt = 300), newer)).map { it.id })
    }

    @Test
    fun `active first leads each pin tier without beating pins`() {
        val rows = listOf(
            summary("new-stopped", 2, 200),
            summary("old-live", 1, 100).copy(active = true),
            summary("pinned-stopped", at = 1).copy(pinned = true),
            summary("global", at = 0).copy(globalPinned = true),
            summary("pinned-live", at = 0).copy(pinned = true, active = true),
        )
        assertEquals(
            listOf("global", "pinned-live", "pinned-stopped", "old-live", "new-stopped"),
            sortSessionSummaries(rows, SessionListOrder.Default).map { it.id },
        )
        assertEquals(
            listOf("global", "pinned-stopped", "pinned-live", "new-stopped", "old-live"),
            sortSessionSummaries(rows, SessionListOrder.Base).map { it.id },
        )
        assertEquals(sortSessionSummaries(rows), sortSessionSummaries(rows, SessionListOrder.Base))
    }

    @Test
    fun `created sort ignores input and stored keys match web`() {
        val rows = listOf(summary("early", 1, 900), summary("unknown", at = 999), summary("late", 5, 10))
        val created = SessionListOrder(SessionListSort.Created, activeFirst = false)
        assertEquals(listOf("late", "early", "unknown"), sortSessionSummaries(rows, created).map { it.id })
        assertEquals(listOf("unknown", "early", "late"), sortSessionSummaries(rows, SessionListOrder.Base).map { it.id })
        assertEquals("last-message", SessionListSort.LastMessage.storageKey)
        assertEquals(SessionListSort.LastMessage, SessionListSort.fromStorageKey("activity"))
        assertEquals(SessionListOrder(SessionListSort.LastMessage, activeFirst = true), SessionListOrder.Default)
    }

    @Test
    fun `manual pins still come first`() {
        val rows = listOf(summary("new", at = 99), summary("project", at = 2).copy(pinned = true), summary("global", at = 1).copy(globalPinned = true))
        assertEquals(listOf("global", "project", "new"), sortSessionSummaries(rows).map { it.id })
    }

    @Test
    fun `creation fallback and timestamp ties are deterministic`() {
        val rows = listOf(summary("b", 2), summary("a", 2), summary("old", 1))
        assertEquals(listOf("a", "b", "old"), sortSessionSummaries(rows).map { it.id })
        assertEquals(listOf("a", "b", "old"), sortSessionSummaries(rows.reversed()).map { it.id })
    }

    @Test
    fun `missing ordering timestamps sort after present timestamps`() {
        val rows = listOf(
            summary("missing"),
            summary("created", createdAt = 100),
            summary("user-input", at = 200),
        )
        val expected = listOf("user-input", "created", "missing")
        assertEquals(expected, sortSessionSummaries(rows).map { it.id })
        assertEquals(expected, sortSessionSummaries(rows.reversed()).map { it.id })
    }

    @Test
    fun `tied user input timestamps compare missing creation times as zero`() {
        val rows = listOf(
            summary("a-missing", at = 200),
            summary("b-zero", createdAt = 0, at = 200),
            summary("c-created", createdAt = 100, at = 200),
        )
        val expected = listOf("c-created", "a-missing", "b-zero")
        assertEquals(expected, sortSessionSummaries(rows).map { it.id })
        assertEquals(expected, sortSessionSummaries(rows.reversed()).map { it.id })
    }

    @Test
    fun `patch clock is monotonic and render relevant`() {
        val row = summary("a", at = 100)
        val next = SummaryPatching.applySessionSummaryPatch(row, SessionPatch(lastUserMessageAt = 200))
        assertEquals(200L, next.lastUserMessageAt)
        assertFalse(SummaryPatching.isRenderIrrelevantPatch(row, next))
        assertEquals(200L, SummaryPatching.applySessionSummaryPatch(next, SessionPatch(lastUserMessageAt = 50)).lastUserMessageAt)
    }
}
