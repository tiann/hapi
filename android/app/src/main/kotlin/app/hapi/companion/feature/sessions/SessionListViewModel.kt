package app.hapi.companion.feature.sessions

import app.hapi.data.api.ApiError
import app.hapi.data.store.LastSeenStore
import app.hapi.data.store.MachineListStore
import app.hapi.data.store.SessionListStore
import app.hapi.protocol.wire.Machine
import app.hapi.protocol.wire.SessionSummary
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
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
) {
    val id: String get() = summary.id
}

data class MachineFilterUi(
    /** Machine id or [UNKNOWN_MACHINE_ID]. */
    val id: String,
    val label: String,
    val sessionCount: Int,
)

data class SessionListUiState(
    val rows: List<SessionRowUi>,
    /** Render the chip bar only when at least two machines have sessions. */
    val machineFilters: List<MachineFilterUi>,
    /** `null` = All. Always one of [machineFilters] ids (stale picks fall back). */
    val activeMachineFilter: String?,
    val isRefreshing: Boolean,
    /** True once either the snapshot or a refresh produced a list. */
    val hasLoaded: Boolean,
    /** Last refresh failed — show the offline banner over snapshot data. */
    val isOffline: Boolean,
) {
    val showMachineFilterBar: Boolean get() = machineFilters.size >= 2
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
) {
    private val machineFilter = MutableStateFlow<String?>(null)
    private val isRefreshing = MutableStateFlow(false)
    private val isOffline = MutableStateFlow(false)
    private val hasRefreshedOnce = MutableStateFlow(false)

    private val _errors = MutableSharedFlow<SessionListError>(extraBufferCapacity = 8)

    /** Transient action failures (pin/archive/rename/delete/reopen) for a snackbar. */
    val errors: SharedFlow<SessionListError> = _errors.asSharedFlow()

    private val _reopened = MutableSharedFlow<String>(extraBufferCapacity = 4)

    /** Reopen succeeded — navigate into this (possibly superseding) session id. */
    val reopened: SharedFlow<String> = _reopened.asSharedFlow()

    private var refreshJob: Job? = null

    init {
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
        sessionStore.sessions,
        machineStore.machines,
        lastSeenStore.state,
        machineFilter,
        combine(isRefreshing, isOffline, hasRefreshedOnce) { refreshing, offline, loaded ->
            Triple(refreshing, offline, loaded)
        },
    ) { sessions, machines, lastSeen, filter, (refreshing, offline, refreshedOnce) ->
        buildUiState(
            sessions = sessions,
            machines = machines,
            lastSeen = lastSeen.lastSeen,
            filter = filter,
            isRefreshing = refreshing,
            isOffline = offline,
            hasLoaded = refreshedOnce || sessions.isNotEmpty(),
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

    /** Call when navigating into a session: stamps the last-seen watermark. */
    fun onSessionOpened(sessionId: String) {
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
        isRefreshing: Boolean,
        isOffline: Boolean,
        hasLoaded: Boolean,
    ): SessionListUiState {
        val machinesById = machines.associateBy { it.id }

        fun machineLabel(machineId: String?): String? {
            if (machineId == null) return null
            val metadata = machinesById[machineId]?.metadata ?: return machineId.take(8)
            val displayName = metadata.displayName?.takeIf { it.isNotBlank() }
            return displayName ?: metadata.host
        }

        // Filter chips derive from ALL sessions (pre-filter), like the web —
        // filtering first would drop chips and silently clear the selection.
        val filters = sessions
            .groupBy { it.metadata?.machineId ?: UNKNOWN_MACHINE_ID }
            .map { (id, group) ->
                MachineFilterUi(
                    id = id,
                    label = if (id == UNKNOWN_MACHINE_ID) "" else machineLabel(id).orEmpty(),
                    sessionCount = group.size,
                )
            }
            .sortedByDescending { it.sessionCount }

        // A persisted pick whose machine no longer has sessions falls back to
        // All; with fewer than two machines the bar hides and never filters.
        val activeFilter = filter
            ?.takeIf { filters.size >= 2 && filters.any { chip -> chip.id == it } }

        val visible = if (activeFilter == null) {
            sessions
        } else {
            sessions.filter { (it.metadata?.machineId ?: UNKNOWN_MACHINE_ID) == activeFilter }
        }

        // With one machine — or a machine filter active — every visible row
        // shares the machine, so repeating it per row is noise.
        val showMachine = filters.size >= 2 && activeFilter == null

        val rows = visible.map { summary ->
            val title = sessionTitle(summary)
            val summaryText = summary.metadata?.summary?.text?.takeIf { it.isNotBlank() }
            SessionRowUi(
                summary = summary,
                title = title,
                subtitle = summaryText?.takeIf { it != title },
                meta = buildList {
                    projectLabel(summary)?.let(::add)
                    summary.metadata?.worktree?.let { add(it.name.ifBlank { it.branch }) }
                    if (showMachine) machineLabel(summary.metadata?.machineId)?.let(::add)
                }.takeIf { it.isNotEmpty() }?.joinToString(" · "),
                flavor = summary.metadata?.flavor,
                unread = LastSeenStore.isUnread(summary, lastSeen[summary.id] ?: 0),
            )
        }

        return SessionListUiState(
            rows = rows,
            machineFilters = filters,
            activeMachineFilter = activeFilter,
            isRefreshing = isRefreshing,
            hasLoaded = hasLoaded,
            isOffline = isOffline,
        )
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
