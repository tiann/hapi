package app.hapi.data.store

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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
}
