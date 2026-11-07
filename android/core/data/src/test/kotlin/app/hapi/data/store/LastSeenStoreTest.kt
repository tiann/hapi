package app.hapi.data.store

import app.hapi.protocol.wire.SessionReadState
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest

class LastSeenStoreTest {
    @Test
    fun `observed revisions and outbox persist together and are scoped`() = runTest {
        val dir = Files.createTempDirectory("read-state").toFile()
        val store = LastSeenStore(backgroundScope, dir, "alice")
        store.markSeen("s1", 7)
        store.markSeen("s1", 3)
        val cold = LastSeenStore(backgroundScope, dir, "alice")
        assertEquals(7, cold.lastSeenAt("s1"))
        assertEquals(7, cold.state.value.pending["s1"]?.request?.readRevision)
        assertEquals(0, LastSeenStore(backgroundScope, dir, "bob").lastSeenAt("s1"))
        assertEquals(0, LastSeenStore(backgroundScope, Files.createTempDirectory("hub-b").toFile(), "alice").lastSeenAt("s1"))
    }

    @Test
    fun `unread ignores metadata and includes running output`() = runTest {
        val store = LastSeenStore(backgroundScope)
        val row = summary("s1", updatedAt = 999_999)
        assertFalse(LastSeenStore.isUnread(row, store.state.value))
        assertTrue(LastSeenStore.isUnread(row.copy(contentRevision = 2), store.state.value))
        assertTrue(LastSeenStore.isUnread(row.copy(contentRevision = 2, active = true, thinking = true), store.state.value))
        assertTrue(LastSeenStore.isUnread(row.copy(contentRevision = 2, active = false, thinking = true), store.state.value))
        store.markSeen("s1", 1)
        assertTrue(LastSeenStore.isUnread(row.copy(contentRevision = 2), store.state.value))
        assertFalse(LastSeenStore.isUnread(row.copy(contentRevision = 2, readState = SessionReadState(2, false, 1)), store.state.value))
        assertTrue(LastSeenStore.isUnread(row.copy(contentRevision = 2, readState = SessionReadState(2, true, 2)), store.state.value))
    }

    @Test
    fun `stale read cannot erase newer manual unread`() = runTest {
        val store = LastSeenStore(backgroundScope)
        store.markSeen("s1", 4, SessionReadState(version = 1))
        val row = summary("s1").copy(contentRevision = 4, readState = SessionReadState(4, true, 2))
        assertTrue(LastSeenStore.isUnread(row, store.state.value))
        store.markSeen("s1", 4, row.readState)
        assertFalse(LastSeenStore.isUnread(row, store.state.value))
    }

    @Test
    fun `old acknowledgement cannot delete a newer queued read`() = runTest {
        val store = LastSeenStore(backgroundScope)
        val revisions = Channel<Long>(Channel.UNLIMITED)
        val first = CompletableDeferred<Unit>()
        store.configure("default") { _, request ->
            val revision = request.readRevision!!
            revisions.send(revision)
            if (request.readRevision == 3L) first.await()
            SessionReadState(revision, false, revision)
        }
        store.markSeen("s1", 3)
        assertEquals(3, revisions.receive())
        store.markSeen("s1", 4)
        first.complete(Unit)
        assertEquals(4, revisions.receive())
        store.state.first { it.pending.isEmpty() }
        assertEquals(4, store.state.value.server["s1"]?.readRevision)
    }

    @Test
    fun `persistence failure does not claim read`() = runTest {
        val file = Files.createTempFile("read-state", ".json").toFile()
        val store = LastSeenStore(backgroundScope, file)
        assertTrue(runCatching { store.markSeen("s1", 3) }.isFailure)
        assertEquals(0, store.lastSeenAt("s1"))
        assertTrue(store.state.value.pending.isEmpty())
    }

    // ------------------------------------------------- explicit unread marks --

    @Test
    fun `markUnread enqueues a durable explicit-unread request and reads optimistic`() = runTest {
        val dir = Files.createTempDirectory("read-state").toFile()
        val store = LastSeenStore(backgroundScope, dir, "alice")
        store.markSeen("s1", 4) // caught up at the head before the explicit mark
        val row = summary("s1").copy(contentRevision = 4)
        assertFalse(LastSeenStore.isUnread(row, store.state.value))

        store.markUnread("s1", row.readState)
        // Optimistic (web `effective`): the pending intent at the observed
        // version marks the row unread before the hub acknowledges.
        assertTrue(LastSeenStore.isUnread(row, store.state.value))
        assertEquals("unread", store.state.value.pending["s1"]?.request?.type)

        // Durable: the outbox — mark included — survives a cold restart.
        val cold = LastSeenStore(backgroundScope, dir, "alice")
        assertTrue(LastSeenStore.isUnread(row, cold.state.value))
        assertEquals("unread", cold.state.value.pending["s1"]?.request?.type)
    }

    @Test
    fun `an explicit-unread mark clears when the screen acknowledges the head`() = runTest {
        val store = LastSeenStore(backgroundScope)
        val observed = SessionReadState(readRevision = 4, version = 2)
        store.markUnread("s1", observed)
        val row = summary("s1").copy(contentRevision = 4)
        assertTrue(LastSeenStore.isUnread(row, store.state.value))

        // Viewing the session enqueues a read at the observed head: the
        // explicit mark's own acknowledge replaces it.
        store.markSeen("s1", 4, observed)
        assertFalse(LastSeenStore.isUnread(row, store.state.value))
        assertEquals("read", store.state.value.pending["s1"]?.request?.type)
    }

    @Test
    fun `markAllSeen stamps every unread row and returns the pre-sweep count`() = runTest {
        val store = LastSeenStore(backgroundScope)
        val read = summary("read").copy(contentRevision = 9)
        val manual = summary("manual").copy(contentRevision = 8)
        val fresh = summary("fresh").copy(contentRevision = 7)
        store.markSeen("read", 9) // already seen at the head
        store.markUnread("manual") // explicit mark on a caught-up row

        val count = store.markAllSeen(listOf(read, manual, fresh, fresh))
        assertEquals(2, count)
        assertFalse(LastSeenStore.isUnread(read, store.state.value))
        assertFalse(LastSeenStore.isUnread(manual, store.state.value))
        assertFalse(LastSeenStore.isUnread(fresh, store.state.value))
        // Everything seen — a second sweep is a no-op returning 0.
        assertEquals(0, store.markAllSeen(listOf(read, manual, fresh)))
    }

    @Test
    fun `unread count collapses repeated ids and honors explicit marks`() = runTest {
        val store = LastSeenStore(backgroundScope)
        store.markUnread("b")
        store.markSeen("c", 2)
        val sessions = listOf(
            summary("a").copy(contentRevision = 1),
            summary("a").copy(contentRevision = 3), // same id, newer view — one row
            summary("b").copy(contentRevision = 2),
            summary("c").copy(contentRevision = 2),
        )
        // a: unseen content; b: explicit mark; c: stamped at its head.
        assertEquals(2, LastSeenStore.unreadSessionCount(sessions, store.state.value))
        assertEquals(0, LastSeenStore.unreadSessionCount(emptyList(), store.state.value))
    }
}
