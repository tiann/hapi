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
    fun `markUnread queues an intent that relights the row before the ack`() = runTest {
        val store = LastSeenStore(backgroundScope)
        store.markSeen("s1", 2, SessionReadState(readRevision = 2, version = 2))
        val row = summary("s1").copy(contentRevision = 2, readState = SessionReadState(2, false, 2))
        assertFalse(LastSeenStore.isUnread(row, store.state.value))

        store.markUnread("s1", row.readState)
        // The queued `unread` request is the operator's newest choice at this
        // version — the row reads unread before the server acknowledges.
        assertEquals("unread", store.state.value.pending["s1"]?.request?.type)
        assertTrue(LastSeenStore.isUnread(row, store.state.value))
    }

    @Test
    fun `a caught-up viewing action replaces a queued manual-unread`() = runTest {
        val store = LastSeenStore(backgroundScope)
        store.markUnread("s1", SessionReadState(readRevision = 2, version = 2))
        val row = summary("s1").copy(contentRevision = 2, readState = SessionReadState(2, false, 2))
        assertTrue(LastSeenStore.isUnread(row, store.state.value))

        store.markSeen("s1", 2, row.readState)
        // The pending read replaced the unread intent; the row reads seen.
        assertEquals("read", store.state.value.pending["s1"]?.request?.type)
        assertFalse(LastSeenStore.isUnread(row, store.state.value))
    }

    @Test
    fun `markAllSeen stamps unread rows and returns the unread count`() = runTest {
        val store = LastSeenStore(backgroundScope)
        store.markSeen("read", 9, SessionReadState(readRevision = 9, version = 1))
        store.markUnread("manual", SessionReadState(readRevision = 8, version = 1))

        val count = store.markAllSeen(
            listOf(
                summary("read").copy(contentRevision = 9, readState = SessionReadState(9, false, 1)),
                summary("manual").copy(contentRevision = 8, readState = SessionReadState(8, true, 1)),
                summary("fresh").copy(contentRevision = 7),
                summary("fresh").copy(contentRevision = 7), // repeated id: seen on sight, not counted twice
            ),
        )
        assertEquals(2, count)
        assertFalse(
            LastSeenStore.isUnread(
                summary("manual").copy(contentRevision = 8, readState = SessionReadState(8, true, 1)),
                store.state.value,
            ),
        )
        assertFalse(LastSeenStore.isUnread(summary("fresh").copy(contentRevision = 7), store.state.value))
        // Everything seen — a second sweep is a no-op returning 0.
        assertEquals(0, store.markAllSeen(listOf(summary("fresh").copy(contentRevision = 7))))
    }

    @Test
    fun `unread count collapses repeated ids and honors manual marks`() = runTest {
        val store = LastSeenStore(backgroundScope)
        val sessions = listOf(
            summary("a").copy(contentRevision = 100),
            summary("a").copy(contentRevision = 300), // same id, newer view — one entry
            summary("b").copy(contentRevision = 200),
        )
        assertEquals(2, LastSeenStore.unreadSessionCount(sessions, store.state.value))
        store.markSeen("a", 300)
        assertEquals(1, LastSeenStore.unreadSessionCount(sessions, store.state.value))
        // An explicit mark relights b even though its watermark caught up —
        // a stays seen, so the count is b alone.
        store.markSeen("b", 200)
        store.markUnread("b")
        assertEquals(1, LastSeenStore.unreadSessionCount(sessions, store.state.value))
        assertEquals(0, LastSeenStore.unreadSessionCount(emptyList(), store.state.value))
    }

    @Test
    fun `queued unread intents persist across restarts`() = runTest {
        val dir = Files.createTempDirectory("read-state").toFile()
        val store = LastSeenStore(backgroundScope, dir, "alice")
        store.markUnread("s1")

        val cold = LastSeenStore(backgroundScope, dir, "alice")
        val pending = cold.state.value.pending["s1"]?.request
        assertEquals("unread", pending?.type)
        assertEquals(0, pending?.expectedVersion)
    }
}
