package app.hapi.companion.feature.sessions

import app.hapi.data.store.LastSeenStore
import app.hapi.data.store.MachineListStore
import app.hapi.data.store.SessionListStore
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.MachineMetadata
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SessionSummaryMetadata
import app.hapi.protocol.wire.SummaryText
import app.hapi.protocol.wire.SyncEvent
import app.hapi.protocol.wire.WorktreeMetadata
import app.hapi.protocol.wire.sortSessionSummaries
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest

// ------------------------------------------------------------------ fakes --

private class FakeSessionStore : SessionListStore {
    val backing = MutableStateFlow<List<SessionSummary>>(emptyList())
    override val sessions: StateFlow<List<SessionSummary>> = backing
    val calls = MutableStateFlow<List<String>>(emptyList())
    var failRefresh = false

    fun set(vararg rows: SessionSummary) {
        backing.value = sortSessionSummaries(rows.toList())
    }

    private fun record(call: String) {
        calls.value = calls.value + call
    }

    override suspend fun refresh() {
        record("refresh")
        if (failRefresh) throw RuntimeException("offline")
    }

    override fun scheduleRefresh() = record("scheduleRefresh")

    override suspend fun fullResync() = record("fullResync")

    override fun applySessionEvent(scope: app.hapi.data.sse.SseSubscriptionKey, event: SyncEvent) {
        record("event:${event::class.simpleName}")
    }

    override suspend fun setPinMode(sessionId: String, mode: String) {
        record("pin:$sessionId:$mode")
        if (mode == "global") throw RuntimeException("pin exploded")
    }

    override suspend fun archiveSession(sessionId: String) = record("archive:$sessionId")

    var renameFailure: Exception? = null
    override suspend fun renameSession(sessionId: String, name: String) {
        record("rename:$sessionId:$name")
        renameFailure?.let { throw it }
    }

    var deleteFailure: Exception? = null
    override suspend fun deleteSession(sessionId: String) {
        record("delete:$sessionId")
        deleteFailure?.let { throw it }
    }

    var reopenResult: app.hapi.protocol.wire.ReopenSessionResponse? = null
    var reopenFailure: Exception? = null
    override suspend fun reopenSession(sessionId: String): app.hapi.protocol.wire.ReopenSessionResponse {
        record("reopen:$sessionId")
        reopenFailure?.let { throw it }
        return reopenResult
            ?: app.hapi.protocol.wire.ReopenSessionResponse(sessionId = sessionId, resumed = true)
    }
}

private class FakeMachineStore : MachineListStore {
    val backing = MutableStateFlow<List<Machine>>(emptyList())
    override val machines: StateFlow<List<Machine>> = backing
    var refreshes = 0

    override suspend fun refresh() {
        refreshes++
    }

    override fun scheduleRefresh() {}
    override fun applyMachineEvent(event: SyncEvent.MachineUpdated) {}
}

private fun summary(
    id: String,
    updatedAt: Long = 0,
    active: Boolean = false,
    machineId: String? = null,
    name: String? = null,
    summaryText: String? = null,
    path: String = "/repo/app",
    worktree: WorktreeMetadata? = null,
): SessionSummary = SessionSummary(
    id = id,
    active = active,
    thinking = false,
    activeAt = 0,
    updatedAt = updatedAt,
    metadata = SessionSummaryMetadata(
        name = name,
        path = path,
        machineId = machineId,
        summary = summaryText?.let { SummaryText(it) },
        flavor = "claude",
        worktree = worktree,
    ),
    metadataVersion = 0,
    agentStateVersion = 0,
    todosUpdatedAt = 0,
    todoProgress = null,
    pendingRequestsCount = 0,
    pendingRequestKinds = emptyList(),
    pendingRequests = emptyList(),
    backgroundTaskCount = 0,
    futureScheduledMessageCount = 0,
    nextScheduledAt = null,
    model = null,
    modelReasoningEffort = null,
    effort = null,
)

private fun machine(id: String, host: String, displayName: String? = null): Machine = Machine(
    id = id,
    namespace = "default",
    seq = 1,
    createdAt = 1,
    updatedAt = 1,
    active = true,
    activeAt = 1,
    metadata = MachineMetadata(
        host = host,
        platform = "linux",
        happyCliVersion = "1.0.0",
        displayName = displayName,
    ),
    metadataVersion = 1,
    runnerState = null,
    runnerStateVersion = 1,
)

private fun TestScope.buildViewModel(
    sessions: FakeSessionStore = FakeSessionStore(),
    machines: FakeMachineStore = FakeMachineStore(),
): Triple<SessionListViewModel, FakeSessionStore, FakeMachineStore> {
    val viewModel = SessionListViewModel(
        sessionStore = sessions,
        machineStore = machines,
        lastSeenStore = LastSeenStore(backgroundScope),
        scope = backgroundScope,
        hubKey = "hub-test",
    )
    return Triple(viewModel, sessions, machines)
}

// ------------------------------------------------------------------ tests --

class SessionListViewModelTest {

    @Test
    fun `uiState maps rows with titles meta and unread`() = runTest {
        val (viewModel, sessions, machines) = buildViewModel()
        machines.backing.value = listOf(machine("m1", host = "devbox.local", displayName = "Devbox"))
        sessions.set(
            summary("s1", updatedAt = 900, name = "Named session", machineId = "m1", summaryText = "working on it"),
            summary("s2", updatedAt = 500, summaryText = "summary title", machineId = "offline-machine-id"),
            summary("s3", updatedAt = 100, path = "/repo/tail-name"),
        )

        val state = viewModel.uiState.first { it.rows.size == 3 }
        val byId = state.rows.associateBy { it.id }

        // Title cascade: name → summary text → path tail.
        assertEquals("Named session", byId.getValue("s1").title)
        assertEquals("working on it", byId.getValue("s1").subtitle)
        assertEquals("summary title", byId.getValue("s2").title)
        // Summary text already used as the title → no subtitle (the path no
        // longer backfills it; the meta line carries the project instead).
        assertNull(byId.getValue("s2").subtitle)
        assertEquals("tail-name", byId.getValue("s3").title)

        // Meta = `project · machine`: last two path segments, then the
        // machine label (displayName wins; unlisted machines shorten the id;
        // shown because several machines are known and no filter is active).
        assertEquals("repo/app · Devbox", byId.getValue("s1").meta)
        assertEquals("repo/app · offline-", byId.getValue("s2").meta)
        assertEquals("repo/tail-name", byId.getValue("s3").meta)

        // No baseline seeded (no successful refresh yet) → activity is unread.
        assertTrue(byId.getValue("s1").unread)
    }

    @Test
    fun `machine filter chips need two machines and filter the rows`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("s1", updatedAt = 900, machineId = "m1"),
            summary("s2", updatedAt = 800, machineId = "m2"),
            summary("s3", updatedAt = 700, machineId = "m1"),
        )

        var state = viewModel.uiState.first { it.rows.size == 3 }
        assertTrue(state.showMachineFilterBar)
        assertEquals(listOf("m1", "m2"), state.machineFilters.map { it.id })
        assertEquals(listOf(2, 1), state.machineFilters.map { it.sessionCount })

        // Unfiltered multi-machine view carries the machine in the meta line…
        assertEquals("repo/app · m1", state.rows.first { it.id == "s1" }.meta)

        viewModel.setMachineFilter("m1")
        state = viewModel.uiState.first { it.activeMachineFilter == "m1" }
        assertEquals(listOf("s1", "s3"), state.rows.map { it.id })
        // …and an active filter drops it: every visible row shares the machine.
        assertEquals(listOf("repo/app", "repo/app"), state.rows.map { it.meta })

        // A filter whose machine lost its sessions falls back to All.
        sessions.set(summary("s2", updatedAt = 800, machineId = "m2"))
        state = viewModel.uiState.first { it.rows.size == 1 }
        assertNull(state.activeMachineFilter)
        assertEquals(listOf("s2"), state.rows.map { it.id })
    }

    @Test
    fun `single machine hides the filter bar and never filters`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(summary("s1", machineId = "m1"), summary("s2", machineId = "m1"))
        viewModel.setMachineFilter("m9")
        val state = viewModel.uiState.first { it.rows.size == 2 }
        assertFalse(state.showMachineFilterBar)
        assertNull(state.activeMachineFilter)
        // A single machine is not worth naming on every row.
        assertEquals(listOf("repo/app", "repo/app"), state.rows.map { it.meta })
    }

    @Test
    fun `meta line derives the project from the worktree base path`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary(
                "s1",
                updatedAt = 900,
                path = "/data/worktrees/231",
                worktree = WorktreeMetadata(basePath = "/data/github/hapi", branch = "fix/insets", name = "231"),
            ),
            summary(
                "s2",
                updatedAt = 800,
                path = "/data/worktrees/nameless",
                worktree = WorktreeMetadata(basePath = "/data/github/hapi", branch = "main", name = ""),
            ),
            summary("s3", updatedAt = 700, path = "/srv", name = "Named", summaryText = "Ship it"),
        )

        val state = viewModel.uiState.first { it.rows.size == 3 }
        val byId = state.rows.associateBy { it.id }

        // Worktree rows: project from the base path, then the worktree name
        // (branch when the name is blank). One machine → no machine suffix.
        assertEquals("github/hapi · 231", byId.getValue("s1").meta)
        assertEquals("github/hapi · main", byId.getValue("s2").meta)
        // Single-segment paths render as-is.
        assertEquals("srv", byId.getValue("s3").meta)

        // Subtitle is the summary only — never the path.
        assertNull(byId.getValue("s1").subtitle)
        assertEquals("Ship it", byId.getValue("s3").subtitle)
    }

    @Test
    fun `refresh flips the flags and failure marks offline`() = runTest {
        val (viewModel, sessions, machines) = buildViewModel()
        viewModel.refresh()
        var state = viewModel.uiState.first { it.hasLoaded }
        assertFalse(state.isOffline)
        assertEquals(1, machines.refreshes)
        assertEquals(listOf("refresh"), sessions.calls.value)

        sessions.failRefresh = true
        viewModel.refresh()
        state = viewModel.uiState.first { it.isOffline }
        assertFalse(state.isRefreshing)
    }

    @Test
    fun `start runs the entry refresh (the global pipe belongs to HubGraph)`() = runTest {
        // SSE handshake/resync behavior for the global pipe is covered by
        // GlobalSsePipeTest — this VM only owns the explicit entry refresh.
        val (viewModel, sessions, _) = buildViewModel()
        viewModel.start()
        sessions.calls.first { "refresh" in it }
        assertFalse("fullResync" in sessions.calls.value)
        viewModel.stop()
    }

    @Test
    fun `pin failure surfaces on the errors flow`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(summary("s1"))
        viewModel.setPinMode("s1", PinMode.Project)
        sessions.calls.first { "pin:s1:project" in it }

        var seen: SessionListError? = null
        val collector = launch { seen = viewModel.errors.first() }
        viewModel.setPinMode("s1", PinMode.Global) // fake throws for global
        sessions.calls.first { "pin:s1:global" in it }
        collector.join()
        assertTrue(seen is SessionListError.PinFailed)
    }

    @Test
    fun `onSessionOpened stamps the last-seen watermark and clears unread`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(summary("s1", updatedAt = 900))
        assertTrue(viewModel.uiState.first { it.rows.size == 1 }.rows.single().unread)

        viewModel.onSessionOpened("s1")
        assertFalse(viewModel.uiState.first { !it.rows.single().unread }.rows.single().unread)
    }

    // -------------------------------------------- rename / delete / reopen --

    @Test
    fun `rename trims and routes to the store, surfacing failures`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(summary("s1"))

        viewModel.renameSession("s1", "  Fresh title ")
        sessions.calls.first { "rename:s1:Fresh title" in it }

        viewModel.renameSession("s1", "   ") // blank: never sent
        assertEquals(1, sessions.calls.value.count { it.startsWith("rename:") })

        var seen: SessionListError? = null
        val collector = launch { seen = viewModel.errors.first() }
        sessions.renameFailure = RuntimeException("boom")
        viewModel.renameSession("s1", "Another")
        collector.join()
        assertTrue(seen is SessionListError.RenameFailed)
    }

    @Test
    fun `delete failure with 409 gets the active-session wording`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(summary("s1", active = true))

        var seen: SessionListError? = null
        val collector = launch { seen = viewModel.errors.first() }
        sessions.deleteFailure = app.hapi.data.api.ApiError(409, code = "session_active")
        viewModel.deleteSession("s1")
        collector.join()

        val error = seen
        assertTrue(error is SessionListError.DeleteFailed)
        // The UI resolves the localized "archive it first" wording from this flag.
        assertTrue(error.stillActive)
    }

    @Test
    fun `reopen emits the returned (possibly superseding) id`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(summary("s1"))
        sessions.reopenResult =
            app.hapi.protocol.wire.ReopenSessionResponse(sessionId = "s2", resumed = false)

        var target: String? = null
        val collector = launch { target = viewModel.reopened.first() }
        viewModel.reopenSession("s1")
        collector.join()

        assertEquals("s2", target)
        assertTrue("reopen:s1" in sessions.calls.value)
    }

    @Test
    fun `reopen 422 formats the missing-metadata error`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(summary("s1"))
        sessions.reopenFailure = app.hapi.data.api.ApiError(
            422,
            code = "reopen_missing_metadata",
            body = """{"error":"Cannot reopen","missing":["cursorSessionId"]}""",
        )

        var seen: SessionListError? = null
        val collector = launch { seen = viewModel.errors.first() }
        viewModel.reopenSession("s1")
        collector.join()

        val error = seen
        assertTrue(error is SessionListError.ReopenFailed)
        assertEquals("Cannot reopen (missing: cursorSessionId)", error.message)
    }
}
