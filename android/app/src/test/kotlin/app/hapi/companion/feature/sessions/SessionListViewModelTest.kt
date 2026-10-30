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
import java.time.ZoneId
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
): SessionSummary = SessionSummary(
    id = id,
    active = active,
    thinking = false,
    activeAt = 0,
    updatedAt = updatedAt,
    hasConversationContent = hasConversationContent,
    pinned = pinned,
    metadata = SessionSummaryMetadata(
        name = name,
        path = path,
        machineId = machineId,
        summary = summaryText?.let { SummaryText(it) },
        flavor = flavor,
        worktree = worktree,
        agentSessionId = agentSessionId,
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
    zoneProvider: () -> ZoneId = { ZoneId.of("UTC") },
    cursorProbe: (suspend (String) -> app.hapi.protocol.wire.CursorChatStoreStatus)? = null,
    now: () -> Long = System::currentTimeMillis,
): Triple<SessionListViewModel, FakeSessionStore, FakeMachineStore> {
    val viewModel = SessionListViewModel(
        sessionStore = sessions,
        machineStore = machines,
        lastSeenStore = LastSeenStore(backgroundScope),
        scope = backgroundScope,
        hubKey = "hub-test",
        zoneProvider = zoneProvider,
        cursorChatStoreProbe = cursorProbe ?: { error("cursor chat-store probe not wired") },
        now = now,
    )
    return Triple(viewModel, sessions, machines)
}

// ------------------------------------------------------------------ tests --

class SessionListViewModelTest {
    @Test
    fun `reset clears machine and date filters while preserving search`() = runTest {
        val (viewModel, sessions) = buildViewModel()
        sessions.set(
            summary("one", name = "Matching session", machineId = "m1"),
            summary("two", name = "Matching session", machineId = "m2"),
            summary("three", name = "Other", machineId = "m2"),
        )
        viewModel.uiState.first { it.rows.size == 3 }
        viewModel.setMachineFilter("m1")
        viewModel.setDateRange(0, 0)
        viewModel.setSearchQuery("Matching")
        val filtered = viewModel.uiState.first { it.activeMachineFilter == "m1" && it.dateRange != null && it.isSearching }
        assertTrue(filtered.hasActiveFilters)
        assertEquals(listOf("one"), filtered.rows.map { it.id })

        viewModel.clearFilters()
        val reset = viewModel.uiState.first { !it.hasActiveFilters }
        assertEquals("Matching", reset.searchQuery)
        assertEquals(setOf("one", "two"), reset.rows.map { it.id }.toSet())
    }

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

    // -------------------------------------------------- date-range lens --

    /** Epoch days: 2026-10-05 = 20731 (see SessionDateRangeFilterTest's ladder). */
    private val day = 20_731L
    private val dayMillis get() = day * 86_400_000L

    @Test
    fun `date range scopes rows to the selected activity window and clears back`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("in-range", updatedAt = dayMillis + 3_600_000L),
            summary("day-before", updatedAt = dayMillis - 86_400_000L),
            summary("day-after", updatedAt = dayMillis + 86_400_000L),
        )
        viewModel.uiState.first { it.rows.size == 3 }

        viewModel.setDateRange(day, day)
        val scoped = viewModel.uiState.first { it.rows.size == 1 }
        assertEquals(listOf("in-range"), scoped.rows.map { it.id })
        assertEquals(SessionDateRange(day, day), scoped.dateRange)

        viewModel.clearDateRange()
        val cleared = viewModel.uiState.first { it.dateRange == null }
        assertEquals(3, cleared.rows.size)
    }

    @Test
    fun `setDateRange normalizes reversed picks like the web picker's two clicks`() = runTest {
        val (viewModel, _, _) = buildViewModel()
        viewModel.setDateRange(day + 2, day)
        assertEquals(SessionDateRange(day, day + 2), viewModel.uiState.first { it.dateRange != null }.dateRange)
    }

    @Test
    fun `date range combines with machine filter and machine choices stay unfiltered`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("m1-old", machineId = "m1", updatedAt = 20_000L * 86_400_000L),
            summary("m1-new", machineId = "m1", updatedAt = dayMillis),
            summary("m2-new", machineId = "m2", updatedAt = dayMillis),
        )
        viewModel.uiState.first { it.rows.size == 3 }

        viewModel.setDateRange(day, day)
        viewModel.setMachineFilter("m1")
        val state = viewModel.uiState.first { it.activeMachineFilter == "m1" && it.rows.size == 1 }
        assertEquals(listOf("m1-new"), state.rows.map { it.id })
        // Choices derive from the unfiltered list (web: machineFilters from allSessions).
        assertEquals(listOf("m1", "m2"), state.machineFilters.map { it.id })
        assertEquals(1, state.machineFilters.first { it.id == "m2" }.sessionCount)
    }

    @Test
    fun `activity days derive before date and machine filtering`() = runTest {
        // 2026-10-05T20:00Z = day 20731 in UTC but day 20732 in Shanghai.
        val (viewModel, sessions, _) = buildViewModel(zoneProvider = { ZoneId.of("Asia/Shanghai") })
        sessions.set(
            summary("utc-day", updatedAt = dayMillis),
            summary("shanghai-next-day", updatedAt = 1_791_230_400_000L),
            summary("old", updatedAt = 20_600L * 86_400_000L),
        )
        viewModel.uiState.first { it.rows.size == 3 }

        viewModel.setDateRange(day, day)
        val state = viewModel.uiState.first { it.dateRange != null }
        // Only the UTC-midnight session survives the Shanghai-window filter…
        assertEquals(listOf("utc-day"), state.rows.map { it.id })
        // …but the activity set still marks every pre-filter day (web
        // sessionActivityDates keeps full-activity marking while filtering).
        assertEquals(setOf(20_600L, day, day + 1), state.dateActivityEpochDays)
    }

    @Test
    fun `timezone changes update the active date lens and activity marks without new sessions`() = runTest {
        var zone = ZoneId.of("UTC")
        val (viewModel, sessions, _) = buildViewModel(zoneProvider = { zone })
        sessions.set(summary("boundary", updatedAt = dayMillis + 20 * 3_600_000L))
        viewModel.setDateRange(day, day)
        val initial = viewModel.uiState.first { it.dateRange != null }
        assertEquals(listOf("boundary"), initial.rows.map { it.id })
        assertEquals(setOf(day), initial.dateActivityEpochDays)
        val calls = sessions.calls.value

        zone = ZoneId.of("Asia/Shanghai")
        viewModel.refreshTimeZone()
        val changed = viewModel.uiState.first { it.dateActivityEpochDays == setOf(day + 1) }
        assertTrue(changed.rows.isEmpty())
        assertEquals(SessionDateRange(day, day), changed.dateRange)
        assertEquals(calls, sessions.calls.value)
    }

    @Test
    fun `reentering the same viewmodel refreshes the timezone with an unchanged snapshot`() = runTest {
        var zone = ZoneId.of("UTC")
        val (viewModel, sessions, _) = buildViewModel(zoneProvider = { zone })
        sessions.set(summary("boundary", updatedAt = dayMillis + 20 * 3_600_000L))
        viewModel.setDateRange(day, day)
        viewModel.start()
        viewModel.uiState.first { it.dateRange != null && it.rows.size == 1 }
        viewModel.stop()

        zone = ZoneId.of("Asia/Shanghai")
        viewModel.start()
        val changed = viewModel.uiState.first { it.dateActivityEpochDays == setOf(day + 1) }
        assertTrue(changed.rows.isEmpty())
        assertEquals(SessionDateRange(day, day), changed.dateRange)
    }

    @Test
    fun `live session updates use the current timezone for both rows and activity marks`() = runTest {
        var zone = ZoneId.of("UTC")
        val (viewModel, sessions, _) = buildViewModel(zoneProvider = { zone })
        sessions.set(summary("boundary", updatedAt = dayMillis + 20 * 3_600_000L))
        viewModel.setDateRange(day, day)
        viewModel.uiState.first { it.dateRange != null && it.rows.size == 1 }

        zone = ZoneId.of("Asia/Shanghai")
        sessions.set(summary("boundary", updatedAt = dayMillis + 20 * 3_600_000L + 1))
        val changed = viewModel.uiState.first { it.dateActivityEpochDays == setOf(day + 1) }
        assertTrue(changed.rows.isEmpty())
    }

    @Test
    fun `date search and machine filters compose and clear independently`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("home-today", machineId = "m1", updatedAt = dayMillis + 100, name = "Home today"),
            summary("parser-today", machineId = "m1", updatedAt = dayMillis + 200, name = "Parser today"),
            summary("home-yesterday", machineId = "m1", updatedAt = dayMillis - 1, name = "Home yesterday"),
            summary("home-other-machine", machineId = "m2", updatedAt = dayMillis + 300, name = "Home elsewhere"),
        )
        viewModel.uiState.first { it.rows.size == 4 }
        viewModel.setDateRange(day, day)
        viewModel.setSearchQuery("home")
        viewModel.setMachineFilter("m1")
        val scoped = viewModel.uiState.first {
            it.dateRange != null && it.searchQuery == "home" && it.activeMachineFilter == "m1"
        }
        assertEquals(listOf("home-today"), scoped.rows.map { it.id })
        assertEquals(setOf(day - 1, day), scoped.dateActivityEpochDays)
        assertEquals(mapOf("m1" to 3, "m2" to 1), scoped.machineFilters.associate { it.id to it.sessionCount })

        viewModel.clearDateRange()
        val withoutDate = viewModel.uiState.first { it.dateRange == null }
        assertEquals(setOf("home-today", "home-yesterday"), withoutDate.rows.map { it.id }.toSet())

        viewModel.setDateRange(day, day)
        viewModel.setSearchQuery("")
        val withoutSearch = viewModel.uiState.first { it.dateRange != null && !it.isSearching }
        assertEquals(setOf("home-today", "parser-today"), withoutSearch.rows.map { it.id }.toSet())

        viewModel.setMachineFilter(null)
        val withoutMachine = viewModel.uiState.first { it.activeMachineFilter == null }
        assertEquals(setOf("home-today", "parser-today", "home-other-machine"), withoutMachine.rows.map { it.id }.toSet())
    }

    @Test
    fun `date scoped search preserves global and project pin sections`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("ordinary", updatedAt = dayMillis + 300, name = "home"),
            summary("project", updatedAt = dayMillis + 200, name = "Home automation").copy(pinned = true),
            summary("global", updatedAt = dayMillis + 100, name = "homelab").copy(globalPinned = true, pinned = true),
            summary("outside-date", updatedAt = dayMillis - 1, name = "home").copy(globalPinned = true),
        )
        viewModel.setDateRange(day, day)
        viewModel.setSearchQuery("home")
        val state = viewModel.uiState.first { it.dateRange != null && it.isSearching }
        assertEquals(listOf("global", "project", "ordinary"), state.rows.map { it.id })
        assertEquals(setOf(day - 1, day), state.dateActivityEpochDays)
    }

    @Test
    fun `date filtering cannot revive a stale duplicate view`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("stale", machineId = "m1", updatedAt = dayMillis - 1, agentSessionId = "agent-1"),
            summary("fresh", machineId = "m1", updatedAt = dayMillis, agentSessionId = "agent-1"),
            summary("other", machineId = "m2", updatedAt = dayMillis - 2 * 86_400_000L),
        )
        viewModel.uiState.first { it.rows.size == 2 }

        viewModel.setDateRange(day - 1, day - 1)
        val yesterday = viewModel.uiState.first { it.dateRange != null }
        assertTrue(yesterday.rows.isEmpty())
        assertEquals(setOf(day - 2, day), yesterday.dateActivityEpochDays)
        assertEquals(mapOf("m1" to 2, "m2" to 1), yesterday.machineFilters.associate { it.id to it.sessionCount })

        viewModel.setDateRange(day, day)
        val today = viewModel.uiState.first { it.dateRange == SessionDateRange(day, day) }
        assertEquals(listOf("fresh"), today.rows.map { it.id })

        viewModel.clearDateRange()
        val cleared = viewModel.uiState.first { it.dateRange == null }
        assertEquals(listOf("fresh", "other"), cleared.rows.map { it.id })
    }

    @Test
    fun `date search and activity marks use the active winner and exclude hidden stubs`() = runTest {
        val (viewModel, sessions, _) = buildViewModel()
        sessions.set(
            summary("active", updatedAt = dayMillis - 1, active = true, agentSessionId = "agent-1", name = "Home live"),
            summary("idle", updatedAt = dayMillis, agentSessionId = "agent-1", name = "Home idle"),
            summary("stub", updatedAt = dayMillis - 2 * 86_400_000L, hasConversationContent = false),
        )
        viewModel.uiState.first { it.rows.size == 1 }

        viewModel.setDateRange(day, day)
        viewModel.setSearchQuery("home")
        val today = viewModel.uiState.first { it.dateRange != null && it.isSearching }
        assertTrue(today.rows.isEmpty())
        assertEquals(setOf(day - 1), today.dateActivityEpochDays)

        viewModel.setDateRange(day - 1, day - 1)
        val yesterday = viewModel.uiState.first { it.dateRange == SessionDateRange(day - 1, day - 1) }
        assertEquals(listOf("active"), yesterday.rows.map { it.id })
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

    // ---------------------------------- slice C: cursor reopen gate ------

    private fun cursorSummary(id: String = "cu-sess", active: Boolean = false): SessionSummary =
        summary(id = id, active = active).copy(
            metadata = SessionSummaryMetadata(
                name = null,
                path = "/repo/app",
                machineId = null,
                summary = null,
                flavor = "cursor",
                worktree = null,
                agentSessionId = "cu-1",
            ),
        )

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `long-press on an applicable cursor row probes and a missing store gates reopen`() = runTest {
        val probeCalls = MutableStateFlow(0)
        val (viewModel, sessions, machines) = buildViewModel(
            cursorProbe = {
                probeCalls.value += 1
                app.hapi.protocol.wire.CursorChatStoreStatus(onDisk = false, store = null)
            },
            now = { testScheduler.currentTime },
        )
        sessions.set(cursorSummary())
        viewModel.uiState.first { it.rows.size == 1 }

        viewModel.beginCursorReopenProbe(sessions.backing.value.first())
        viewModel.cursorReopenGate.first { it.sessionId == "cu-sess" }
        viewModel.cursorReopenGate.first { it.gate.disabledReason == CursorReopenGateReason.Missing }
        assertEquals(1, probeCalls.value)
        assertFalse(viewModel.cursorReopenGate.value.gate.probeUnverified)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `probe errors soft-allow reopen with the unverified hint`() = runTest {
        val (viewModel, sessions, machines) = buildViewModel(
            cursorProbe = { throw RuntimeException("rpc handler missing") },
        )
        sessions.set(cursorSummary())
        viewModel.uiState.first { it.rows.size == 1 }

        viewModel.beginCursorReopenProbe(sessions.backing.value.first())
        viewModel.cursorReopenGate.first { it.gate.probeUnverified }
        assertNull(viewModel.cursorReopenGate.value.gate.disabledReason)
        assertEquals("cu-sess", viewModel.cursorReopenGate.value.sessionId)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `non-applicable rows clear the gate and never probe`() = runTest {
        var probeCalls = 0
        val (viewModel, sessions, machines) = buildViewModel(
            cursorProbe = {
                probeCalls++
                app.hapi.protocol.wire.CursorChatStoreStatus(onDisk = true, store = "acp")
            },
        )
        sessions.set(summary("plain-claude"))
        viewModel.uiState.first { it.rows.size == 1 }

        viewModel.beginCursorReopenProbe(sessions.backing.value.first())
        runCurrent()
        assertNull(viewModel.cursorReopenGate.value.sessionId)
        assertEquals(0, probeCalls)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `a row that activates clears the gate while its sheet is open`() = runTest {
        val (viewModel, sessions, machines) = buildViewModel(
            cursorProbe = { app.hapi.protocol.wire.CursorChatStoreStatus(onDisk = false, store = null) },
            now = { testScheduler.currentTime },
        )
        sessions.set(cursorSummary())
        viewModel.uiState.first { it.rows.size == 1 }
        viewModel.beginCursorReopenProbe(sessions.backing.value.first())
        viewModel.cursorReopenGate.first { it.gate.disabledReason == CursorReopenGateReason.Missing }

        // The session activates (e.g. another client resumed it): applicability
        // is re-derived from the live list, and the gate must open even with
        // the sheet still on screen.
        sessions.set(cursorSummary(active = true))
        viewModel.cursorReopenGate.first { it.gate.disabledReason == null }
        assertEquals("cu-sess", viewModel.cursorReopenGate.value.sessionId)
        assertFalse(viewModel.cursorReopenGate.value.gate.probeUnverified)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `repeated long-presses reuse a fresh probe and re-probe after the staleness window`() = runTest {
        val probeCalls = MutableStateFlow(0)
        val (viewModel, sessions, machines) = buildViewModel(
            cursorProbe = {
                probeCalls.value += 1
                app.hapi.protocol.wire.CursorChatStoreStatus(onDisk = true, store = "legacy")
            },
            now = { testScheduler.currentTime },
        )
        sessions.set(cursorSummary())
        viewModel.uiState.first { it.rows.size == 1 }
        val row = sessions.backing.value.first()

        viewModel.beginCursorReopenProbe(row)
        // The gate's open state is also its initial value (sessionId null);
        // sequence on the probe side effect instead of the gate predicate.
        probeCalls.first { it == 1 }
        assertEquals("cu-sess", viewModel.cursorReopenGate.value.sessionId)

        // Inside the 5s window (web `staleTime: 5_000`): no duplicate probe.
        testScheduler.advanceTimeBy(2_000)
        viewModel.beginCursorReopenProbe(row)
        runCurrent()
        assertEquals(1, probeCalls.value)

        // Past it: the next long-press probes again.
        testScheduler.advanceTimeBy(3_100)
        viewModel.beginCursorReopenProbe(row)
        probeCalls.first { it == 2 }
        // …and the gate stays settled-open through the reload.
        viewModel.cursorReopenGate.first {
            it.sessionId == "cu-sess" && it.gate.disabledReason == null && !it.gate.probeUnverified
        }
    }
}
