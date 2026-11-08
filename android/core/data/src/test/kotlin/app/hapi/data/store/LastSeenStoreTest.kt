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
}
