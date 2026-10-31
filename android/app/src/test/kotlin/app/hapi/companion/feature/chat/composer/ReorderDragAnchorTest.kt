package app.hapi.companion.feature.chat.composer

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Tray order semantics of `ComposerAttachments.move` on a plain list. */
private fun <T> MutableList<T>.moveEntry(from: Int, to: Int) {
    val entry = removeAt(from)
    add(to, entry)
}

class ReorderDragAnchorTest {

    @Test
    fun `issue-time anchor suppresses the stale double-fire that swaps back`() {
        // Review repro: the pointer sits in slot 1 while the LazyRow layout
        // still shows the pre-move order, so the drag event right after the
        // move re-reports slot 1. The pre-fix `from` (re-derived from the
        // stale layout) fires move(0, 1) twice — the second lands on the
        // moved list and swaps the pair straight back.
        val naive = mutableListOf("a", "b", "c")
        listOf(1, 1).forEach { target -> naive.moveEntry(0, target) }
        assertEquals(listOf("a", "b", "c"), naive)

        // Anchored: the same event stream (and a third stale re-report)
        // issues exactly one move, and the dragged chip keeps its new slot.
        val anchored = mutableListOf("a", "b", "c")
        val anchor = ReorderDragAnchor().apply { start(0) }
        listOf(1, 1, 1).forEach { target ->
            anchor.enterSlot(target)?.let { (from, to) -> anchored.moveEntry(from, to) }
        }
        assertEquals(listOf("b", "a", "c"), anchored)
    }

    @Test
    fun `anchor tracks the new slot across a multi-slot drag`() {
        val tray = mutableListOf("a", "b", "c")
        val anchor = ReorderDragAnchor().apply { start(0) }

        assertEquals(0 to 1, anchor.enterSlot(1))
        assertEquals(1 to 2, anchor.enterSlot(2))

        tray.moveEntry(0, 1)
        tray.moveEntry(1, 2)
        assertEquals(listOf("b", "c", "a"), tray)
        assertEquals(2, anchor.index)
    }

    @Test
    fun `a real retreat crosses back and reorders again`() {
        // Hysteresis is one-directional: dragging the finger back across the
        // previous slot is a deliberate move and must issue the reverse —
        // only same-slot jitter (the stale double-fire) is suppressed.
        val anchor = ReorderDragAnchor().apply { start(0) }
        assertEquals(0 to 1, anchor.enterSlot(1))
        assertEquals(1 to 0, anchor.enterSlot(0))
    }

    @Test
    fun `same slot and inactive anchor are no-ops`() {
        val anchor = ReorderDragAnchor()
        assertFalse(anchor.active)
        assertNull(anchor.enterSlot(0))

        anchor.start(1)
        assertTrue(anchor.active)
        assertNull(anchor.enterSlot(1))
        assertEquals(1, anchor.index)

        anchor.reset()
        assertFalse(anchor.active)
        assertNull(anchor.enterSlot(0))
    }
}
