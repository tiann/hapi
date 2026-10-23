package app.hapi.data.store

import app.hapi.protocol.wire.ScratchlistEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Pure policy tests — the native twin of `web/src/lib/scratchlist.test.ts`. */
class ScratchlistEntryOpsTest {

    private fun entry(id: String, text: String = "note") = ScratchlistEntry(
        entryId = id,
        text = text,
        createdAt = 1,
        updatedAt = 1,
    )

    private val entries = listOf(entry("e1"), entry("e2"), entry("e3"))

    // ------------------------------------------------------- delete confirm --

    @Test
    fun `delete confirms only for texts strictly longer than the web threshold`() {
        val atThreshold = "x".repeat(ScratchlistEntryOps.CONFIRM_DELETE_THRESHOLD)
        val overThreshold = "x".repeat(ScratchlistEntryOps.CONFIRM_DELETE_THRESHOLD + 1)
        assertFalse(ScratchlistEntryOps.shouldConfirmDelete(null))
        assertFalse(ScratchlistEntryOps.shouldConfirmDelete(""))
        assertFalse(ScratchlistEntryOps.shouldConfirmDelete("short note"))
        assertFalse(ScratchlistEntryOps.shouldConfirmDelete(atThreshold))
        assertTrue(ScratchlistEntryOps.shouldConfirmDelete(overThreshold))
    }

    @Test
    fun `threshold matches the web client`() =
        assertEquals(100, ScratchlistEntryOps.CONFIRM_DELETE_THRESHOLD)

    @Test
    fun `untrimmed length decides — whitespace-only long text still confirms`() =
        assertTrue(ScratchlistEntryOps.shouldConfirmDelete(" ".repeat(101)))

    // ----------------------------------------------------------------- move --

    @Test
    fun `move up swaps with the neighbor toward index zero`() = assertEquals(
        listOf("e1", "e3", "e2"),
        ScratchlistEntryOps.moveEntry(entries, "e3", ScratchlistMoveDirection.UP)
            .map { it.entryId },
    )

    @Test
    fun `move down swaps with the neighbor toward the end`() = assertEquals(
        listOf("e2", "e1", "e3"),
        ScratchlistEntryOps.moveEntry(entries, "e1", ScratchlistMoveDirection.DOWN)
            .map { it.entryId },
    )

    @Test
    fun `edge and unknown moves are no-ops`() {
        assertSame(entries, ScratchlistEntryOps.moveEntry(entries, "e1", ScratchlistMoveDirection.UP))
        assertSame(entries, ScratchlistEntryOps.moveEntry(entries, "e3", ScratchlistMoveDirection.DOWN))
        assertSame(entries, ScratchlistEntryOps.moveEntry(entries, "missing", ScratchlistMoveDirection.UP))
        val single = listOf(entry("only"))
        assertSame(single, ScratchlistEntryOps.moveEntry(single, "only", ScratchlistMoveDirection.UP))
        assertSame(single, ScratchlistEntryOps.moveEntry(single, "only", ScratchlistMoveDirection.DOWN))
    }

    @Test
    fun `move preserves entry payloads`() {
        val a = entry("a", "alpha")
        val b = entry("b", "beta")
        val moved = ScratchlistEntryOps.moveEntry(listOf(a, b), "b", ScratchlistMoveDirection.UP)

        assertEquals(listOf("b", "a"), moved.map { it.entryId })
        assertEquals("beta", moved.first().text)
        assertEquals("alpha", moved.last().text)
    }
}
