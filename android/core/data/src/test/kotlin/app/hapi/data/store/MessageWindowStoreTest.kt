package app.hapi.data.store

import app.hapi.data.api.MessagesApi
import app.hapi.data.api.MessagesQuery
import app.hapi.protocol.window.MessageStatus
import app.hapi.protocol.window.MessageWindowLogic
import app.hapi.protocol.window.MessageWindowState
import app.hapi.protocol.window.MessageViewMode
import app.hapi.protocol.window.MessagePosition
import app.hapi.protocol.window.OlderLoadOutcome
import app.hapi.protocol.window.PersistedMessageWindow
import app.hapi.protocol.window.INITIAL_PAGE_SIZE
import app.hapi.protocol.window.PAGE_SIZE
import app.hapi.protocol.window.asWindowMessage
import app.hapi.protocol.window.buildOptimisticMessage
import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.MessageContextPage
import app.hapi.protocol.wire.MessageContextResponse
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
        val contextRequests = mutableListOf<String>()
        val contextResponses = ArrayDeque<MessageContextResponse?>()
        var contextFailures = 0
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

        override suspend fun getMessageContext(sessionId: String, messageId: String): MessageContextResponse? {
            contextRequests += messageId
            if (contextFailures > 0) {
                contextFailures -= 1
                throw RuntimeException("context fetch failed")
            }
            return if (contextResponses.isEmpty()) null else contextResponses.removeFirst()
        }
    }

    // ------------------------------------------------------------ tail sync --

    @Test fun `native history retains 800 rows across SSE and preserves policy on clear`() = runTest {
        val initial = MessageWindowState(
            sessionId = "history", viewMode = MessageViewMode.History, epoch = 1,
            messages = (1L..800L).map { agentRow("a-$it", it, it * 1000).asWindowMessage() },
        )
        val api = GatedMessagesApi()
        val store = MessageWindowStore("history", api, backgroundScope,
            initialState = initial, historyRetentionLimit = 800)
        store.ingestSseMessages(listOf(agentRow("new", 801, 801000).asWindowMessage()))
        assertEquals(800, store.state.value.messages.size)
        assertEquals("a-1", store.state.value.messages.first().id)
        assertTrue(store.state.value.requiresLatestReset)
        val history = store.state.value
        api.release(latestPage(listOf(agentRow("new", 801, 801000)), epoch = 1))
        store.reconcileQueuedState()
        assertEquals(listOf<MessagesQuery>(MessagesQuery.Latest(limit = 200)), api.requests)
        val validated = store.state.value
        assertEquals(history.syncGeneration + 1, validated.syncGeneration)
        assertEquals(history.messages, validated.messages)
        assertEquals(history.oldestPosition, validated.oldestPosition)
        assertEquals(history.newestPosition, validated.newestPosition)
        assertEquals(history.hasMore, validated.hasMore)
        assertEquals(history.historyVersion, validated.historyVersion)
        assertTrue(validated.requiresLatestReset)
        assertEquals(false, validated.isSyncingTail)
        store.setViewMode(MessageViewMode.Tail)
        assertEquals(400, store.state.value.messages.size)
        assertNull(store.state.value.epoch)
        store.clear()
        assertEquals(800, store.state.value.historyRetentionLimit)
    }

    @Test fun `gap recovery replaces truncated history on epoch change or explicit reset`() = runTest {
        for ((epoch, reset) in listOf(2L to false, 1L to true)) {
            val api = GatedMessagesApi()
            val store = MessageWindowStore("history", api, backgroundScope, initialState = MessageWindowState(
                sessionId = "history", viewMode = MessageViewMode.History, epoch = 1,
                requiresLatestReset = true, hasMore = true,
                oldestPosition = MessagePosition(1000, 1), newestPosition = MessagePosition(1000, 1),
                messages = listOf(agentRow("obsolete", 1, 1000).asWindowMessage()),
            ))
            // Empty authoritative latest also covers deleted history.
            api.release(latestPage(emptyList(), epoch = epoch, reset = reset))
            store.reconcileQueuedState()
            assertEquals(1, api.requests.size)
            assertEquals(epoch, store.state.value.epoch)
            assertTrue(store.state.value.messages.isEmpty())
            assertEquals(false, store.state.value.requiresLatestReset)
            assertEquals(false, store.state.value.hasMore)
        }
    }

    @Test fun `gap recovery drains a fresh epoch check while truncated history sync is in flight`() = runTest {
        val api = GatedMessagesApi()
        val store = MessageWindowStore("history", api, backgroundScope, initialState = MessageWindowState(
            sessionId = "history", viewMode = MessageViewMode.History, epoch = 1,
            requiresLatestReset = true, messages = listOf(agentRow("obsolete", 1, 1000).asWindowMessage()),
        ))
        val first = launch { store.syncTail() }
        runCurrent()
        val recovery = launch { store.reconcileQueuedState() }
        runCurrent()
        assertEquals(1, api.requests.size)
        api.release(latestPage(emptyList(), epoch = 1))
        first.join()
        runCurrent()
        assertEquals(listOf<MessagesQuery>(MessagesQuery.Latest(200), MessagesQuery.Latest(200)), api.requests)
        assertEquals(listOf("obsolete"), store.state.value.messages.map { it.id })
        assertEquals(false, recovery.isCompleted)
        api.release(latestPage(listOf(agentRow("replacement", 2, 2000)), epoch = 2))
        recovery.join()
        assertEquals(2L, store.state.value.epoch)
        assertEquals(listOf("replacement"), store.state.value.messages.map { it.id })
    }

    @Test fun `older cursor stall is paused without applying an empty page`() = runTest {
        val api = GatedMessagesApi()
        val initial = MessageWindowState("history", hasMore = true, epoch = 1,
            oldestPosition = MessagePosition(1000, 1))
        api.release(MessagesResponse(emptyList(), MessagesPage(
            direction = "before", limit = 200, epoch = 1, reset = false,
            nextBeforeAt = 1000, nextBeforeSeq = 1, nextAfterAt = null, nextAfterSeq = null,
            snapshotHeadAt = null, snapshotHeadSeq = null, hasMore = true,
        )))
        val store = MessageWindowStore("history", api, backgroundScope, initialState = initial)
        assertEquals(OlderLoadOutcome.Stopped(OlderLoadOutcome.StopReason.CursorDidNotAdvance), store.fetchOlder())
        assertEquals(0, store.state.value.messages.size)
        assertTrue(store.state.value.hasMore)
        assertEquals(false, store.state.value.isLoadingMore)
    }

    @Test fun `cancelled fetch releases reservation and cannot overwrite a new request`() = runTest {
        val api = GatedMessagesApi()
        val store = MessageWindowStore("history", api, backgroundScope,
            initialState = MessageWindowState("history", hasMore = true, epoch = 1,
                oldestPosition = MessagePosition(1000, 1)))
        val request = backgroundScope.launch { store.fetchOlder() }
        runCurrent()
        assertTrue(store.state.value.isLoadingMore)
        assertEquals(OlderLoadOutcome.Stopped(OlderLoadOutcome.StopReason.Busy), store.fetchOlder())
        request.cancel()
        request.join()
        assertEquals(false, store.state.value.isLoadingMore)
    }

    @Test
    fun `cold sync requests the initial page size`() = runTest {
        val api = GatedMessagesApi()
        val store = MessageWindowStore("s", api, backgroundScope)

        val sync = launch { store.syncTail() }
        runCurrent()
        assertEquals(1, api.requests.size)
        assertTrue(api.requests.single() is MessagesQuery.Latest)
        assertEquals(INITIAL_PAGE_SIZE, (api.requests.single() as MessagesQuery.Latest).limit)

        api.release(latestPage(listOf(agentRow("a-1", 1, 1000)), epoch = 0))
        sync.join()
    }

    @Test
    fun `reset sync keeps the full latest page size`() = runTest {
        val api = GatedMessagesApi()
        val initial = MessageWindowLogic.createState("s").copy(requiresLatestReset = true)
        val store = MessageWindowStore("s", api, backgroundScope, initialState = initial)

        val sync = launch { store.syncTail() }
        runCurrent()
        assertEquals(1, api.requests.size)
        assertTrue(api.requests.single() is MessagesQuery.Latest)
        assertEquals(PAGE_SIZE, (api.requests.single() as MessagesQuery.Latest).limit)

        api.release(latestPage(listOf(agentRow("a-1", 1, 1000)), epoch = 1))
        sync.join()
    }

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

    // ------------------------------------------------- gap recovery upsert --

    /** Hub-merged tool-call row: the hub folds the streamed tool-call and its
     *  result into one row keyed by the call id, keeping the row's original
     *  cursor position. */
    private fun toolCallRow(id: String, seq: Long, at: Long, status: String): DecryptedMessage =
        DecryptedMessage(
            id = id,
            seq = seq,
            createdAt = at,
            invokedAt = OptionalField.Present(at),
            content = buildJsonObject {
                put("role", "agent")
                put("content", buildJsonObject {
                    put("type", "codex")
                    put("data", buildJsonObject {
                        put("type", "tool-call")
                        put("callId", "call-1")
                        put("name", "Bash")
                        put("input", buildJsonObject { put("command", "ls") })
                        put("status", status)
                    })
                })
            },
        )

    /** Warm tail window: rows r-1..r-9 plus a merged tool-call row at seq 10. */
    private fun warmRecoveryWindow(id: String, callStatus: String): MessageWindowState =
        MessageWindowState(
            sessionId = id, epoch = 1, hasMore = true,
            oldestPosition = MessagePosition(1000, 1), newestPosition = MessagePosition(10_000, 10),
            messages = (1L..9L).map { agentRow("r-$it", it, it * 1000).asWindowMessage() } +
                toolCallRow("call-row", 10, 10_000, callStatus).asWindowMessage(),
        )

    @Test
    fun `gap recovery catches up missed rows and reconciles merged rows from the latest page`() = runTest {
        val stale = toolCallRow("call-row", 10, 10_000, "in_progress")
        val merged = toolCallRow("call-row", 10, 10_000, "completed")
        val api = GatedMessagesApi()
        val store = MessageWindowStore("gap-upsert", api, backgroundScope,
            initialState = warmRecoveryWindow("gap-upsert", "in_progress"))
        api.release(afterPage(
            listOf(agentRow("r-11", 11, 11_000), agentRow("r-12", 12, 12_000)),
            epoch = 1, nextAfter = 12_000L to 12L, hasMore = false,
        ))
        val page = (1L..9L).map { agentRow("r-$it", it, it * 1000) } +
            merged + listOf(agentRow("r-11", 11, 11_000), agentRow("r-12", 12, 12_000))
        api.release(latestPage(page, epoch = 1))

        store.recoverAfterGapResume()

        // Catch-up first (newer rows only), then the authoritative latest page
        // applied as an upsert: rows present in the page are replaced by id —
        // the merged tool-call row's content converges — while rows the page
        // cannot reach and the hasMore/oldest cursor survive.
        assertEquals(listOf<MessagesQuery>(
            MessagesQuery.After(afterAt = 10_000, afterSeq = 10, untilAt = null, untilSeq = null, epoch = 1, limit = 200),
            MessagesQuery.Latest(limit = 200),
        ), api.requests)
        val state = store.state.value
        assertEquals(
            (1L..9L).map { "r-$it" } + "call-row" + "r-11" + "r-12",
            state.messages.map { it.id },
        )
        assertEquals(merged.content, state.messages.first { it.id == "call-row" }.wire.content)
        assertEquals(12, state.messages.size)
        assertEquals(12L, state.newestPosition!!.seq)
        assertEquals(1L, state.oldestPosition!!.seq)
        assertTrue(state.hasMore)
        assertNull(state.warning)
    }

    @Test
    fun `failed catch-up stops before the latest page and the next recovery retries`() = runTest {
        val stale = toolCallRow("call-row", 10, 10_000, "in_progress")
        val merged = toolCallRow("call-row", 10, 10_000, "completed")
        val api = GatedMessagesApi()
        val failing = object : MessagesApi by api {
            var afterCalls = 0
            override suspend fun getMessages(sessionId: String, query: MessagesQuery): MessagesResponse {
                if (query is MessagesQuery.After) {
                    afterCalls += 1
                    if (afterCalls == 1) throw RuntimeException("catch-up sync failed")
                }
                return api.getMessages(sessionId, query)
            }
        }
        val store = MessageWindowStore("gap-retry", failing, backgroundScope,
            initialState = warmRecoveryWindow("gap-retry", "in_progress"))

        store.recoverAfterGapResume()

        // The failed catch-up leaves the failure warning, keeps the original
        // cursor, and never advances to the latest page (the delegate saw no
        // second request).
        assertEquals(1, failing.afterCalls)
        assertTrue(api.requests.isEmpty())
        val failed = store.state.value
        assertEquals("catch-up sync failed", failed.warning)
        assertEquals(listOf("r-1", "r-2", "r-3", "r-4", "r-5", "r-6", "r-7", "r-8", "r-9", "call-row"),
            failed.messages.map { it.id })

        // The next recovery retries the whole recovery: catch-up, then the
        // latest-page upsert that converges the merged row.
        api.release(afterPage(
            listOf(agentRow("r-11", 11, 11_000), agentRow("r-12", 12, 12_000)),
            epoch = 1, nextAfter = 12_000L to 12L, hasMore = false,
        ))
        val page = (1L..9L).map { agentRow("r-$it", it, it * 1000) } +
            merged + listOf(agentRow("r-11", 11, 11_000), agentRow("r-12", 12, 12_000))
        api.release(latestPage(page, epoch = 1))
        store.recoverAfterGapResume()

        assertEquals(listOf<MessagesQuery>(
            MessagesQuery.After(afterAt = 10_000, afterSeq = 10, untilAt = null, untilSeq = null, epoch = 1, limit = 200),
            MessagesQuery.Latest(limit = 200),
        ), api.requests)
        val state = store.state.value
        assertEquals(merged.content, state.messages.first { it.id == "call-row" }.wire.content)
        assertNull(state.warning)
    }

    @Test
    fun `recovery catch-up overflowing the history budget stays reset-marked`() = runTest {
        val cached = (1L..600L).map { agentRow("r-$it", it, it * 1000) }
        val caughtUp = (601L..800L).map { agentRow("r-$it", it, it * 1000) }
        val recoveryPage = (901L..1100L).map { agentRow("r-$it", it, it * 1000) }
        val api = GatedMessagesApi()
        val store = MessageWindowStore("gap-overflow", api, backgroundScope, initialState = MessageWindowState(
            sessionId = "gap-overflow", viewMode = MessageViewMode.History, epoch = 1, hasMore = true,
            oldestPosition = MessagePosition(1000, 1), newestPosition = MessagePosition(600_000, 600),
            messages = cached.map { it.asWindowMessage() },
        ))
        api.release(afterPage(caughtUp, epoch = 1, nextAfter = 800_000L to 800L, hasMore = true))
        api.release(latestPage(recoveryPage, epoch = 1))

        store.recoverAfterGapResume()

        // The catch-up page overflowed the 600-row history budget: the
        // prepend trim kept rows 1-600, dropped the caught-up 601-800, and
        // marked the window for a reset. The recovery must not reconcile the
        // latest page on top — rows 601-900 would sit between the two
        // cursors, unreachable from either — and must not consume the
        // recovery flags.
        val overflowed = store.state.value
        assertEquals((1L..600L).map { "r-$it" }, overflowed.messages.map { it.id })
        assertTrue(overflowed.requiresLatestReset)
        assertTrue(overflowed.pendingGapRecovery)
        assertNull(overflowed.warning)

        // Returning to the tail view applies the authoritative replacement
        // and closes the hole.
        store.setViewMode(MessageViewMode.Tail)
        store.syncTail()

        val replaced = store.state.value
        assertEquals((901L..1100L).map { "r-$it" }, replaced.messages.map { it.id })
        assertEquals(false, replaced.requiresLatestReset)
        assertEquals(false, replaced.pendingGapRecovery)
        assertEquals(901L, replaced.oldestPosition!!.seq)
        assertNull(replaced.warning)
    }

    @Test
    fun `no-news recovery keeps the loaded older cursor`() = runTest {
        val held = (1L..800L).map { agentRow("r-$it", it, it * 1000) }
        val api = GatedMessagesApi()
        val store = MessageWindowStore("gap-cursor", api, backgroundScope, initialState = MessageWindowState(
            sessionId = "gap-cursor", epoch = 1, hasMore = true,
            oldestPosition = MessagePosition(1000, 1), newestPosition = MessagePosition(800_000, 800),
            messages = held.map { it.asWindowMessage() },
        ))
        api.release(afterPage(emptyList(), epoch = 1, nextAfter = 800_000L to 800L, hasMore = false))
        val page = (601L..800L).map { agentRow("r-$it", it, it * 1000) }
        api.release(latestPage(page, epoch = 1, hasMore = true))

        store.recoverAfterGapResume()

        // The latest page excludes the held rows 1-600: the older-paging
        // cursor must stay at the window edge (row 1) instead of jumping to
        // the page's own bound (row 600), like the web keeps it.
        val state = store.state.value
        assertEquals(800, state.messages.size)
        assertEquals(1L, state.oldestPosition!!.seq)
        assertTrue(state.hasMore)
    }

    @Test
    fun `refreshes a retained non-terminal tool-call row the latest page cannot reach`() = runTest {
        val stale = toolCallRow("call-row", 10, 10_000, "in_progress")
        val merged = toolCallRow("call-row", 10, 10_000, "completed")
        val cachedTail = (1L..9L).map { agentRow("r-$it", it, it * 1000) }
        val missed = (11L..310L).map { agentRow("r-$it", it, it * 1000) }
        val latestPageRows = (111L..310L).map { agentRow("r-$it", it, it * 1000) }
        val api = GatedMessagesApi()
        val store = MessageWindowStore("gap-sweep", api, backgroundScope, initialState = MessageWindowState(
            sessionId = "gap-sweep", epoch = 1, hasMore = true,
            oldestPosition = MessagePosition(1000, 1), newestPosition = MessagePosition(10_000, 10),
            messages = cachedTail.map { it.asWindowMessage() } + stale.asWindowMessage(),
        ))
        api.release(afterPage(missed, epoch = 1, nextAfter = 310_000L to 310L, hasMore = false))
        api.release(latestPage(latestPageRows, epoch = 1))
        api.contextResponses += MessageContextResponse(
            messages = listOf(merged),
            targetMessageId = "call-row",
            page = MessageContextPage(
                epoch = 1, nextBeforeSeq = 1, nextBeforeAt = 1000,
                snapshotHeadSeq = 310, snapshotHeadAt = 310_000, hasMore = false,
            ),
        )

        store.recoverAfterGapResume()

        // The call was enriched while disconnected and 300 newer rows pushed
        // it beyond the latest page: only a by-id context refresh can
        // converge the cached card.
        assertEquals(listOf("call-row"), api.contextRequests)
        val state = store.state.value
        assertEquals(merged.content, state.messages.first { it.id == "call-row" }.wire.content)
        assertEquals(310, state.messages.size)
        assertEquals(310L, state.newestPosition!!.seq)
        assertNull(state.warning)
    }

    @Test
    fun `finishes the run with a warning when the context refresh finds no row`() = runTest {
        val stale = toolCallRow("call-row", 10, 10_000, "in_progress")
        val cachedTail = (1L..9L).map { agentRow("r-$it", it, it * 1000) }
        val missed = (11L..310L).map { agentRow("r-$it", it, it * 1000) }
        val latestPageRows = (111L..310L).map { agentRow("r-$it", it, it * 1000) }
        val api = GatedMessagesApi()
        val store = MessageWindowStore("gap-sweep-missing", api, backgroundScope, initialState = MessageWindowState(
            sessionId = "gap-sweep-missing", epoch = 1, hasMore = true,
            oldestPosition = MessagePosition(1000, 1), newestPosition = MessagePosition(10_000, 10),
            messages = cachedTail.map { it.asWindowMessage() } + stale.asWindowMessage(),
        ))
        api.release(afterPage(missed, epoch = 1, nextAfter = 310_000L to 310L, hasMore = false))
        api.release(latestPage(latestPageRows, epoch = 1))

        store.recoverAfterGapResume()

        // The context endpoint no longer knows the row: the sweep leaves it
        // as is, surfaces the warning, and finishes the run's bookkeeping
        // instead of leaving the window marked syncing.
        assertEquals(listOf("call-row"), api.contextRequests)
        val state = store.state.value
        assertEquals(stale.content, state.messages.first { it.id == "call-row" }.wire.content)
        assertTrue(state.warning != null)
        assertEquals(false, state.isSyncingTail)
    }

    @Test
    fun `an ordinary sync retries the sweep when the context refresh fails`() = runTest {
        val stale = toolCallRow("call-row", 10, 10_000, "in_progress")
        val merged = toolCallRow("call-row", 10, 10_000, "completed")
        val cachedTail = (1L..9L).map { agentRow("r-$it", it, it * 1000) }
        val missed = (11L..310L).map { agentRow("r-$it", it, it * 1000) }
        val latestPageRows = (111L..310L).map { agentRow("r-$it", it, it * 1000) }
        val api = GatedMessagesApi()
        val store = MessageWindowStore("gap-sweep-retry", api, backgroundScope, initialState = MessageWindowState(
            sessionId = "gap-sweep-retry", epoch = 1, hasMore = true,
            oldestPosition = MessagePosition(1000, 1), newestPosition = MessagePosition(10_000, 10),
            messages = cachedTail.map { it.asWindowMessage() } + stale.asWindowMessage(),
        ))
        api.release(afterPage(missed, epoch = 1, nextAfter = 310_000L to 310L, hasMore = false))
        api.release(latestPage(latestPageRows, epoch = 1))
        api.contextFailures = 1

        store.recoverAfterGapResume()

        // The failed refresh surfaces the warning and leaves the recovery
        // pending, so the next ORDINARY sync retries the sweep instead of
        // leaving the enriched cached call stale with no retry path.
        assertEquals(listOf("call-row"), api.contextRequests)
        val failed = store.state.value
        assertTrue(failed.warning != null)
        assertTrue(failed.pendingGapRecovery)

        api.release(afterPage(missed, epoch = 1, nextAfter = 310_000L to 310L, hasMore = false))
        api.release(latestPage(latestPageRows, epoch = 1))
        api.contextResponses += MessageContextResponse(
            messages = listOf(merged),
            targetMessageId = "call-row",
            page = MessageContextPage(
                epoch = 1, nextBeforeSeq = 1, nextBeforeAt = 1000,
                snapshotHeadSeq = 310, snapshotHeadAt = 310_000, hasMore = false,
            ),
        )
        store.syncTail()

        val state = store.state.value
        assertEquals(2, api.contextRequests.size)
        assertEquals(merged.content, state.messages.first { it.id == "call-row" }.wire.content)
        assertEquals(false, state.pendingGapRecovery)
        assertNull(state.warning)
    }
}
