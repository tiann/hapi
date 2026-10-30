package app.hapi.companion.feature.chat.composer

import app.hapi.companion.feature.chat.attachments.ComposerDraftAttachment
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Live-snapshot ring + hand-off tombstones (pure JVM, no Android). */
class ComposerDraftSnapshotsTest {

    private fun snapshot(text: String, vararg ids: String) = ComposerDraftSnapshot(
        text = text,
        attachments = ids.map { id ->
            ComposerDraftAttachment(id = id, filename = "$id.jpg", mimeType = "image/jpeg", sizeBytes = 1, path = "/u/$id")
        },
    )

    @Test
    fun `set then get round-trips and remove drops only the snapshot`() {
        val snapshots = ComposerDraftSnapshots()
        snapshots.set("s1", snapshot("hello", "a"))

        assertEquals("hello", snapshots.get("s1")?.text)
        assertEquals(listOf("a"), snapshots.get("s1")?.attachments?.map { it.id })

        snapshots.remove("s1")
        assertNull(snapshots.get("s1"))
    }

    @Test
    fun `markHandedOff retires the snapshot and records the tombstone`() {
        val snapshots = ComposerDraftSnapshots()
        snapshots.set("s1", snapshot("carry me"))
        snapshots.markHandedOff("s1")

        assertNull(snapshots.get("s1"))
        assertTrue(snapshots.wasHandedOff("s1"))
    }

    @Test
    fun `a later set clears the tombstone (fresh input re-opens the source)`() {
        val snapshots = ComposerDraftSnapshots()
        snapshots.markHandedOff("s1")
        snapshots.set("s1", snapshot("typed again"))

        assertFalse(snapshots.wasHandedOff("s1"))
        assertEquals("typed again", snapshots.get("s1")?.text)
    }

    @Test
    fun `remove keeps an existing tombstone (send-consume does not resurrect)`() {
        val snapshots = ComposerDraftSnapshots()
        snapshots.set("s1", snapshot("stale"))
        snapshots.markHandedOff("s1")
        snapshots.remove("s1")

        assertTrue(snapshots.wasHandedOff("s1"))
    }

    @Test
    fun `the ring caps at fifty and evicts the least-recently-set session`() {
        val snapshots = ComposerDraftSnapshots()
        repeat(DraftRing.MAX_ENTRIES) { snapshots.set("s$it", snapshot("t$it")) }
        // Refresh the eldest so the second entry becomes the victim.
        snapshots.set("s0", snapshot("refreshed"))

        snapshots.set("overflow", snapshot("newest"))

        assertNull(snapshots.get("s1"))
        assertEquals("refreshed", snapshots.get("s0")?.text)
        assertEquals("newest", snapshots.get("overflow")?.text)
    }

    @Test
    fun `same-session sets never evict other entries at the cap`() {
        val snapshots = ComposerDraftSnapshots()
        repeat(DraftRing.MAX_ENTRIES) { snapshots.set("s$it", snapshot("t$it")) }

        snapshots.set("s7", snapshot("updated"))

        assertTrue((0 until DraftRing.MAX_ENTRIES).all { snapshots.get("s$it") != null })
        assertEquals("updated", snapshots.get("s7")?.text)
    }
}
