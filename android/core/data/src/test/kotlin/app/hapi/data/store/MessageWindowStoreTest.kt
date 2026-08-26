package app.hapi.data.store

import app.hapi.data.api.MessagesApi
import app.hapi.data.api.MessagesQuery
import app.hapi.protocol.window.MessageStatus
import app.hapi.protocol.window.MessageWindowLogic
import app.hapi.protocol.window.PersistedMessageWindow
import app.hapi.protocol.window.asWindowMessage
import app.hapi.protocol.window.buildOptimisticMessage
import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.MessagesPage
import app.hapi.protocol.wire.MessagesResponse
import app.hapi.protocol.wire.OptionalField
import app.hapi.protocol.wire.QueuedStateResponse
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Targeted coverage for what the pagination fixtures cannot reach: tail-sync
 * single-flight/trailing behavior, concurrent-ingest preservation across a
 * reset replace (identity baseline), the cursor-no-advance guard, snapshot
 * round-trips + LRU, seed-on-resume, and Mutex discipline under parallelism.
 */
class MessageWindowStoreTest {

    @get:Rule
    val temp = TemporaryFolder()

    // ------------------------------------------------------------- fixtures --

    private fun agentRow(id: String, seq: Long, at: Long): DecryptedMessage = DecryptedMessage(
        id = id,
        seq = seq,
        createdAt = at,
        invokedAt = OptionalField.Present(at),
        content = buildJsonObject {
            put("role", "agent")
            put("content", buildJsonObject {
                put("type", "codex")
                put("data", buildJsonObject {
                    put("type", "message")
                    put("message", id)
                })
            })
        },
    )

    private fun latestPage(
        messages: List<DecryptedMessage>,
        epoch: Long,
        reset: Boolean = false,
        hasMore: Boolean = false,
    ): MessagesResponse {
        val newest = messages.lastOrNull()
        val oldest = messages.firstOrNull()
        return MessagesResponse(
            messages = messages,
            page = MessagesPage(
                direction = "latest",
                limit = 200,
                epoch = epoch,
                reset = reset,
                nextBeforeSeq = oldest?.seq,
                nextBeforeAt = oldest?.positionAt,
                nextAfterSeq = null,
                nextAfterAt = null,
                snapshotHeadSeq = newest?.seq,
                snapshotHeadAt = newest?.positionAt,
                hasMore = hasMore,
            ),
        )
    }

    private fun afterPage(
        messages: List<DecryptedMessage>,
        epoch: Long,
        nextAfter: Pair<Long, Long>?,
        hasMore: Boolean,
    ): MessagesResponse = MessagesResponse(
        messages = messages,
        page = MessagesPage(
            direction = "after",
            limit = 200,
            epoch = epoch,
            reset = false,
            nextBeforeSeq = null,
            nextBeforeAt = null,
            nextAfterSeq = nextAfter?.second,
            nextAfterAt = nextAfter?.first,
            snapshotHeadSeq = nextAfter?.second,
            snapshotHeadAt = nextAfter?.first,
            hasMore = hasMore,
        ),
    )

    /** Api whose responses are released manually, so tests control interleaving. */
    private class GatedMessagesApi : MessagesApi {
        val requests = mutableListOf<MessagesQuery>()
        private val responses = Channel<MessagesResponse>(Channel.UNLIMITED)

        fun release(response: MessagesResponse) {
            check(responses.trySend(response).isSuccess)
        }

        override suspend fun getMessages(sessionId: String, query: MessagesQuery): MessagesResponse {
            requests += query
            return responses.receive()
        }

        override suspend fun getQueuedState(sessionId: String, localIds: List<String>): QueuedStateResponse =
            QueuedStateResponse(emptyList(), emptyList())
    }

    // ------------------------------------------------------------ tail sync --

    @Test
    fun `concurrent syncTail calls coalesce into a single run`() = runTest {
        val api = GatedMessagesApi()
        val store = MessageWindowStore("s", api, backgroundScope)

        val first = launch { store.syncTail() }
        runCurrent()
        assertEquals(1, api.requests.size)

        val second = launch { store.syncTail() }
        runCurrent()
        // The second caller joined the in-flight run instead of issuing its own.
        assertEquals(1, api.requests.size)

        api.release(latestPage(listOf(agentRow("a-1", 1, 1000)), epoch = 0))
        first.join()
        second.join()
        assertEquals(1, api.requests.size)
        assertEquals(listOf("a-1"), store.state.value.messages.map { it.id })
    }

    @Test
    fun `ensureAfterCurrent requests a trailing run and drains it`() = runTest {
        val api = GatedMessagesApi()
        val store = MessageWindowStore("s", api, backgroundScope)

        val first = launch { store.syncTail() }
        runCurrent()
        assertEquals(1, api.requests.size)

        val drain = launch { store.syncTail(ensureAfterCurrent = true) }
        runCurrent()
        assertEquals(1, api.requests.size)

        api.release(latestPage(listOf(agentRow("a-1", 1, 1000)), epoch = 0))
        first.join()
        runCurrent()
        // The trailing run started and issued its own (after-cursor) request.
        assertEquals(2, api.requests.size)
        assertTrue(api.requests[1] is MessagesQuery.After)
        assertTrue(drain.isActive)

        api.release(afterPage(emptyList(), epoch = 0, nextAfter = 1000L to 1L, hasMore = false))
        drain.join()
        assertEquals(2, api.requests.size)
    }

    @Test
    fun `reset replace preserves rows that arrived while the request was in flight`() = runTest {
        val api = GatedMessagesApi()
        val store = MessageWindowStore("s", api, backgroundScope)

        // Seed epoch + cursor with a completed latest sync.
        val seed = launch { store.syncTail() }
        runCurrent()
        api.release(latestPage(listOf(agentRow("a-1", 1, 1000)), epoch = 0))
        seed.join()

        // Second sync goes down the after-cursor path and hangs on the api.
        val sync = launch { store.syncTail() }
        runCurrent()
        assertTrue(api.requests.last() is MessagesQuery.After)

        // A live SSE row lands while the request is in flight.
        store.ingestSseMessages(listOf(agentRow("b-2", 2, 2000).asWindowMessage()))

        // The server answers with a reset page that does not contain b-2.
        api.release(latestPage(listOf(agentRow("c-3", 3, 3000)), epoch = 1, reset = true))
        sync.join()

        val state = store.state.value
        // a-1 (captured in the request baseline) was replaced; the concurrent
        // b-2 and the authoritative c-3 both survive.
        assertEquals(listOf("b-2", "c-3"), state.messages.map { it.id })
        assertEquals(1L, state.epoch)
        assertEquals(3000L to 3L, state.newestPosition!!.let { it.at to it.seq })
    }

    @Test
    fun `a tail cursor that does not advance aborts with a warning instead of spinning`() = runTest {
        val api = GatedMessagesApi()
        val store = MessageWindowStore("s", api, backgroundScope)

        val seed = launch { store.syncTail() }
        runCurrent()
        api.release(latestPage(listOf(agentRow("a-1", 1, 1000)), epoch = 0))
        seed.join()

        val sync = launch { store.syncTail() }
        runCurrent()
        // hasMore with a non-advancing nextAfter is a protocol violation.
        api.release(afterPage(listOf(agentRow("b-2", 2, 2000)), epoch = 0, nextAfter = 1000L to 1L, hasMore = true))
        sync.join()

        val state = store.state.value
        assertEquals("Message tail cursor did not advance", state.warning)
        assertTrue(!state.isSyncingTail)
        assertEquals(2, api.requests.size)
    }

    // ------------------------------------------------------------ snapshots --

    @Test
    fun `snapshot round-trip restores interrupted sends and flags stale snapshots`() = runBlocking {
        val snapshots = WindowSnapshots(temp.newFolder(), io = Dispatchers.Unconfined)

        val queuedSending = buildOptimisticMessage(
            localId = "local-1",
            text = "hello",
            createdAt = 1000,
            status = MessageStatus.Sending,
        )
        val fresh = PersistedMessageWindow(
            messages = listOf(queuedSending, agentRow("a-1", 1, 500).asWindowMessage()),
            hasMore = true,
            oldestPositionAt = 500,
            oldestPositionSeq = 1,
            newestPositionAt = 500,
            newestPositionSeq = 1,
            epoch = 3,
        )
        snapshots.save("session-a", fresh)

        val loaded = snapshots.load("session-a")!!
        val hydrated = MessageWindowLogic.hydrate("session-a", loaded)
        // Interrupted `sending` on a queued row restores to `queued`.
        assertEquals(
            MessageStatus.Queued,
            hydrated.messages.first { it.id == "local-1" }.status,
        )
        assertEquals(3L, hydrated.epoch)
        assertTrue(!hydrated.requiresLatestReset)
        assertEquals(500L to 1L, hydrated.newestPosition!!.let { it.at to it.seq })

        // A snapshot without a usable epoch hydrates flagged for a latest reset.
        val stale = fresh.copy(epoch = null)
        snapshots.save("session-b", stale)
        val staleHydrated = MessageWindowLogic.hydrate("session-b", snapshots.load("session-b")!!)
        assertTrue(staleHydrated.requiresLatestReset)
        assertNull(staleHydrated.epoch)
    }

    @Test
    fun `snapshots are LRU-capped at ten sessions`() = runBlocking {
        val dir = temp.newFolder()
        val snapshots = WindowSnapshots(dir, io = Dispatchers.Unconfined)
        repeat(12) { index ->
            snapshots.save(
                "session-$index",
                PersistedMessageWindow(messages = listOf(agentRow("a-$index", 1, 1000).asWindowMessage())),
            )
        }
        val files = dir.listFiles { file: File -> file.name.endsWith(".window.json") }.orEmpty()
        assertEquals(10, files.size)
    }

    // ----------------------------------------------------------------- seed --

    @Test
    fun `seedFrom carries rows and older cursor but forces a latest reset`() = runTest {
        val api = GatedMessagesApi()
        val source = MessageWindowStore("old-session", api, backgroundScope)
        val seed = launch { source.syncTail() }
        runCurrent()
        api.release(latestPage(listOf(agentRow("a-1", 1, 1000)), epoch = 5, hasMore = true))
        seed.join()

        val target = MessageWindowStore("new-session", api, backgroundScope)
        target.seedFrom(source)

        val state = target.state.value
        assertEquals("new-session", state.sessionId)
        assertEquals(listOf("a-1"), state.messages.map { it.id })
        assertTrue(state.hasMore)
        assertTrue(state.requiresLatestReset)
        assertNull(state.epoch)
        assertNull(state.newestPosition)
        assertEquals(1000L to 1L, state.oldestPosition!!.let { it.at to it.seq })
    }

    // ------------------------------------------------------ mutex discipline --

    @Test
    fun `parallel mutations from real threads serialize through the state mutex`() = runBlocking {
        val api = GatedMessagesApi()
        val store = MessageWindowStore("s", api, this)
        withContext(Dispatchers.Default) {
            (0 until 64).map { index ->
                launch {
                    store.appendOptimistic(
                        localId = "local-$index",
                        text = "message $index",
                        createdAt = 1000L + index,
                    )
                    store.updateStatus("local-$index", MessageStatus.Queued)
                }
            }.forEach { it.join() }
        }
        val state = store.state.value
        assertEquals(64, state.messages.size)
        assertTrue(state.messages.all { it.status == MessageStatus.Queued && it.isQueuedForInvocation })
    }
}
