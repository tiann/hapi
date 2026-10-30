package app.hapi.data.store

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class LastSeenStoreTest {

    @Test
    fun `markSeen is monotonic max`() = runTest {
        val store = LastSeenStore(backgroundScope)
        store.markSeen("s1", 1_000)
        assertEquals(1_000, store.lastSeenAt("s1"))
        store.markSeen("s1", 500) // stale screen must not rewind
        assertEquals(1_000, store.lastSeenAt("s1"))
        store.markSeen("s1", 2_000)
        assertEquals(2_000, store.lastSeenAt("s1"))
        assertEquals(0, store.lastSeenAt("unknown"))
    }

    @Test
    fun `unread compares updatedAt against the watermark`() = runTest {
        val row = summary("s1", updatedAt = 1_000)
        assertTrue(LastSeenStore.isUnread(row, lastSeenAt = 0))
        assertTrue(LastSeenStore.isUnread(row, lastSeenAt = 999))
        assertFalse(LastSeenStore.isUnread(row, lastSeenAt = 1_000))
        assertFalse(LastSeenStore.isUnread(row, lastSeenAt = 2_000))
    }

    @Test
    fun `baseline seeds missing watermarks only once per scope`() = runTest {
        val store = LastSeenStore(backgroundScope)
        store.markSeen("seen", 50)
        store.initializeBaseline(
            "hub-a",
            listOf(summary("seen", updatedAt = 900), summary("fresh", updatedAt = 700)),
        )
        // Existing watermarks are never overwritten; missing ones seed at updatedAt.
        assertEquals(50, store.lastSeenAt("seen"))
        assertEquals(700, store.lastSeenAt("fresh"))
        assertFalse(LastSeenStore.isUnread(summary("fresh", updatedAt = 700), store.lastSeenAt("fresh")))

        // Second call for the same scope is a no-op — later sessions stay unread.
        store.initializeBaseline("hub-a", listOf(summary("later", updatedAt = 999)))
        assertEquals(0, store.lastSeenAt("later"))
        assertTrue(LastSeenStore.isUnread(summary("later", updatedAt = 999), store.lastSeenAt("later")))
    }

    @Test
    fun `state round-trips through the snapshot`() = runTest {
        val dir = Files.createTempDirectory("last-seen").toFile()
        val store = LastSeenStore(backgroundScope, dir)
        store.markSeen("s1", 1_234)
        store.initializeBaseline("hub-a", emptyList())
        store.flushPersistence()

        val cold = LastSeenStore(backgroundScope, dir)
        assertEquals(1_234, cold.lastSeenAt("s1"))
        // Baseline flag persists too — no re-seeding on cold start.
        cold.initializeBaseline("hub-a", listOf(summary("s2", updatedAt = 700)))
        assertEquals(0, cold.lastSeenAt("s2"))
    }

    // ------------------------------------------------- explicit unread marks --

    @Test
    fun `markUnread parks the watermark behind the activity and pins the mark`() = runTest {
        val store = LastSeenStore(backgroundScope)
        store.markSeen("s1", 1_000)
        store.markUnread("s1", 1_000)

        assertEquals(999, store.lastSeenAt("s1"))
        assertEquals(1_000L, store.manualUnreadAt("s1"))
        // The row reads unread again through the plain watermark comparison.
        assertTrue(LastSeenStore.isUnread(summary("s1", updatedAt = 1_000), store.lastSeenAt("s1")))

        // Idempotent: same values, no state change (the snapshot stays clean).
        store.markUnread("s1", 1_000)
        assertEquals(999, store.lastSeenAt("s1"))
        assertEquals(1_000L, store.manualUnreadAt("s1"))
        assertNull(store.manualUnreadAt("other"))
    }

    @Test
    fun `markSeen clears the manual mark once the screen caught up`() = runTest {
        val store = LastSeenStore(backgroundScope)
        store.markUnread("s1", 1_000) // watermark 999, manual 1_000

        store.markSeen("s1", 500) // stale screen: watermark maxes to 999 → manual stays
        assertEquals(1_000L, store.manualUnreadAt("s1"))
        store.markSeen("s1", 1_000) // caught up → manual cleared
        assertNull(store.manualUnreadAt("s1"))
        assertEquals(1_000, store.lastSeenAt("s1"))
    }

    @Test
    fun `markAllSeen stamps unread rows and drops manual marks`() = runTest {
        val store = LastSeenStore(backgroundScope)
        store.markSeen("read", 900)
        store.markUnread("manual", 800) // watermark 799, manual 800

        val count = store.markAllSeen(
            listOf(
                summary("read", updatedAt = 900),
                summary("manual", updatedAt = 800),
                summary("fresh", updatedAt = 700),
                summary("fresh", updatedAt = 750), // repeated id: max wins
            ),
        )
        assertEquals(2, count)
        assertEquals(900, store.lastSeenAt("read"))
        assertEquals(800, store.lastSeenAt("manual"))
        assertNull(store.manualUnreadAt("manual"))
        assertEquals(750, store.lastSeenAt("fresh"))
        // Everything seen — a second sweep is a no-op returning 0.
        assertEquals(0, store.markAllSeen(listOf(summary("fresh", updatedAt = 750))))
    }

    @Test
    fun `unread count collapses repeated ids and honors manual marks`() {
        val sessions = listOf(
            summary("a", updatedAt = 100),
            summary("a", updatedAt = 300), // same id, newer view — max wins
            summary("b", updatedAt = 200),
        )
        assertEquals(2, LastSeenStore.unreadSessionCount(sessions, lastSeen = emptyMap(), manualUnread = emptyMap()))
        assertEquals(1, LastSeenStore.unreadSessionCount(sessions, lastSeen = mapOf("a" to 300L), manualUnread = emptyMap()))
        // Manual mark at exactly the activity timestamp keeps b unread even
        // though the watermark caught up (the reference's defensive OR) — a
        // stays seen, so the count is b alone.
        assertEquals(1, LastSeenStore.unreadSessionCount(sessions, lastSeen = mapOf("a" to 300L, "b" to 200L), manualUnread = mapOf("b" to 200L)))
        assertEquals(0, LastSeenStore.unreadSessionCount(emptyList(), emptyMap(), emptyMap()))
    }

    @Test
    fun `manual unread marks round-trip through the snapshot`() = runTest {
        val dir = Files.createTempDirectory("last-seen").toFile()
        val store = LastSeenStore(backgroundScope, dir)
        store.markUnread("s1", 5_000)
        store.flushPersistence()

        val cold = LastSeenStore(backgroundScope, dir)
        assertEquals(4_999, cold.lastSeenAt("s1"))
        assertEquals(5_000L, cold.manualUnreadAt("s1"))
    }
}
