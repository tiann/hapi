package app.hapi.companion.feature.chat.composer

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Boundary tests for the max-50 recency ring (pure JVM, no Android). */
class DraftRingTest {

    private fun ringOf(vararg touched: Pair<String, Long>): LinkedHashMap<String, Long> =
        LinkedHashMap(touched.toMap())

    @Test
    fun `exactly fifty entries evicts nothing`() {
        val index = ringOf(*(1..50).map { "s$it" to it.toLong() }.toTypedArray())

        val evicted = DraftRing.touch(index, "s50", touchedAtMillis = 999)

        assertTrue(evicted.isEmpty())
        assertEquals(50, index.size)
    }

    @Test
    fun `fifty-one entries evicts the oldest`() {
        val index = ringOf(*(1..50).map { "s$it" to it.toLong() }.toTypedArray())

        val evicted = DraftRing.touch(index, "s51", touchedAtMillis = 100)

        assertEquals(listOf("s1"), evicted)
        assertEquals(50, index.size)
        assertFalse(index.containsKey("s1"))
        assertEquals(100, index["s51"])
    }

    @Test
    fun `same-key update never evicts`() {
        val index = ringOf(*(1..50).map { "s$it" to it.toLong() }.toTypedArray())

        val evicted = DraftRing.touch(index, "s25", touchedAtMillis = 10_000)

        assertTrue(evicted.isEmpty())
        assertEquals(50, index.size)
        // The refreshed key became the most recent, not a victim.
        assertEquals(10_000, index["s25"])
    }

    @Test
    fun `refresh protects a key from later eviction`() {
        val index = ringOf(*(1..50).map { "s$it" to it.toLong() }.toTypedArray())
        DraftRing.touch(index, "s1", touchedAtMillis = 999) // oldest refreshed

        val evicted = DraftRing.touch(index, "s51", touchedAtMillis = 1000)

        // s1 was refreshed past s2, so the eviction falls to the next oldest.
        assertEquals(listOf("s2"), evicted)
        assertTrue(index.containsKey("s1"))
    }

    @Test
    fun `a burst beyond the cap evicts every overflow victim oldest-first`() {
        // 49 entries + the first touch sit exactly at the cap; each further
        // touch evicts exactly one least-recently-touched entry.
        val index = ringOf(*(1..49).map { "s$it" to it.toLong() }.toTypedArray())

        val evicted = DraftRing.touch(index, "s50", touchedAtMillis = 50) +
            DraftRing.touch(index, "s51", touchedAtMillis = 51) +
            DraftRing.touch(index, "s52", touchedAtMillis = 52)

        assertEquals(listOf("s1", "s2"), evicted)
        assertEquals(50, index.size)
    }

    @Test
    fun `timestamp ties evict the first in iteration order`() {
        val index = ringOf("a" to 5L, "b" to 5L, "c" to 5L)

        val evicted = DraftRing.touch(index, "d", touchedAtMillis = 5L, maxEntries = 3)

        assertEquals(listOf("a"), evicted)
        assertEquals(setOf("b", "c", "d"), index.keys)
    }

    @Test
    fun `the touched key is never a victim even under a tiny cap`() {
        val index = ringOf("old" to 1L)

        val evicted = DraftRing.touch(index, "new", touchedAtMillis = 1L, maxEntries = 1)

        assertEquals(listOf("old"), evicted)
        assertEquals(setOf("new"), index.keys)
    }

    // ------------------------------------------------------ putTouching --

    @Test
    fun `putTouching refreshes an existing key without evicting`() {
        val ring = LinkedHashMap<String, Int>()
        repeat(DraftRing.MAX_ENTRIES) { ring["k$it"] = it }

        DraftRing.putTouching(ring, "k0", -1)

        assertEquals(DraftRing.MAX_ENTRIES, ring.size)
        // Refreshed key moved to the most-recent end.
        assertEquals("k0", ring.keys.last())
    }

    @Test
    fun `putTouching evicts the eldest entry on the fifty-first key`() {
        val ring = LinkedHashMap<String, Int>()
        repeat(DraftRing.MAX_ENTRIES) { ring["k$it"] = it }

        DraftRing.putTouching(ring, "new-key", -1)

        assertEquals(DraftRing.MAX_ENTRIES, ring.size)
        assertFalse(ring.containsKey("k0"))
        assertEquals(-1, ring["new-key"])
    }

    @Test
    fun `putTouching same key at the cap keeps every other entry`() {
        val ring = LinkedHashMap<String, Int>()
        repeat(DraftRing.MAX_ENTRIES) { ring["k$it"] = it }

        DraftRing.putTouching(ring, "k49", -1)

        assertEquals(DraftRing.MAX_ENTRIES, ring.size)
        assertTrue((0 until DraftRing.MAX_ENTRIES).all { ring.containsKey("k$it") })
    }
}
