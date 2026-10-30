package app.hapi.companion.feature.sessions

import app.hapi.data.api.ApiError
import app.hapi.data.store.LastSeenStore
import app.hapi.data.store.MachineListStore
import app.hapi.data.store.SessionListStore
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.sortSessionSummaries
import java.time.ZoneId
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/** Sessions whose metadata carries no machine id group under this filter id. */
const val UNKNOWN_MACHINE_ID: String = "__unknown__"

/** One rendered list row: the summary plus everything derived for display. */
data class SessionRowUi(
    val summary: SessionSummary,
    /** `getSessionTitle` port: name → summary text → path tail → id prefix. */
    val title: String,
    /** Secondary line: summary text, only when it is not already the title. */
    val subtitle: String?,
    /**
     * Single meta line, `project · worktree · machine`: project is the last
     * two segments of the worktree base path (session path fallback, the web
     * sidebar's group-name rule); the machine label is disambiguation only —
     * present only when several machines are known and no machine filter is
     * active. Full paths never render in the list (title tooltip territory
     * on web; here the session detail owns them).
     */
    val meta: String?,
    /** Raw flavor id (`claude`, `codex`, …); resolve labels via the catalog. */
    val flavor: String?,
    val unread: Boolean,
    val machine: MachineFilterUi? = null,
) {
    val id: String get() = summary.id
}

data class MachineFilterUi(
    /** Machine id or [UNKNOWN_MACHINE_ID]. */
    val id: String,
    val label: String,
    val sessionCount: Int,
    val unnamed: Boolean = false,
)

data class SessionListUiState(
    val rows: List<SessionRowUi>,
    /** Choices for the filter sheet, derived from all sessions. */
    val machineFilters: List<MachineFilterUi>,
    /** `null` = All. Always one of [machineFilters] ids (stale picks fall back). */
    val activeMachineFilter: String?,
    val isRefreshing: Boolean,
    /** True once either the snapshot or a refresh produced a list. */
    val hasLoaded: Boolean,
    /** Last refresh failed — show the offline banner over snapshot data. */
    val isOffline: Boolean,
    /** Transient date-range lens (web `customStart`/`customEnd` `useState`); null = off, never persisted. */
    val dateRange: SessionDateRange? = null,
    /**
     * Local epoch-days that carry any session activity — the picker's
     * activity hint, derived before any list filtering (web
     * `sessionActivityDates`, which keeps marking all days while a filter is
     * active). Duplicate views and hidden empty stubs are excluded first.
     */
    val dateActivityEpochDays: Set<Long> = emptySet(),
    /** Live search-box text; blank = no filtering/ranking. */
    val searchQuery: String = "",
) {
    val hasMachineFilters: Boolean get() = machineFilters.size >= 2
    val hasActiveFilters: Boolean get() = activeMachineFilter != null || dateRange != null
    val isSearching: Boolean get() = searchQuery.isNotBlank()
}

/**
 * Session-list state machine: combines [SessionListStore] / [MachineListStore]
 * / [LastSeenStore] with the machine-filter selection into [uiState] and
 * forwards pin/archive actions with store-side optimistic updates.
 *
 * The global SSE subscription is NOT owned here anymore (B-M3ab): `HubGraph`
 * runs it for its whole lifetime via `GlobalSsePipe`, so queued/consumed
 * bookkeeping and list badges stay fresh while a chat screen is open.
 *
 * Plain constructor — no Android dependency, so JVM tests drive it with fake
 * stores. Navigation hosts it behind a per-hub lifecycle holder built from
 * `HubGraph`; the screen calls [start]/[stop] with its composition.
 */
class SessionListViewModel(
    private val sessionStore: SessionListStore,
    private val machineStore: MachineListStore,
    private val lastSeenStore: LastSeenStore,
    private val scope: CoroutineScope,
    /** Last-seen baseline scope, e.g. the hub origin. */
    private val hubKey: String = "default",
    /** Current clock zone; resolved for every date derivation, including after resume. */
    private val zoneProvider: () -> ZoneId = ZoneId::systemDefault,
    /**
     * P2 display "active sessions only" lens (app-wide `DisplayPrefs` flow;
     * default false = full list, so tests and previews construct without
     * display prefs).
     */
    private val showActiveSessionsOnly: Flow<Boolean> = flowOf(false),
) {
    private val machineFilter = MutableStateFlow<String?>(null)
    private val searchQuery = MutableStateFlow("")
    private val selectedSessionId = MutableStateFlow<String?>(null)
    private val isRefreshing = MutableStateFlow(false)
    private val isOffline = MutableStateFlow(false)
    private val hasRefreshedOnce = MutableStateFlow(false)

    /** Transient date-range lens; null = no date filtering (web: unpersisted `useState`). */
    private val dateRange = MutableStateFlow<SessionDateRange?>(null)
    private val timeZone = MutableStateFlow(zoneProvider())

    private val _errors = MutableSharedFlow<SessionListError>(extraBufferCapacity = 8)

    /** Transient action failures (pin/archive/rename/delete/reopen) for a snackbar. */
    val errors: SharedFlow<SessionListError> = _errors.asSharedFlow()

    private val _reopened = MutableSharedFlow<String>(extraBufferCapacity = 4)

    /** Reopen succeeded — navigate into this (possibly superseding) session id. */
    val reopened: SharedFlow<String> = _reopened.asSharedFlow()

    private var refreshJob: Job? = null

    init {
        scope.launch {
            combine(sessionStore.sessions, machineFilter) { _, filter -> filter }.collect { selected ->
                // Validate against the current snapshot, not an older combined
                // emission that may have queued before the user selected a row.
                val ids = sessionStore.sessions.value.map { it.metadata?.machineId ?: UNKNOWN_MACHINE_ID }.toSet()
                if (selected != null && (ids.size < 2 || selected !in ids)) {
                    machineFilter.compareAndSet(selected, null)
                }
            }
        }
        // Live SSE data is proof of connectivity: any list emission after a
        // failed refresh clears the stale offline banner (a device-observed
        // contradiction — active sessions updating under an "offline" banner).
        scope.launch {
            sessionStore.sessions.drop(1).collect { sessions ->
                if (isOffline.value) isOffline.value = false
                // Seed the unread baseline from SSE data too — when REST
                // refresh fails but the stream works, unseeded watermarks
                // would light every row's unread dot (once-per-scope inside
                // the store, so repeated calls are no-ops).
                if (sessions.isNotEmpty()) {
                    runCatching { lastSeenStore.initializeBaseline(hubKey, sessions) }
                }
            }
        }
    }

    val uiState: StateFlow<SessionListUiState> = combine(
        combine(sessionStore.sessions, machineStore.machines, lastSeenStore.state) { sessions, machines, lastSeen ->
            Triple(sessions, machines, lastSeen.lastSeen)
        },
        combine(machineFilter, searchQuery, selectedSessionId, showActiveSessionsOnly) { filter, query, selected, activeOnly ->
            ListLensState(filter, query, selected, activeOnly)
        },
        combine(isRefreshing, isOffline, hasRefreshedOnce, dateRange, timeZone) { refreshing, offline, loaded, range, _ ->
            ChromeState(refreshing, offline, loaded, range)
        },
    ) { (sessions, machines, lastSeen), lens, chrome ->
        buildUiState(
            sessions = sessions,
            machines = machines,
            lastSeen = lastSeen,
            filter = lens.machineFilter,
            searchQuery = lens.searchQuery,
            selectedSessionId = lens.selectedSessionId,
            showActiveSessionsOnly = lens.activeSessionsOnly,
            isRefreshing = chrome.refreshing,
            isOffline = chrome.offline,
            hasLoaded = chrome.refreshedOnce || sessions.isNotEmpty(),
            dateRange = chrome.dateRange,
        )
    }.stateIn(
        scope = scope,
        started = SharingStarted.Eagerly,
        initialValue = SessionListUiState(
            rows = emptyList(),
            machineFilters = emptyList(),
            activeMachineFilter = null,
            isRefreshing = false,
            hasLoaded = sessionStore.sessions.value.isNotEmpty(),
            isOffline = false,
        ),
    )

    /**
     * Screen entry. The global SSE pipe already runs at `HubGraph` scope;
     * this only kicks the explicit entry refresh (the snapshot may be stale
     * and a `resume: ok` handshake deliberately skips the REST resync).
     * Safe to call repeatedly.
     */
    fun start() {
        refresh()
    }

    /** Screen exit. The hub-lifetime global pipe stays up by design. */
    fun stop() {
        refreshJob?.cancel()
    }

    /** Pull-to-refresh / initial load. Coalesces concurrent calls. */
    fun refresh() {
        refreshTimeZone()
        if (refreshJob?.isActive == true) return
        refreshJob = scope.launch {
            isRefreshing.value = true
            try {
                // Only a failed *sessions* fetch means "offline". Machines and
                // the unread baseline are secondary: their failures must not
                // pin the offline banner over a perfectly live list (this
                // exact cascade shipped once — a machines decode error kept
                // the banner up while SSE streamed active sessions).
                sessionStore.refresh()
                isOffline.value = false
                hasRefreshedOnce.value = true
                // First successful list for this hub seeds the unread baseline
                // so historical sessions do not all light up as unread.
                runCatching { lastSeenStore.initializeBaseline(hubKey, sessionStore.sessions.value) }
                try {
                    machineStore.refresh()
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Exception) {
                    _errors.tryEmit(SessionListError.MachinesRefreshFailed(error.message))
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                isOffline.value = true
            } finally {
                isRefreshing.value = false
            }
        }
    }

    fun setMachineFilter(machineId: String?) {
        machineFilter.value = machineId
    }

    /** Re-evaluate local dates on timezone broadcasts and foreground resume, even offline. */
    fun refreshTimeZone() {
        timeZone.value = zoneProvider()
    }

    /**
     * Sets the transient date-range lens. The two picks are normalized into
     * `[start, end]` — the web picker sorts its two clicks the same way. Not
     * persisted: a fresh ViewModel (process death, hub switch) starts clear,
     * matching the web's unpersisted `useState`.
     */
    fun setDateRange(startEpochDay: Long, endEpochDay: Long) {
        dateRange.value = SessionDateRange(
            startEpochDay = minOf(startEpochDay, endEpochDay),
            endEpochDay = maxOf(startEpochDay, endEpochDay),
        )
    }

    /** Clears the date-range lens (web: the picker footer `Clear` link). */
    fun clearDateRange() {
        dateRange.value = null
    }

    /** Reset the consolidated sheet's conditions without changing the search. */
    fun clearFilters() {
        machineFilter.value = null
        dateRange.value = null
    }

    /** Search-box input; blank disables filtering/ranking entirely. */
    fun setSearchQuery(query: String) {
        searchQuery.value = query
    }

    /** Call when navigating into a session: stamps the last-seen watermark. */
    fun onSessionOpened(sessionId: String) {
        selectedSessionId.value = sessionId
        val summary = sessionStore.sessions.value.firstOrNull { it.id == sessionId } ?: return
        lastSeenStore.markSeen(sessionId, summary.updatedAt)
    }

    /** `PUT /sessions/:id/pin` with optimistic re-sort; failures surface on [errors]. */
    fun setPinMode(sessionId: String, mode: PinMode) {
        scope.launch {
            try {
                sessionStore.setPinMode(sessionId, mode.wire)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                _errors.tryEmit(SessionListError.PinFailed(sessionId, error.message))
            }
        }
    }

    /** `POST /sessions/:id/archive` with optimistic removal; failures surface on [errors]. */
    fun archiveSession(sessionId: String) {
        scope.launch {
            try {
                sessionStore.archiveSession(sessionId)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                _errors.tryEmit(SessionListError.ArchiveFailed(sessionId, error.message))
            }
        }
    }

    /** `PATCH /sessions/:id` rename with optimistic `metadata.name`; failures surface on [errors]. */
    fun renameSession(sessionId: String, name: String) {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        scope.launch {
            try {
                sessionStore.renameSession(sessionId, trimmed)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                _errors.tryEmit(SessionListError.RenameFailed(sessionId, error.message))
            }
        }
    }

    /** `DELETE /sessions/:id` with optimistic removal; 409 while active gets explicit wording (in the UI). */
    fun deleteSession(sessionId: String) {
        scope.launch {
            try {
                sessionStore.deleteSession(sessionId)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                val stillActive = error is ApiError && error.status == 409
                _errors.tryEmit(
                    SessionListError.DeleteFailed(
                        sessionId = sessionId,
                        message = if (stillActive) null else error.message,
                        stillActive = stillActive,
                    ),
                )
            }
        }
    }

    /**
     * `POST /sessions/:id/reopen` — success emits the (possibly superseding)
     * id on [reopened] so the screen navigates into it; 422 missing-metadata
     * and other failures surface on [errors] via [formatReopenError].
     */
    fun reopenSession(sessionId: String) {
        scope.launch {
            try {
                _reopened.tryEmit(sessionStore.reopenSession(sessionId).sessionId)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                _errors.tryEmit(SessionListError.ReopenFailed(sessionId, formatReopenError(error)))
            }
        }
    }

    // ------------------------------------------------------------ mapping --

    private fun buildUiState(
        sessions: List<SessionSummary>,
        machines: List<Machine>,
        lastSeen: Map<String, Long>,
        filter: String?,
        searchQuery: String,
        selectedSessionId: String?,
        showActiveSessionsOnly: Boolean,
        isRefreshing: Boolean,
        isOffline: Boolean,
        hasLoaded: Boolean,
        dateRange: SessionDateRange? = null,
    ): SessionListUiState {
        // Use one current zone for both filtering and the calendar activity marks.
        val zone = zoneProvider()
        val names = machines.mapNotNull { machine ->
            val metadata = machine.metadata ?: return@mapNotNull null
            val name = metadata.displayName?.trim()?.takeIf { it.isNotEmpty() }
                ?: metadata.host.trim().takeIf { it.isNotEmpty() }
            name?.let { machine.id to it }
        }.toMap()
        val sessionMachineIds = sessions.map { it.metadata?.machineId ?: UNKNOWN_MACHINE_ID }.toSet()
        val nameCounts = names.filterKeys { it in sessionMachineIds }.values.groupingBy { it.lowercase(java.util.Locale.ROOT) }.eachCount()
        val shortIds = sessionMachineIds.associateWith { id ->
            var length = minOf(8, id.length)
            while (length < id.length && sessionMachineIds.any { it != id && it.take(length) == id.take(length) }) length++
            id.take(length)
        }

        // Derive choices before filtering so the selection cannot hide alternatives.
        val filters = sessions
            .groupBy { it.metadata?.machineId ?: UNKNOWN_MACHINE_ID }
            .map { (id, group) ->
                MachineFilterUi(
                    id = id,
                    label = names[id]?.let { name ->
                        if (nameCounts[name.lowercase(java.util.Locale.ROOT)]!! > 1) "$name · ${shortIds.getValue(id)}" else name
                    } ?: shortIds.getValue(id),
                    sessionCount = group.size,
                    unnamed = id !in names,
                )
            }
            .sortedWith(compareBy<MachineFilterUi> {
                when { it.id == UNKNOWN_MACHINE_ID -> 2; it.unnamed -> 1; else -> 0 }
            }.thenBy { it.label.lowercase(java.util.Locale.ROOT) }.thenBy { it.id })

        // Match the selection invalidator while its collector catches up.
        val activeFilter = filter
            ?.takeIf { filters.size >= 2 && filters.any { chip -> chip.id == it } }

        // Choose the canonical agent-session views before applying filters,
        // so excluding a winner cannot resurrect an older duplicate. Restore
        // pinned/active order after dedup regroups the rows.
        val prepared = sortSessionSummaries(
            SessionListFilters.prepareSidebarSessions(sessions, selectedSessionId),
        )

        // "Active sessions only" lens (web `filterActiveSessionsOnly`): hide
        // inactive sessions, but never the one the operator currently has
        // open — toggling the lens must not yank the selection out from
        // under them. Order-preserving, so the sort above survives.
        val corpus = if (showActiveSessionsOnly) {
            prepared.filter { it.active || it.id == selectedSessionId }
        } else {
            prepared
        }

        // Calendar hints derive from the lensed corpus, before date, machine,
        // or search filtering (web derives `sessionActivityDates` from
        // `allSessions` — post active-only, pre the other lenses). Machine
        // choices above retain their full source-snapshot counts.
        val activityDays = corpus
            .map { SessionDateRangeFilter.activityEpochDay(it.updatedAt, zone) }
            .toSet()
        val timeScoped = if (dateRange == null) {
            corpus
        } else {
            corpus.filter { SessionDateRangeFilter.matches(it.updatedAt, dateRange, zone) }
        }

        val visible = if (activeFilter == null) {
            timeScoped
        } else {
            timeScoped.filter { (it.metadata?.machineId ?: UNKNOWN_MACHINE_ID) == activeFilter }
        }

        // Text search: relevance ranking over the already-prepared corpus,
        // pins kept contiguous ahead of ordinary rows.
        val searched = if (searchQuery.isBlank()) {
            visible
        } else {
            val machineLabels = filters.associate { it.id to it.label }
            val index = SessionListSearch.buildSessionSearchScoreIndex(visible, searchQuery) { machineId ->
                machineLabels[machineId ?: UNKNOWN_MACHINE_ID] ?: ""
            }
            SessionListSearch.sortSessionsBySearchRelevancePreservingPins(
                visible.filter { it.id in index.matchedIds },
                index,
            )
        }

        // With one machine — or a machine filter active — every visible row
        // shares the machine, so repeating it per row is noise.
        val showMachine = filters.size >= 2 && activeFilter == null

        val rows = searched.map { summary ->
            val title = sessionTitle(summary)
            val summaryText = summary.metadata?.summary?.text?.takeIf { it.isNotBlank() }
            SessionRowUi(
                summary = summary,
                title = title,
                subtitle = summaryText?.takeIf { it != title },
                meta = buildList {
                    projectLabel(summary)?.let(::add)
                    summary.metadata?.worktree?.let { add(it.name.ifBlank { it.branch }) }
                }.takeIf { it.isNotEmpty() }?.joinToString(" · "),
                flavor = summary.metadata?.flavor,
                unread = LastSeenStore.isUnread(summary, lastSeen[summary.id] ?: 0),
                machine = if (showMachine) filters.find { it.id == (summary.metadata?.machineId ?: UNKNOWN_MACHINE_ID) } else null,
            )
        }

        return SessionListUiState(
            rows = rows,
            machineFilters = filters,
            activeMachineFilter = activeFilter,
            searchQuery = searchQuery,
            isRefreshing = isRefreshing,
            hasLoaded = hasLoaded,
            isOffline = isOffline,
            dateRange = dateRange,
            dateActivityEpochDays = activityDays,
        )
    }

    /** Aggregated lens inputs (machine filter/search/selection + the display active-only lens) so [combine] stays within its typed arity. */
    private data class ListLensState(
        val machineFilter: String?,
        val searchQuery: String,
        val selectedSessionId: String?,
        val activeSessionsOnly: Boolean,
    )

    /** Aggregated non-session inputs so [combine] stays within its typed arity. */
    private data class ChromeState(
        val refreshing: Boolean,
        val offline: Boolean,
        val refreshedOnce: Boolean,
        val dateRange: SessionDateRange?,
    )

    companion object {
        /** `getSessionTitle` (`web/src/lib/sessionTitle.ts`). */
        fun sessionTitle(summary: SessionSummary): String {
            val metadata = summary.metadata
            metadata?.name?.takeIf { it.isNotEmpty() }?.let { return it }
            metadata?.summary?.text?.takeIf { it.isNotEmpty() }?.let { return it }
            metadata?.path?.let { path ->
                val tail = path.split('/').lastOrNull { it.isNotEmpty() }
                if (tail != null) return tail
            }
            return summary.id.take(8)
        }

        /**
         * Project identity for the meta line: last two segments of the
         * worktree base path, session path fallback — mirrors the web
         * sidebar's `getGroupDisplayName` rule (`SessionList.tsx`).
         */
        fun projectLabel(summary: SessionSummary): String? {
            val path = summary.metadata?.worktree?.basePath ?: summary.metadata?.path
            if (path.isNullOrEmpty()) return null
            val parts = path.split('/', '\\').filter { it.isNotEmpty() }
            return when {
                parts.isEmpty() -> path
                parts.size == 1 -> parts[0]
                else -> "${parts[parts.size - 2]}/${parts[parts.size - 1]}"
            }
        }
    }
}

/** `PUT /sessions/:id/pin` modes. */
enum class PinMode(val wire: String) {
    None("none"),
    Project("project"),
    Global("global"),
}

sealed interface SessionListError {
    val sessionId: String
    val message: String?

    data class PinFailed(override val sessionId: String, override val message: String?) : SessionListError
    data class ArchiveFailed(override val sessionId: String, override val message: String?) : SessionListError
    data class RenameFailed(override val sessionId: String, override val message: String?) : SessionListError
    data class DeleteFailed(
        override val sessionId: String,
        override val message: String?,
        /** `DELETE` answered 409 — session still active; UI shows the archive-first wording. */
        val stillActive: Boolean = false,
    ) : SessionListError
    data class ReopenFailed(override val sessionId: String, override val message: String?) : SessionListError

    /** Machines list refresh failed — advisory only, never the offline banner. */
    data class MachinesRefreshFailed(override val message: String?) : SessionListError {
        override val sessionId: String get() = ""
    }
}
