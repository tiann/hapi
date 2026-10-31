package app.hapi.companion.feature.sessions

import app.hapi.data.api.ApiError
import app.hapi.data.store.LastSeenState
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
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.drop
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
    /** Runner-reported CPU/RAM, null when absent or the machine is unknown. */
    val health: MachineHealthUi.Presentation? = null,
)

/** One rendered list section — pinned first, running buckets when the pin-in-progress view is on, rest last. */
enum class SessionSectionKind { PINNED, RUNNING, PENDING, ACTIVE, IDLE, RECENT }

data class SessionSectionUi(
    val kind: SessionSectionKind,
    val rows: List<SessionRowUi>,
)

data class SessionListUiState(
    val rows: List<SessionRowUi>,
    /** Sections the screen renders (same rows as [rows], regrouped). */
    val sections: List<SessionSectionUi> = emptyList(),
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
    /** Transient unread lens (web parity: not a persisted preference). */
    val showUnreadOnly: Boolean = false,
    /** Transient active-only lens (web: persisted display pref; P2 wires persistence). */
    val showActiveOnly: Boolean = false,
    /** Transient pin-in-progress sections toggle (web: persisted display pref, default off). */
    val pinInProgress: Boolean = false,
    /** Unread sessions on this hub (drives the mark-all-read affordance). */
    val unreadCount: Int = 0,
    /** Hub advertises the AI title-suggestion endpoint (health capability). */
    val titleSuggestionAvailable: Boolean = false,
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
) {
    private val machineFilter = MutableStateFlow<String?>(null)
    private val searchQuery = MutableStateFlow("")
    private val selectedSessionId = MutableStateFlow<String?>(null)
    private val showUnreadOnly = MutableStateFlow(false)
    private val showActiveOnly = MutableStateFlow(false)
    private val pinInProgress = MutableStateFlow(false)
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

    /** Hub capability `titleSuggestion` (drives the rename dialog's Suggest button). */
    private val _titleSuggestionAvailable = MutableStateFlow(false)
    val titleSuggestionAvailable: StateFlow<Boolean> = _titleSuggestionAvailable.asStateFlow()

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
        // Health capability once per scope (store caches across calls); the
        // dialog hides Suggest when the hub lacks the endpoint (web parity:
        // `App.tsx` gates on `capabilities.titleSuggestion`).
        scope.launch {
            runCatching { _titleSuggestionAvailable.value = sessionStore.titleSuggestionAvailable() }
        }
    }

    val uiState: StateFlow<SessionListUiState> = combine(
        combine(sessionStore.sessions, machineStore.machines, lastSeenStore.state) { sessions, machines, lastSeen ->
            Triple(sessions, machines, lastSeen)
        },
        combine(machineFilter, searchQuery, selectedSessionId) { filter, query, selected ->
            Triple(filter, query, selected)
        },
        combine(isRefreshing, isOffline, hasRefreshedOnce, dateRange, timeZone) { refreshing, offline, loaded, range, _ ->
            ChromeState(refreshing, offline, loaded, range)
        },
        combine(showUnreadOnly, showActiveOnly, pinInProgress) { unreadOnly, activeOnly, pinning ->
            Triple(unreadOnly, activeOnly, pinning)
        },
        _titleSuggestionAvailable,
    ) { (sessions, machines, lastSeen), (filter, query, selected), chrome, (unreadOnly, activeOnly, pinning), titleSuggestion ->
        buildUiState(
            sessions = sessions,
            machines = machines,
            lastSeenState = lastSeen,
            filter = filter,
            searchQuery = query,
            selectedSessionId = selected,
            isRefreshing = chrome.refreshing,
            isOffline = chrome.offline,
            hasLoaded = chrome.refreshedOnce || sessions.isNotEmpty(),
            dateRange = chrome.dateRange,
            showUnreadOnly = unreadOnly,
            showActiveOnly = activeOnly,
            pinInProgress = pinning,
            titleSuggestionAvailable = titleSuggestion,
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

    /** Unread-lens toggle; transient — resets with the process like the web's. */
    fun setUnreadOnly(enabled: Boolean) {
        showUnreadOnly.value = enabled
    }

    /** Active-only lens toggle; transient until the P2 Display settings screen persists it. */
    fun setActiveOnly(enabled: Boolean) {
        showActiveOnly.value = enabled
    }

    /** Pin-in-progress sections toggle (`pinInProgressSessions`); transient until P2 persists it. */
    fun setPinInProgress(enabled: Boolean) {
        pinInProgress.value = enabled
    }

    /** Row action: park the watermark behind the current activity and pin the mark. */
    fun markSessionUnread(sessionId: String) {
        val summary = sessionStore.sessions.value.firstOrNull { it.id == sessionId } ?: return
        lastSeenStore.markUnread(sessionId, summary.updatedAt)
    }

    /** Toolbar action: stamp every session on this hub as seen. */
    fun markAllSessionsRead() {
        lastSeenStore.markAllSeen(sessionStore.sessions.value)
    }

    /** Call when navigating into a session: stamps the last-seen watermark. */
    fun onSessionOpened(sessionId: String) {
        selectedSessionId.value = sessionId
        val summary = sessionStore.sessions.value.firstOrNull { it.id == sessionId } ?: return
        lastSeenStore.markSeen(sessionId, summary.updatedAt)
    }

    /**
     * Call when returning home (the chat screen closes, Back lands on the
     * list): ends the selected-session exception so a read, closed session
     * leaves the unread lens (and the active-only lens — both keep the open
     * session visible). The web gets this for free — its selection is the
     * chat route and vanishes with it — while this plain [MutableStateFlow]
     * must be cleared.
     */
    fun onChatClosed() {
        selectedSessionId.value = null
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

    /** `PATCH /sessions/:id/summary` with optimistic `metadata.summary`; failures surface on [errors]. */
    fun updateSessionSummary(sessionId: String, text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        scope.launch {
            try {
                sessionStore.updateSessionSummary(sessionId, trimmed)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Exception) {
                _errors.tryEmit(SessionListError.SummaryFailed(sessionId, error.message))
            }
        }
    }

    /**
     * `POST /sessions/:id/title-suggestion` — suspending (the rename dialog
     * awaits it inline); failures propagate to the caller's catch → dialog error.
     */
    suspend fun suggestSessionTitle(sessionId: String): String =
        sessionStore.suggestSessionTitle(sessionId)

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
        lastSeenState: LastSeenState,
        filter: String?,
        searchQuery: String,
        selectedSessionId: String?,
        isRefreshing: Boolean,
        isOffline: Boolean,
        hasLoaded: Boolean,
        dateRange: SessionDateRange? = null,
        showUnreadOnly: Boolean,
        showActiveOnly: Boolean = false,
        pinInProgress: Boolean = false,
        titleSuggestionAvailable: Boolean = false,
    ): SessionListUiState {
        val lastSeen = lastSeenState.lastSeen
        val manualUnread = lastSeenState.manualUnread
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
        val machinesById = machines.associateBy { it.id }
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
                    health = MachineHealthUi.present(machinesById[id]?.health),
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

        // Calendar hints derive from the full sidebar corpus, before date,
        // machine, or search filtering (web `sessionActivityDates`). Machine
        // choices above retain their full source-snapshot counts.
        val activityDays = prepared
            .map { SessionDateRangeFilter.activityEpochDay(it.updatedAt, zone) }
            .toSet()
        val timeScoped = if (dateRange == null) {
            prepared
        } else {
            prepared.filter { SessionDateRangeFilter.matches(it.updatedAt, dateRange, zone) }
        }

        val visible = if (activeFilter == null) {
            timeScoped
        } else {
            timeScoped.filter { (it.metadata?.machineId ?: UNKNOWN_MACHINE_ID) == activeFilter }
        }

        // Active-only lens, on the filtered list BEFORE search like the
        // reference — the search box only narrows further.
        val activeLensed = if (!showActiveOnly) {
            visible
        } else {
            SessionListFilters.filterActiveSessionsOnly(visible, selectedSessionId)
        }

        // Text search: relevance ranking over the already-prepared corpus,
        // pins kept contiguous ahead of ordinary rows.
        val searched = if (searchQuery.isBlank()) {
            activeLensed
        } else {
            val machineLabels = filters.associate { it.id to it.label }
            val index = SessionListSearch.buildSessionSearchScoreIndex(activeLensed, searchQuery) { machineId ->
                machineLabels[machineId ?: UNKNOWN_MACHINE_ID] ?: ""
            }
            SessionListSearch.sortSessionsBySearchRelevancePreservingPins(
                activeLensed.filter { it.id in index.matchedIds },
                index,
            )
        }

        // Unread lens, after search like the web list: drop already-seen rows,
        // keep the open session. Not applied to the machine-filter choices or
        // the unread count below — both stay derived from the full list.
        val lensed = if (!showUnreadOnly) {
            searched
        } else {
            SessionListFilters.filterUnreadSessionsOnly(searched, selectedSessionId, lastSeen)
        }

        // With one machine — or a machine filter active — every visible row
        // shares the machine, so repeating it per row is noise.
        val showMachine = filters.size >= 2 && activeFilter == null

        val rows = lensed.map { summary ->
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
                unread = LastSeenStore.hasUnreadActivity(
                    summary.updatedAt,
                    lastSeen[summary.id] ?: 0,
                    manualUnread[summary.id],
                ),
                machine = if (showMachine) filters.find { it.id == (summary.metadata?.machineId ?: UNKNOWN_MACHINE_ID) } else null,
            )
        }

        return SessionListUiState(
            rows = rows,
            sections = buildSessionSections(rows, pinInProgress),
            machineFilters = filters,
            activeMachineFilter = activeFilter,
            searchQuery = searchQuery,
            showUnreadOnly = showUnreadOnly,
            showActiveOnly = showActiveOnly,
            pinInProgress = pinInProgress,
            unreadCount = LastSeenStore.unreadSessionCount(sessions, lastSeen, manualUnread),
            titleSuggestionAvailable = titleSuggestionAvailable,
            isRefreshing = isRefreshing,
            hasLoaded = hasLoaded,
            isOffline = isOffline,
            dateRange = dateRange,
            dateActivityEpochDays = activityDays,
        )
    }

    /** Aggregated non-session inputs so [combine] stays within its typed arity. */
    private data class ChromeState(
        val refreshing: Boolean,
        val offline: Boolean,
        val refreshedOnce: Boolean,
        val dateRange: SessionDateRange?,
    )

    /**
     * Group the rendered rows into screen sections. Off: the plain pinned
     * prefix + rest (the sort contract puts pins on top). On: the reference's
     * pin-in-progress view — connected unpinned rows float into the running
     * buckets, disconnected rows stay in the plain body.
     */
    private fun buildSessionSections(rows: List<SessionRowUi>, pinInProgress: Boolean): List<SessionSectionUi> {
        if (!pinInProgress) {
            val pinnedCount = rows.takeWhile {
                it.summary.globalPinned == true || it.summary.pinned == true
            }.size
            return buildList {
                if (pinnedCount > 0) add(SessionSectionUi(SessionSectionKind.PINNED, rows.take(pinnedCount)))
                add(SessionSectionUi(SessionSectionKind.RECENT, rows.drop(pinnedCount)))
            }
        }
        val buckets = SessionBuckets.bucketSessionRows(rows)
        return buildList {
            if (buckets.pinned.isNotEmpty()) add(SessionSectionUi(SessionSectionKind.PINNED, buckets.pinned))
            if (buckets.working.isNotEmpty()) add(SessionSectionUi(SessionSectionKind.RUNNING, buckets.working))
            if (buckets.pending.isNotEmpty()) add(SessionSectionUi(SessionSectionKind.PENDING, buckets.pending))
            if (buckets.active.isNotEmpty()) add(SessionSectionUi(SessionSectionKind.ACTIVE, buckets.active))
            if (buckets.idle.isNotEmpty()) add(SessionSectionUi(SessionSectionKind.IDLE, buckets.idle))
            if (buckets.rest.isNotEmpty()) add(SessionSectionUi(SessionSectionKind.RECENT, buckets.rest))
        }
    }

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
    data class SummaryFailed(override val sessionId: String, override val message: String?) : SessionListError
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
