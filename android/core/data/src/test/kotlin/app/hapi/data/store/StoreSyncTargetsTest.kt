package app.hapi.data.store

import app.hapi.data.api.MessagesApi
import app.hapi.data.api.MessagesQuery
import app.hapi.data.sse.EngineEvent
import app.hapi.data.sse.SseSubscriptionKey
import app.hapi.data.sse.SyncEventRouter
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MessagesPage
import app.hapi.protocol.wire.MessagesResponse
import app.hapi.protocol.wire.QueuedStateResponse
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SyncEvent
import app.hapi.protocol.wire.SyncEvents
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

class FakeSessionListStore : SessionListStore {
    override val sessions: StateFlow<List<SessionSummary>> = MutableStateFlow(emptyList())
    val calls = mutableListOf<String>()

    override suspend fun refresh() {
        calls += "refresh"
    }

    override fun scheduleRefresh() {
        calls += "scheduleRefresh"
    }

    override suspend fun fullResync() {
        calls += "fullResync"
    }

    override fun applySessionEvent(scope: SseSubscriptionKey, event: SyncEvent) {
        calls += "session:${event::class.simpleName}"
    }

    override suspend fun setPinMode(sessionId: String, mode: String) {
        calls += "pin:$sessionId:$mode"
    }

    override suspend fun archiveSession(sessionId: String) {
        calls += "archive:$sessionId"
    }

    override suspend fun renameSession(sessionId: String, name: String) {
        calls += "rename:$sessionId:$name"
    }

    override suspend fun deleteSession(sessionId: String) {
        calls += "delete:$sessionId"
    }

    override suspend fun reopenSession(sessionId: String): app.hapi.protocol.wire.ReopenSessionResponse {
        calls += "reopen:$sessionId"
        return app.hapi.protocol.wire.ReopenSessionResponse(sessionId = sessionId, resumed = true)
    }
}

class FakeMachineListStore : MachineListStore {
    override val machines: StateFlow<List<Machine>> = MutableStateFlow(emptyList())
    val calls = mutableListOf<String>()

    override suspend fun refresh() {
        calls += "refresh"
    }

    override fun scheduleRefresh() {
        calls += "scheduleRefresh"
    }

    override fun applyMachineEvent(event: SyncEvent.MachineUpdated) {
        calls += "machine:${event.machineId}"
    }
}

/** Routing rules of the M2b `SyncTargets` implementation, with fake stores. */
class StoreSyncTargetsTest {

    private val global = SseSubscriptionKey.Global
    private val sessionScope = SseSubscriptionKey.Session("s1")

    private fun sync(json: String): EngineEvent.Sync = EngineEvent.Sync(SyncEvents.parse(json))

    @Test
    fun `session lifecycle events reach the session store`() = runTest {
        val sessions = FakeSessionListStore()
        val router = SyncEventRouter(StoreSyncTargets(sessions, FakeMachineListStore(), backgroundScope))
        router.route(global, sync("""{"type":"session-updated","sessionId":"s1","data":{"active":true}}"""))
        router.route(global, sync("""{"type":"session-removed","sessionId":"s1"}"""))
        router.route(global, sync("""{"type":"session-ended","sessionId":"s1","reason":"completed"}"""))
        assertEquals(
            listOf("session:SessionUpdated", "session:SessionRemoved", "session:SessionEnded"),
            sessions.calls,
        )
    }

    @Test
    fun `machine-updated reaches the machine store`() = runTest {
        val machines = FakeMachineListStore()
        val router = SyncEventRouter(StoreSyncTargets(FakeSessionListStore(), machines, backgroundScope))
        router.route(global, sync("""{"type":"machine-updated","machineId":"m1","data":null}"""))
        assertEquals(listOf("machine:m1"), machines.calls)
    }

    @Test
    fun `global message-stream events refresh the session list`() = runTest {
        val sessions = FakeSessionListStore()
        val router = SyncEventRouter(StoreSyncTargets(sessions, FakeMachineListStore(), backgroundScope))
        router.route(global, sync("""{"type":"messages-invalidated","sessionId":"s1"}"""))
        router.route(global, sync("""{"type":"messages-consumed","sessionId":"s1","localIds":["l1"],"invokedAt":1}"""))
        router.route(global, sync("""{"type":"message-cancelled","sessionId":"s1","messageId":"m1"}"""))
        router.route(global, sync("""{"type":"scheduled-matured","sessionId":"s1"}"""))
        assertEquals(List(4) { "scheduleRefresh" }, sessions.calls)
    }

    @Test
    fun `message-received refreshes the list only when scheduled`() = runTest {
        val sessions = FakeSessionListStore()
        val router = SyncEventRouter(StoreSyncTargets(sessions, FakeMachineListStore(), backgroundScope))
        router.route(
            global,
            sync("""{"type":"message-received","sessionId":"s1","message":{"id":"m1","createdAt":1}}"""),
        )
        assertEquals(emptyList(), sessions.calls)
        router.route(
            global,
            sync("""{"type":"message-received","sessionId":"s1","message":{"id":"m2","createdAt":1,"scheduledAt":99}}"""),
        )
        assertEquals(listOf("scheduleRefresh"), sessions.calls)
    }

    @Test
    fun `session-scoped message events do not touch the list (window territory)`() = runTest {
        val sessions = FakeSessionListStore()
        val router = SyncEventRouter(StoreSyncTargets(sessions, FakeMachineListStore(), backgroundScope))
        router.route(sessionScope, sync("""{"type":"messages-invalidated","sessionId":"s1"}"""))
        assertEquals(emptyList(), sessions.calls)
    }

    @Test
    fun `gap handshake triggers the full resync`() = runTest {
        val sessions = FakeSessionListStore()
        val machines = FakeMachineListStore()
        // The launched resync must run on a foreground test scope —
        // advanceUntilIdle does not execute background-scope-only tasks.
        val router = SyncEventRouter(StoreSyncTargets(sessions, machines, this))
        router.route(global, EngineEvent.Handshake(subscriptionId = "sub-1", resume = EngineEvent.Resume.Gap))
        advanceUntilIdle()
        assertEquals(listOf("fullResync"), sessions.calls)
        assertEquals(listOf("refresh"), machines.calls)
    }

    @Test
    fun `ok handshake skips the resync`() = runTest {
        val sessions = FakeSessionListStore()
        val machines = FakeMachineListStore()
        val router = SyncEventRouter(StoreSyncTargets(sessions, machines, this))
        router.route(global, EngineEvent.Handshake(subscriptionId = "sub-1", resume = EngineEvent.Resume.Ok))
        advanceUntilIdle()
        assertEquals(emptyList(), sessions.calls)
        assertEquals(emptyList(), machines.calls)
    }

    // ---------------------------------------- window forwarding (M2c half) --

    /** Latest-page-scripted api + an opened window for "s1". */
    private suspend fun openWindow(scope: kotlinx.coroutines.CoroutineScope): Pair<MessageWindowStores, MessageWindowStore> {
        val api = object : MessagesApi {
            override suspend fun getMessages(sessionId: String, query: MessagesQuery) =
                MessagesResponse(
                    messages = emptyList(),
                    page = MessagesPage(
                        direction = "latest", limit = 200, epoch = 1, reset = false, hasMore = false,
                    ),
                )

            override suspend fun getQueuedState(sessionId: String, localIds: List<String>) =
                QueuedStateResponse(emptyList(), emptyList())
        }
        val windows = MessageWindowStores(api = api, scope = scope)
        return windows to windows.open("s1")
    }

    @Test
    fun `session-pipe message-received ingests into the open window, global does not`() = runTest {
        val (windows, store) = openWindow(backgroundScope)
        val router = SyncEventRouter(
            StoreSyncTargets(FakeSessionListStore(), FakeMachineListStore(), backgroundScope, windows),
        )

        router.route(
            global,
            sync("""{"type":"message-received","sessionId":"s1","message":{"id":"m1","seq":1,"createdAt":1,"invokedAt":1}}"""),
        )
        advanceUntilIdle()
        assertEquals(emptyList(), store.state.value.messages.map { it.id })

        router.route(
            sessionScope,
            sync("""{"type":"message-received","sessionId":"s1","message":{"id":"m1","seq":1,"createdAt":1,"invokedAt":1}}"""),
        )
        store.state.first { it.messages.map { row -> row.id } == listOf("m1") }
    }

    @Test
    fun `global messages-consumed stamps queued rows in the open window`() = runTest {
        val (windows, store) = openWindow(backgroundScope)
        store.appendOptimistic(localId = "l1", text = "queued text", createdAt = 5)
        store.updateStatus("l1", app.hapi.protocol.window.MessageStatus.Queued)
        val router = SyncEventRouter(
            StoreSyncTargets(FakeSessionListStore(), FakeMachineListStore(), backgroundScope, windows),
        )

        router.route(
            global,
            sync("""{"type":"messages-consumed","sessionId":"s1","localIds":["l1"],"invokedAt":42}"""),
        )
        store.state.first { it.messages.singleOrNull()?.invokedAtOrNull == 42L }
    }

    @Test
    fun `session-removed clears the open window`() = runTest {
        val (windows, store) = openWindow(backgroundScope)
        store.appendOptimistic(localId = "l1", text = "row", createdAt = 5)
        assertEquals(1, store.state.value.messages.size)
        val router = SyncEventRouter(
            StoreSyncTargets(FakeSessionListStore(), FakeMachineListStore(), backgroundScope, windows),
        )

        router.route(global, sync("""{"type":"session-removed","sessionId":"s1"}"""))
        store.state.first { it.messages.isEmpty() }
    }

    @Test
    fun `toast events reach the callback`() = runTest {
        val toasts = mutableListOf<SyncEvent.Toast>()
        val router = SyncEventRouter(
            StoreSyncTargets(
                FakeSessionListStore(),
                FakeMachineListStore(),
                backgroundScope,
                onToastEvent = { toasts += it },
            )
        )
        router.route(
            global,
            sync("""{"type":"toast","data":{"title":"t","body":"b","sessionId":"s1","url":"/sessions/s1"}}"""),
        )
        assertEquals(1, toasts.size)
        assertEquals("t", toasts.single().data.title)
    }
}
