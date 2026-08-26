package app.hapi.data.store

import app.hapi.data.api.HapiApi
import app.hapi.data.sse.SseSubscriptionKey
import app.hapi.protocol.patch.applySessionDetailPatch
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.ReopenSessionResponse
import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionPatch
import app.hapi.protocol.wire.SessionPatches
import app.hapi.protocol.wire.SessionSummary
import app.hapi.protocol.wire.SummaryPatching
import app.hapi.protocol.wire.SyncEvent
import app.hapi.protocol.wire.sortSessionSummaries
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement

/**
 * The session-facing store surface the UI layer depends on ([SessionStore] is
 * the production implementation; ViewModel tests substitute fakes).
 */
interface SessionListStore {
    /** Sorted with `sortSessionSummaries` (globalPinned > pinned > active > pending > recency). */
    val sessions: StateFlow<List<SessionSummary>>

    /** `GET /api/sessions` — replaces the list wholesale. Throws on failure. */
    suspend fun refresh()

    /** Coalesced fire-and-forget [refresh] (the web's 16 ms invalidation batch). */
    fun scheduleRefresh()

    /** Handshake-`gap` recovery: list + every cached detail. */
    suspend fun fullResync()

    /** Routes `session-added/updated/removed/ended` into the caches. */
    fun applySessionEvent(scope: SseSubscriptionKey, event: SyncEvent)

    /** `PUT /sessions/:id/pin`, optimistic. [mode] is `none|project|global`. */
    suspend fun setPinMode(sessionId: String, mode: String)

    /** `POST /sessions/:id/archive`, optimistic removal. */
    suspend fun archiveSession(sessionId: String)

    /** `PATCH /sessions/:id` rename, optimistic `metadata.name`; rolls forward on failure. */
    suspend fun renameSession(sessionId: String, name: String)

    /** `DELETE /sessions/:id`, optimistic removal; 409 while active (restore + rethrow). */
    suspend fun deleteSession(sessionId: String)

    /**
     * `POST /sessions/:id/reopen` — the returned id may differ (superseding
     * spawn); 422 when required metadata is gone. On success the returned
     * session is marked active locally (the `session-alive` SSE may lag).
     */
    suspend fun reopenSession(sessionId: String): ReopenSessionResponse
}

/**
 * The detail-cache surface the chat screen depends on, on top of the list
 * surface ([SessionStore] implements both; chat ViewModel tests fake this).
 */
interface SessionDetailStore : SessionListStore {
    /** Live view of one cached detail; null until [loadSessionDetail] (or a full-session SSE payload). */
    fun sessionDetail(sessionId: String): Flow<Session?>

    /** Synchronous read of the cached detail (send/permission body building). */
    fun currentDetail(sessionId: String): Session?

    /** `GET /api/sessions/:id` into the detail cache (chat open / resync). */
    suspend fun loadSessionDetail(sessionId: String): Session

    /** Drops a detail nobody observes anymore (chat closed). */
    fun releaseDetail(sessionId: String)

    /**
     * Local optimistic patch of a cached detail (config switching, B-M3ab).
     * No-op when the detail is not cached; server truth (SSE patch or
     * [loadSessionDetail]) later overwrites it.
     */
    fun updateDetailLocal(sessionId: String, transform: (Session) -> Session)
}

/**
 * Session list + detail cache for one hub, fed by the global SSE pipe through
 * [applySessionEvent] (see `SyncEventRouter`/`StoreSyncTargets`) and by REST
 * ([refresh]). Mirrors the web reference's cache handlers in
 * `web/src/hooks/useSSE.ts`:
 *
 * - **Summaries** (the list): full-`Session` payloads upsert via
 *   `toSessionSummary` (preserving the hub-computed scheduled-message fields
 *   the projection cannot derive); `SessionPatch` payloads apply through
 *   [SummaryPatching.applySessionSummaryPatch] — versioned fields gated `>=`
 *   against the summary's own watermarks — and keep-alive churn is dropped by
 *   [SummaryPatching.isRenderIrrelevantPatch] before re-sorting.
 * - **Details** (per-id [Session]): populated only by [loadSessionDetail]
 *   (a screen opened the session) or a full-session SSE payload; patches
 *   apply with the **strict-`>`** versioned gates of
 *   `applySessionDetailPatch`. Where the web queues a React-Query detail
 *   invalidation for an uncached session, this store does nothing — an
 *   uncached detail has no observers, and opening the session fetches fresh.
 * - Unparseable/absent `session-updated` data falls back to REST
 *   (`sse.md#versioned-patch-algorithm` step 3): list refetch + refetch of
 *   the cached detail, if any.
 *
 * The summary list persists as a debounced JSON snapshot per hub
 * ([snapshotDir]) for instant cold start; details are memory-only (message
 * windows own their snapshots in M2c).
 */
class SessionStore(
    private val api: HapiApi,
    private val scope: CoroutineScope,
    snapshotDir: File? = null,
    private val refreshBatchMs: Long = REFRESH_BATCH_MS,
) : SessionDetailStore {

    private val snapshot: JsonSnapshotStore<List<SessionSummary>>? = snapshotDir?.let { dir ->
        JsonSnapshotStore(
            file = File(dir, "sessions.json"),
            serializer = ListSerializer(SessionSummary.serializer()),
            scope = scope,
        )
    }

    private val _sessions = MutableStateFlow(snapshot?.load()?.let(::sortSessionSummaries) ?: emptyList())
    override val sessions: StateFlow<List<SessionSummary>> = _sessions.asStateFlow()

    private val _details = MutableStateFlow<Map<String, Session>>(emptyMap())

    /** All cached details; per-id observation via [sessionDetail]. */
    val details: StateFlow<Map<String, Session>> = _details.asStateFlow()

    private val _scratchlistInvalidations = MutableSharedFlow<String>(extraBufferCapacity = 64)

    /**
     * Session ids whose SSE patch carried `scratchlistUpdatedAt` — a bare
     * refetch trigger for that session's scratchlist query (the timestamp is
     * the signal, not data; `sse.md`). `ScratchlistStore` collects this and
     * refetches observed sessions (the web twin invalidates the React-Query
     * key in `useSSE.ts`).
     */
    val scratchlistInvalidations: SharedFlow<String> = _scratchlistInvalidations.asSharedFlow()

    private val refreshMutex = Mutex()
    private val refreshQueued = AtomicBoolean(false)

    override fun sessionDetail(sessionId: String): Flow<Session?> =
        _details.map { it[sessionId] }.distinctUntilChanged()

    override fun currentDetail(sessionId: String): Session? = _details.value[sessionId]

    override suspend fun loadSessionDetail(sessionId: String): Session {
        val session = api.getSession(sessionId).session
        _details.update { it + (sessionId to session) }
        return session
    }

    override fun releaseDetail(sessionId: String) {
        _details.update { it - sessionId }
    }

    override fun updateDetailLocal(sessionId: String, transform: (Session) -> Session) {
        _details.update { map ->
            val current = map[sessionId] ?: return@update map
            map + (sessionId to transform(current))
        }
    }

    /** Forces the debounced snapshot to disk (app background / tests). */
    suspend fun flushPersistence() {
        snapshot?.flush()
    }

    override suspend fun refresh() {
        refreshMutex.withLock {
            val response = api.getSessions()
            updateSummaries { sortSessionSummaries(response.sessions) }
        }
    }

    override fun scheduleRefresh() {
        if (!refreshQueued.compareAndSet(false, true)) return
        scope.launch {
            delay(refreshBatchMs)
            refreshQueued.set(false)
            try {
                refresh()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                // Offline burst — the next SSE event or manual refresh retries.
            }
        }
    }

    override suspend fun fullResync() {
        refresh()
        for (sessionId in _details.value.keys.toList()) {
            try {
                loadSessionDetail(sessionId)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                // Keep the stale cached detail; the session pipe re-syncs it.
            }
        }
    }

    override fun applySessionEvent(scope: SseSubscriptionKey, event: SyncEvent) {
        when (event) {
            is SyncEvent.SessionAdded -> upsertOrPatch(event.sessionId, event.data)
            is SyncEvent.SessionUpdated -> upsertOrPatch(event.sessionId, event.data)
            is SyncEvent.SessionRemoved -> {
                _details.update { it - event.sessionId }
                updateSummaries { list ->
                    val next = list.filter { it.id != event.sessionId }
                    if (next.size == list.size) list else next
                }
            }
            // The reference has no session-ended cache branch: the state
            // change always arrives through the session-updated flow too.
            is SyncEvent.SessionEnded -> Unit
            else -> Unit
        }
    }

    override suspend fun setPinMode(sessionId: String, mode: String) {
        // Optimistic flip mirroring the hub flag mapping
        // (`hub/src/store/sessions.ts setSessionPinMode`): project → pinned,
        // global → globalPinned, none → neither.
        updateSummaries { list ->
            if (list.none { it.id == sessionId }) list
            else sortSessionSummaries(
                list.map {
                    if (it.id != sessionId) it
                    else it.copy(pinned = mode == "project", globalPinned = mode == "global")
                }
            )
        }
        try {
            api.setSessionPinMode(sessionId, mode)
        } catch (error: Exception) {
            // Roll forward to server truth instead of restoring a stale list
            // (SSE may have moved other rows since the optimistic write).
            scheduleRefresh()
            throw error
        }
    }

    override suspend fun archiveSession(sessionId: String) {
        val removed = _sessions.value.firstOrNull { it.id == sessionId }
        updateSummaries { list -> list.filter { it.id != sessionId } }
        try {
            api.archiveSession(sessionId)
        } catch (error: Exception) {
            if (removed != null) {
                updateSummaries { list ->
                    if (list.any { it.id == sessionId }) list
                    else sortSessionSummaries(list + removed)
                }
            }
            throw error
        }
    }

    override suspend fun renameSession(sessionId: String, name: String) {
        // Optimistic `metadata.name` on both caches. A summary without
        // metadata is left alone (there is nothing renderable to update);
        // server truth arrives via the session-updated patch.
        updateSummaries { list ->
            val index = list.indexOfFirst { it.id == sessionId }
            if (index < 0) return@updateSummaries list
            val current = list[index]
            val metadata = current.metadata ?: return@updateSummaries list
            list.toMutableList().also { it[index] = current.copy(metadata = metadata.copy(name = name)) }
        }
        updateDetailLocal(sessionId) { detail ->
            detail.metadata?.let { detail.copy(metadata = it.copy(name = name)) } ?: detail
        }
        try {
            api.renameSession(sessionId, name)
        } catch (error: Exception) {
            // Roll forward to server truth (an SSE patch may have moved other
            // fields since the optimistic write) — same policy as setPinMode.
            scheduleRefresh()
            if (_details.value.containsKey(sessionId)) {
                scope.launch { runCatching { loadSessionDetail(sessionId) } }
            }
            throw error
        }
    }

    override suspend fun deleteSession(sessionId: String) {
        val removed = _sessions.value.firstOrNull { it.id == sessionId }
        val removedDetail = _details.value[sessionId]
        updateSummaries { list -> list.filter { it.id != sessionId } }
        _details.update { it - sessionId }
        try {
            api.deleteSession(sessionId)
        } catch (error: Exception) {
            // 409 while active (archive first) or plain failure: restore.
            if (removed != null) {
                updateSummaries { list ->
                    if (list.any { it.id == sessionId }) list
                    else sortSessionSummaries(list + removed)
                }
            }
            if (removedDetail != null) {
                _details.update { map ->
                    if (map.containsKey(sessionId)) map else map + (sessionId to removedDetail)
                }
            }
            throw error
        }
    }

    override suspend fun reopenSession(sessionId: String): ReopenSessionResponse {
        val response = api.reopenSession(sessionId)
        // Mirror the web's markSessionActiveInCache: the session-alive SSE may
        // arrive before or after — optimistically show the RETURNED id active
        // so the UI does not sit on "inactive" until the next event.
        val now = System.currentTimeMillis()
        updateSummaries { list ->
            val index = list.indexOfFirst { it.id == response.sessionId }
            if (index < 0) return@updateSummaries list
            val current = list[index]
            sortSessionSummaries(
                list.toMutableList().also {
                    it[index] = current.copy(active = true, activeAt = maxOf(current.activeAt, now))
                }
            )
        }
        updateDetailLocal(response.sessionId) { detail ->
            detail.copy(active = true, activeAt = maxOf(detail.activeAt, now))
        }
        // A superseding id will not be in the list yet — refetch covers both.
        scheduleRefresh()
        return response
    }

    // ------------------------------------------------------------ internal --

    private fun upsertOrPatch(sessionId: String, data: JsonElement?) {
        // Order matters and mirrors the reference: full-session check first
        // (`isSessionRecord && data.id === sessionId`), then the strict patch
        // parse, then the REST fallback.
        val full = parseFullSession(data)?.takeIf { it.id == sessionId }
        if (full != null) {
            _details.update { it + (sessionId to full) }
            upsertSummary(full)
            return
        }
        val patch = SessionPatches.parse(data)
        if (patch != null) {
            patchDetail(sessionId, patch)
            val summaryPatched = patchSummary(sessionId, patch)
            if (!summaryPatched) {
                // Row not in the list yet (fresh spawn raced the refetch).
                scheduleRefresh()
            }
            // Bare refetch trigger for the scratchlist query (never applied
            // to session state — matching the reference client).
            if (patch.scratchlistUpdatedAt != null) {
                _scratchlistInvalidations.tryEmit(sessionId)
            }
            return
        }
        // Absent or unparseable payload → REST fallback.
        if (_details.value.containsKey(sessionId)) {
            scope.launch {
                try {
                    loadSessionDetail(sessionId)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (_: Exception) {
                    // Stale detail survives until the next successful sync.
                }
            }
        }
        scheduleRefresh()
    }

    private fun parseFullSession(data: JsonElement?): Session? {
        if (data == null) return null
        return try {
            HapiJson.decodeFromJsonElement(Session.serializer(), data)
        } catch (_: Exception) {
            null
        }
    }

    private fun upsertSummary(session: Session) {
        updateSummaries { list ->
            val index = list.indexOfFirst { it.id == session.id }
            val existing = if (index >= 0) list[index] else null
            // The projection cannot derive the hub-computed scheduled-message
            // fields — carry them over from the previous row (web
            // `upsertSessionSummary`).
            val summary = SummaryPatching.toSessionSummary(session).copy(
                futureScheduledMessageCount = existing?.futureScheduledMessageCount ?: 0,
                nextScheduledAt = existing?.nextScheduledAt,
            )
            val next = list.toMutableList()
            if (index >= 0) next[index] = summary else next.add(summary)
            sortSessionSummaries(next)
        }
    }

    /** Detail patch with strict-`>` versioned gates; true when a row was cached. */
    private fun patchDetail(sessionId: String, patch: SessionPatch): Boolean {
        var present = false
        _details.update { map ->
            val current = map[sessionId] ?: return@update map
            present = true
            // Null result = render-irrelevant → keep the previous identity.
            val next = applySessionDetailPatch(current, patch) ?: return@update map
            map + (sessionId to next)
        }
        return present
    }

    /** Summary patch (`>=` gates + keep-alive suppression); true when the row exists. */
    private fun patchSummary(sessionId: String, patch: SessionPatch): Boolean {
        var present = false
        updateSummaries { list ->
            val index = list.indexOfFirst { it.id == sessionId }
            if (index < 0) return@updateSummaries list
            present = true
            val current = list[index]
            val next = SummaryPatching.applySessionSummaryPatch(current, patch)
            // Keep-alive noise: activeAt-only movement keeps the previous
            // list identity (no emission, no re-sort, no snapshot write).
            if (SummaryPatching.isRenderIrrelevantPatch(current, next)) return@updateSummaries list
            sortSessionSummaries(list.toMutableList().also { it[index] = next })
        }
        return present
    }

    /** CAS update; snapshots only when the transform produced a new list. */
    private fun updateSummaries(transform: (List<SessionSummary>) -> List<SessionSummary>) {
        while (true) {
            val previous = _sessions.value
            val next = transform(previous)
            if (next === previous) return
            if (_sessions.compareAndSet(previous, next)) {
                snapshot?.scheduleWrite(next)
                return
            }
        }
    }

    private companion object {
        /** `INVALIDATION_BATCH_MS` in the web reference. */
        const val REFRESH_BATCH_MS: Long = 16
    }
}

/** CAS-loop update for [MutableStateFlow] maps (kotlinx's update, minus the inline reified). */
private inline fun <K, V> MutableStateFlow<Map<K, V>>.update(transform: (Map<K, V>) -> Map<K, V>) {
    while (true) {
        val previous = value
        val next = transform(previous)
        if (next === previous || compareAndSet(previous, next)) return
    }
}
