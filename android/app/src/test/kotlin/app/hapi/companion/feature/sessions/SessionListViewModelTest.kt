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
import kotlinx.coroutines.test.runCurrent

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
    flavor: String = "claude",
    agentSessionId: String? = null,
    pinned: Boolean? = null,
    hasConversationContent: Boolean = true,
    thinking: Boolean = false,
    pending: Int = 0,
    backgroundTasks: Int = 0,
    lifecycleState: String? = null,
): SessionSummary = SessionSummary(
    id = id,
    active = active,
    thinking = thinking,
    activeAt = 0,
    updatedAt = updatedAt,
    hasConversationContent = hasConversationContent,
    pinned = pinned,
    backgroundTaskCount = backgroundTasks,
    pendingRequestsCount = pending,
    metadata = SessionSummaryMetadata(
        name = name,
        path = path,
        machineId = machineId,
        summary = summaryText?.let { SummaryText(it) },
        flavor = flavor,
        worktree = worktree,
        agentSessionId = agentSessionId,
        lifecycleState = lifecycleState,
    ),
    metadataVersion = 0,
    agentStateVersion = 0,
    todosUpdatedAt = 0,
    todoProgress = null,
    pendingRequestKinds = emptyList(),
    pendingRequests = emptyList(),
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
    lastSeenStore: LastSeenStore = LastSeenStore(backgroundScope),
): Triple<SessionListViewModel, FakeSessionStore, FakeMachineStore> {
    val viewModel = SessionListViewModel(
        sessionStore = sessions,
        machineStore = machines,
        lastSeenStore = lastSeenStore,
        scope = backgroundScope,
        hubKey = "hub-test",
    )
    return Triple(viewModel, sessions, machines)
}

// ------------------------------------------------------------------ tests --

class SessionListViewModelTest {
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `vanished filter stays cleared when sessions return and is isolated per home`() = runTest {
        val (viewModel, sessions, machines) = buildViewModel()
        sessions.set(summary("one", machineId = "m1"), summary("two", machineId = "m2"))
        viewModel.uiState.first { it.rows.size == 2 }
        viewModel.setMachineFilter("m1")
        viewModel.uiState.first { it.activeMachineFilter == "m1" }
        val (otherHome) = buildViewModel(sessions, machines)
        assertNull(otherHome.uiState.first { it.rows.size == 2 }.activeMachineFilter)
        sessions.set(summary("two", machineId = "m2"))
        viewModel.uiState.first { it.rows.size == 1 && it.activeMachineFilter == null }
        runCurrent()
        sessions.set(summary("one", machineId = "m1"), summary("two", machineId = "m2"))
        assertNull(viewModel.uiState.first { it.rows.size == 2 }.activeMachineFilter)
    }

    @Test
    fun `machine choices stay name ordered across count changes and include historical unknowns`() = runTest {
        val (viewModel, sessions, machines) = buildViewModel()
        machines.backing.value = listOf(
            machine("z", "z", "Zulu"), machine("a", "a", " Devbox "), machine("b", "b", "devbox"),
        )
        sessions.set(
            summary("z1", machineId = "z"), summary("a1", machineId = "a"), summary("b1", machineId = "b"),
            summary("old", machineId = "retired", active = false), summary("unknown"),
        )
        val first = viewModel.uiState.first { it.rows.size == 5 }.machineFilters
        assertEquals(listOf("a", "b", "z", "retired", UNKNOWN_MACHINE_ID), first.map { it.id })
        assertEquals(listOf("Devbox · a", "devbox · b"), first.take(2).map { it.label })
        assertTrue(first.first { it.id == "retired" }.unnamed)
        sessions.set(*sessions.backing.value.toTypedArray(), summary("z2", machineId = "z"), summary("z3", machineId = "z"))
        val updated = viewModel.uiState.first { it.rows.size == 7 }.machineFilters
        assertEquals(first.map { it.id }, updated.map { it.id })
        assertEquals(3, updated.first { it.id == "z" }.sessionCount)
    }

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
        assertEquals("repo/app", byId.getValue("s1").meta)
        assertEquals("Devbox", byId.getValue("s1").machine?.label)
        assertEquals("repo/app", byId.getValue("s2").meta)
        assertTrue(byId.getValue("s2").machine!!.unnamed)
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
        assertTrue(state.hasMachineFilters)
        assertEquals(listOf("m1", "m2"), state.machineFilters.map { it.id })
        assertEquals(listOf(2, 1), state.machineFilters.map { it.sessionCount })

        // Unfiltered multi-machine view carries the machine in the meta line…
        assertEquals("m1", state.rows.first { it.id == "s1" }.machine?.id)

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
        assertFalse(state.hasMachineFilters)
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

    // --------------------------------------------- search / dedup / stubs --

    @Test
    fun `search filters rows, reports no results, and clears back to the full list`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("s1", updatedAt = 900, name = "Home Assistant setup"),
            summary("s2", updatedAt = 800, name = "Refactor parser"),
        )
        viewModel.uiState.first { it.rows.size == 2 }

        viewModel.setSearchQuery("home ass")
        var state = viewModel.uiState.first { it.isSearching }
        assertEquals(listOf("s1"), state.rows.map { it.id })

        viewModel.setSearchQuery("zzz")
        state = viewModel.uiState.first { it.isSearching && it.rows.isEmpty() }

        viewModel.setSearchQuery("")
        state = viewModel.uiState.first { !it.isSearching }
        assertEquals(2, state.rows.size)
    }

    @Test
    fun `search ranks a title boundary hit above a newer path-only match`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("path-hit", updatedAt = 900, name = "Unrelated", path = "/repo/home-lab"),
            summary("title-hit", updatedAt = 100, name = "Home Assistant setup"),
        )
        viewModel.setSearchQuery("home")
        val state = viewModel.uiState.first { it.isSearching && it.rows.size == 2 }
        // Recency alone would order [path-hit, title-hit]; the title weight +
        // boundary bonus must outrank it.
        assertEquals(listOf("title-hit", "path-hit"), state.rows.map { it.id })
    }

    @Test
    fun `duplicate agent-session views collapse to the newest view`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("stale", updatedAt = 500, agentSessionId = "agent-1", name = "Old view"),
            summary("fresh", updatedAt = 900, agentSessionId = "agent-1", name = "New view"),
            summary("other", updatedAt = 700, agentSessionId = "agent-2", name = "Other"),
        )
        val state = viewModel.uiState.first { it.rows.size == 2 }
        assertEquals(listOf("fresh", "other"), state.rows.map { it.id })
    }

    @Test
    fun `the active view wins dedup even when older`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("old-active", updatedAt = 100, active = true, agentSessionId = "agent-1", name = "Old"),
            summary("new-idle", updatedAt = 900, agentSessionId = "agent-1", name = "New"),
        )
        val state = viewModel.uiState.first { it.rows.size == 1 }
        assertEquals("old-active", state.rows.single().id)
    }

    @Test
    fun `same agent id across flavors stays two rows`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("claude-view", updatedAt = 900, flavor = "claude", agentSessionId = "shared-1", name = "Claude view"),
            summary("codex-view", updatedAt = 800, flavor = "codex", agentSessionId = "shared-1", name = "Codex view"),
        )
        val state = viewModel.uiState.first { it.rows.size == 2 }
        assertEquals(setOf("claude-view", "codex-view"), state.rows.map { it.id }.toSet())
    }

    @Test
    fun `fresh empty-session stubs hide until they gain a title signal`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("stub", hasConversationContent = false),
            summary("named-stub", hasConversationContent = false, name = "Named"),
            summary("content", hasConversationContent = true),
            summary("agent-stub", hasConversationContent = false, agentSessionId = "agent-9"),
        )
        val state = viewModel.uiState.first { it.rows.size == 3 }
        assertEquals(setOf("named-stub", "content", "agent-stub"), state.rows.map { it.id }.toSet())
    }

    // ------------------------------------------------------- unread system --

    @Test
    fun `unread lens hides seen rows keeps the open session and mark-all-read empties it`() = runTest {
        // Sessions preset BEFORE the ViewModel: the SSE collector's first
        // emission is the preset list, drop(1) skips it — no baseline seeding,
        // so every row starts unread deterministically.
        val sessions = FakeSessionStore().apply { set(summary("a", updatedAt = 100), summary("b", updatedAt = 100)) }
        val (viewModel) = buildViewModel(sessions)
        assertEquals(2, viewModel.uiState.first { it.rows.size == 2 }.unreadCount)

        viewModel.setUnreadOnly(true)
        assertEquals(setOf("a", "b"), viewModel.uiState.first { it.rows.size == 2 }.rows.map { it.id }.toSet())

        viewModel.onSessionOpened("a") // stamps a's watermark; stays visible as the open session
        val lensed = viewModel.uiState.first { it.unreadCount == 1 }
        assertEquals(setOf("a", "b"), lensed.rows.map { it.id }.toSet()) // a kept by selection, b by unread
        assertTrue(lensed.rows.first { it.id == "b" }.unread)

        viewModel.markAllSessionsRead()
        val emptied = viewModel.uiState.first { it.unreadCount == 0 }
        assertEquals(listOf("a"), emptied.rows.map { it.id }) // only the open session survives the lens
    }

    @Test
    fun `mark unread brings a read row back into the lens`() = runTest {
        val sessions = FakeSessionStore().apply { set(summary("a", updatedAt = 100), summary("b", updatedAt = 100)) }
        val lastSeen = LastSeenStore(backgroundScope).apply {
            markSeen("a", 100)
            markSeen("b", 100)
        }
        val (viewModel) = buildViewModel(sessions, lastSeenStore = lastSeen)
        assertEquals(0, viewModel.uiState.first { it.rows.size == 2 }.unreadCount)

        viewModel.setUnreadOnly(true)
        // Nothing unread — the lens keeps the list empty until a row is marked.
        viewModel.uiState.first { it.unreadCount == 0 }
        viewModel.markSessionUnread("a")
        val relit = viewModel.uiState.first { it.unreadCount == 1 }
        assertEquals(listOf("a"), relit.rows.map { it.id })
        assertTrue(relit.rows.single().unread)
    }

    @Test
    fun `unread count stays hub-wide under a machine filter`() = runTest {
        val sessions = FakeSessionStore().apply {
            set(summary("a", updatedAt = 100, machineId = "m1"), summary("b", updatedAt = 100, machineId = "m2"))
        }
        val (viewModel) = buildViewModel(sessions)
        viewModel.uiState.first { it.rows.size == 2 }
        viewModel.setMachineFilter("m1")
        val state = viewModel.uiState.first { it.activeMachineFilter == "m1" }
        assertEquals(listOf("a"), state.rows.map { it.id })
        assertEquals(2, state.unreadCount) // count ignores the machine scope, like the toolbar action
        assertFalse(state.showUnreadOnly) // transient default off
    }

    // ------------------------------------------------------ active / buckets --

    @Test
    fun `active lens hides inactive rows keeps the open session and blocks search resurrection`() = runTest {
        val sessions = FakeSessionStore().apply {
            set(
                summary("live", updatedAt = 900, active = true, name = "Live build"),
                summary("cold", updatedAt = 800, name = "Cold storage"),
            )
        }
        val (viewModel) = buildViewModel(sessions)
        viewModel.uiState.first { it.rows.size == 2 }

        viewModel.setActiveOnly(true)
        var state = viewModel.uiState.first { it.showActiveOnly }
        assertEquals(listOf("live"), state.rows.map { it.id })
        assertFalse(state.showUnreadOnly) // the lenses are independent

        // Search narrows further — it never resurrects a hidden inactive row.
        viewModel.setSearchQuery("cold")
        state = viewModel.uiState.first { it.isSearching }
        assertTrue(state.rows.isEmpty())

        // The open session stays visible even though inactive (web desc: "The
        // session you have open stays visible").
        viewModel.setSearchQuery("")
        viewModel.onSessionOpened("cold")
        state = viewModel.uiState.first { it.rows.size == 2 }
        assertEquals(setOf("live", "cold"), state.rows.map { it.id }.toSet())
    }

    @Test
    fun `pin in progress regroups connected rows into running bucket sections`() = runTest {
        val sessions = FakeSessionStore().apply {
            set(
                summary("gone", updatedAt = 900),
                summary("quiet", updatedAt = 850, active = true),
                summary("pin", updatedAt = 800, active = true, pinned = true),
                summary("think", updatedAt = 700, active = true, thinking = true),
                summary("wait", updatedAt = 600, active = true, pending = 2),
                summary("zombie", updatedAt = 500, active = true, lifecycleState = SESSION_LIFECYCLE_IDLE),
            )
        }
        val (viewModel) = buildViewModel(sessions)

        // Default off: pinned prefix + one plain body section (old layout).
        val plain = viewModel.uiState.first { it.rows.size == 6 }
        assertFalse(plain.pinInProgress)
        assertEquals(listOf(SessionSectionKind.PINNED, SessionSectionKind.RECENT), plain.sections.map { it.kind })
        assertEquals(listOf("pin"), plain.sections.first().rows.map { it.id })

        viewModel.setPinInProgress(true)
        val grouped = viewModel.uiState.first { it.pinInProgress }
        assertEquals(
            listOf(
                SessionSectionKind.PINNED,
                SessionSectionKind.RUNNING,
                SessionSectionKind.PENDING,
                SessionSectionKind.ACTIVE,
                SessionSectionKind.IDLE,
                SessionSectionKind.RECENT,
            ),
            grouped.sections.map { it.kind },
        )
        assertEquals(listOf("pin"), grouped.sections[0].rows.map { it.id })
        assertEquals(listOf("think"), grouped.sections[1].rows.map { it.id })
        assertEquals(listOf("wait"), grouped.sections[2].rows.map { it.id })
        assertEquals(listOf("quiet"), grouped.sections[3].rows.map { it.id })
        assertEquals(listOf("zombie"), grouped.sections[4].rows.map { it.id })
        assertEquals(listOf("gone"), grouped.sections[5].rows.map { it.id })
        // Same rows, regrouped — sections are a view over `rows`.
        assertEquals(grouped.rows.size, grouped.sections.sumOf { it.rows.size })
    }
}
