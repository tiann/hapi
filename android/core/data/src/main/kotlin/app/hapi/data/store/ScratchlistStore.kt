package app.hapi.data.store

import app.hapi.data.api.ApiError
import app.hapi.data.api.HapiApi
import app.hapi.protocol.wire.SCRATCHLIST_MAX_ENTRIES
import app.hapi.protocol.wire.SCRATCHLIST_MAX_TEXT_LENGTH
import app.hapi.protocol.wire.ScratchlistAttachment
import app.hapi.protocol.wire.ScratchlistAttachmentLimits
import app.hapi.protocol.wire.ScratchlistEntry
import app.hapi.protocol.wire.ScratchlistEntryCreateRequest
import app.hapi.protocol.wire.ScratchlistEntryUpdateRequest
import app.hapi.protocol.wire.ScratchlistErrorCodes
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Live scratchlist view of one session ([SessionScratchlist.state]). */
data class ScratchlistSessionState(
    /** Optimistic rows first, then hub order (`createdAt DESC`). */
    val entries: List<ScratchlistEntry> = emptyList(),
    /** At least one fetch succeeded — an empty [entries] means "truly empty". */
    val loaded: Boolean = false,
    val isRefreshing: Boolean = false,
    /** No successful fetch yet and the last attempt failed → error state. */
    val loadFailed: Boolean = false,
    /**
     * The session sits at the 200-entry cap (local count, or the hub's 409
     * `scratchlist_at_cap` verdict) — disable the add affordances.
     */
    val atCap: Boolean = false,
    /** Filenames of attachment uploads in flight (indeterminate progress chips). */
    val uploadsInFlight: List<String> = emptyList(),
)

sealed interface ScratchlistCreateResult {
    data class Created(val entry: ScratchlistEntry) : ScratchlistCreateResult
    data object AtCap : ScratchlistCreateResult
    data class Failed(val error: Exception) : ScratchlistCreateResult
}

sealed interface ScratchlistUploadResult {
    data class Uploaded(val attachment: ScratchlistAttachment) : ScratchlistUploadResult

    /** [code] is the typed hub code when present (`scratchlist_attachment_too_large`, …). */
    data class Failed(val message: String, val code: String? = null) : ScratchlistUploadResult
}

sealed interface ScratchlistAttachmentDeleteResult {
    data object Removed : ScratchlistAttachmentDeleteResult

    /** 409 `scratchlist_attachment_in_use` — an entry still references the file. */
    data object InUse : ScratchlistAttachmentDeleteResult
    data class Failed(val error: Exception) : ScratchlistAttachmentDeleteResult
}

/**
 * The scratchlist surface UI layers depend on ([ScratchlistStore] is the
 * production implementation; ViewModel tests substitute fakes).
 */
interface SessionScratchlist {
    fun state(sessionId: String): Flow<ScratchlistSessionState>

    fun currentState(sessionId: String): ScratchlistSessionState

    /** Marks the session observed (SSE invalidations refetch it) + refreshes. */
    fun open(sessionId: String)

    /** Unmarks observed; cached entries stay for instant re-open. */
    fun release(sessionId: String)

    /** `GET /sessions/:id/scratchlist` — replaces the cached list. Throws on failure. */
    suspend fun refresh(sessionId: String)

    /**
     * Optimistic create. The optimistic row's entryId travels in the POST, so
     * a retry after an ambiguous failure is idempotent (hub answers 200 with
     * the canonical row for a known id). Local count at the 200-entry cap
     * short-circuits to [ScratchlistCreateResult.AtCap] without a request.
     */
    suspend fun createEntry(
        sessionId: String,
        text: String,
        attachments: List<ScratchlistAttachment> = emptyList(),
    ): ScratchlistCreateResult

    /**
     * Optimistic update (null = keep; `attachments = []` clears). Rolls the
     * row back on failure; a 404 drops it and refetches (entry deleted
     * elsewhere). Returns false when the update did not stick.
     */
    suspend fun updateEntry(
        sessionId: String,
        entryId: String,
        text: String? = null,
        attachments: List<ScratchlistAttachment>? = null,
    ): Boolean

    /** Optimistic delete; restores on failure. A 404 counts as success (already gone). */
    suspend fun deleteEntry(sessionId: String, entryId: String): Boolean

    /** Base64-JSON upload; in flight it appears in [ScratchlistSessionState.uploadsInFlight]. */
    suspend fun uploadAttachment(
        sessionId: String,
        filename: String,
        bytes: ByteArray,
        mimeType: String,
    ): ScratchlistUploadResult

    suspend fun deleteAttachment(sessionId: String, attachmentId: String): ScratchlistAttachmentDeleteResult

    /** Hub attachment budgets, cached after the first success; defaults offline. */
    suspend fun limits(sessionId: String): ScratchlistAttachmentLimits
}

/**
 * Per-session scratchlist cache for one hub (tiann/hapi#893, B-M4d), the
 * native twin of `web/src/lib/use-hub-scratchlist.ts`:
 *
 * - **Fetching**: [open] (chat/scratchlist screen) refreshes; a
 *   `scratchlistUpdatedAt` SSE patch signal ([invalidations], fed by
 *   `SessionStore.scratchlistInvalidations`) refetches sessions somebody
 *   observes — the timestamp is the trigger, never data. Refetches coalesce
 *   per session like the list store's 16 ms invalidation batch.
 * - **Optimistic mutations** reconcile surgically (by entryId) instead of
 *   snapshot-restore, so a concurrent SSE refetch cannot resurrect rolled-back
 *   rows; refreshes preserve optimistic rows whose POST is still in flight.
 * - **Cap**: local pre-check at [SCRATCHLIST_MAX_ENTRIES] plus the hub's 409
 *   `scratchlist_at_cap` both surface as the friendly
 *   [ScratchlistSessionState.atCap] flag (recomputed from entry count on every
 *   refresh).
 *
 * Text is trimmed and truncated to [SCRATCHLIST_MAX_TEXT_LENGTH] (web
 * truncates rather than rejects). Entries are memory-only: the hub is the
 * durable store and every open refetches.
 */
class ScratchlistStore(
    private val api: HapiApi,
    private val scope: CoroutineScope,
    invalidations: Flow<String>? = null,
    private val refreshBatchMs: Long = REFRESH_BATCH_MS,
    private val now: () -> Long = System::currentTimeMillis,
    private val entryIdGenerator: () -> String = { "scratch-${UUID.randomUUID()}" },
) : SessionScratchlist {

    private val states = MutableStateFlow<Map<String, ScratchlistSessionState>>(emptyMap())

    /** All cached sessions; per-id observation via [state]. */
    val allStates: StateFlow<Map<String, ScratchlistSessionState>> = states.asStateFlow()

    private val observers = ConcurrentHashMap<String, Int>()
    private val refreshQueued = ConcurrentHashMap.newKeySet<String>()
    private val refreshMutexes = ConcurrentHashMap<String, Mutex>()

    /** Optimistic-create entry ids whose POST has not settled (refresh keeps them). */
    private val pendingCreates = ConcurrentHashMap.newKeySet<String>()

    @Volatile
    private var cachedLimits: ScratchlistAttachmentLimits? = null

    init {
        if (invalidations != null) {
            scope.launch {
                invalidations.collect { sessionId ->
                    if ((observers[sessionId] ?: 0) > 0) scheduleRefresh(sessionId)
                }
            }
        }
    }

    override fun state(sessionId: String): Flow<ScratchlistSessionState> =
        states.map { it[sessionId] ?: EMPTY_STATE }.distinctUntilChanged()

    override fun currentState(sessionId: String): ScratchlistSessionState =
        states.value[sessionId] ?: EMPTY_STATE

    override fun open(sessionId: String) {
        observers.merge(sessionId, 1, Int::plus)
        scheduleRefresh(sessionId)
    }

    override fun release(sessionId: String) {
        observers.computeIfPresent(sessionId) { _, count -> (count - 1).takeIf { it > 0 } }
    }

    override suspend fun refresh(sessionId: String) {
        refreshMutexes.getOrPut(sessionId) { Mutex() }.withLock {
            update(sessionId) { it.copy(isRefreshing = true) }
            val fetched = try {
                api.getScratchlist(sessionId).entries
            } catch (error: Exception) {
                update(sessionId) { st ->
                    st.copy(isRefreshing = false, loadFailed = !st.loaded)
                }
                throw error
            }
            update(sessionId) { st ->
                // Keep optimistic rows whose POST is still in flight — a
                // wholesale replace would flash them away mid-create.
                val optimistic = st.entries.filter { entry ->
                    entry.entryId in pendingCreates && fetched.none { it.entryId == entry.entryId }
                }
                withEntries(st, optimistic + fetched).copy(
                    loaded = true,
                    isRefreshing = false,
                    loadFailed = false,
                )
            }
        }
    }

    /** Coalesced fire-and-forget [refresh] (per-session 16 ms batch). */
    fun scheduleRefresh(sessionId: String) {
        if (!refreshQueued.add(sessionId)) return
        scope.launch {
            delay(refreshBatchMs)
            refreshQueued.remove(sessionId)
            try {
                refresh(sessionId)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (_: Exception) {
                // Offline burst — the next signal or screen open retries.
            }
        }
    }

    // ----------------------------------------------------------- mutations --

    override suspend fun createEntry(
        sessionId: String,
        text: String,
        attachments: List<ScratchlistAttachment>,
    ): ScratchlistCreateResult {
        val trimmed = clampText(text)
        if (trimmed.isEmpty() && attachments.isEmpty()) {
            return ScratchlistCreateResult.Failed(IllegalArgumentException("Entry requires text or attachments"))
        }
        if (currentState(sessionId).entries.size >= SCRATCHLIST_MAX_ENTRIES) {
            update(sessionId) { it.copy(atCap = true) }
            return ScratchlistCreateResult.AtCap
        }

        val stamp = now()
        val optimistic = ScratchlistEntry(
            entryId = entryIdGenerator(),
            text = trimmed,
            createdAt = stamp,
            updatedAt = stamp,
            attachments = attachments,
        )
        pendingCreates.add(optimistic.entryId)
        update(sessionId) { st -> withEntries(st, listOf(optimistic) + st.entries) }

        return try {
            val response = api.createScratchlistEntry(
                sessionId,
                ScratchlistEntryCreateRequest(
                    text = trimmed,
                    entryId = optimistic.entryId,
                    createdAt = stamp,
                    attachments = attachments.takeIf { it.isNotEmpty() },
                ),
            )
            pendingCreates.remove(optimistic.entryId)
            val canonical = response.entry
            update(sessionId) { st ->
                // Replace the optimistic row; drop any duplicate the SSE
                // refetch may have landed first (web onSuccess dedupe).
                val without = st.entries.filter {
                    it.entryId != optimistic.entryId && it.entryId != canonical.entryId
                }
                withEntries(st, listOf(canonical) + without)
            }
            ScratchlistCreateResult.Created(canonical)
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            pendingCreates.remove(optimistic.entryId)
            update(sessionId) { st ->
                withEntries(st, st.entries.filter { it.entryId != optimistic.entryId })
            }
            if (error is ApiError && error.status == 409 && error.code == ScratchlistErrorCodes.AT_CAP) {
                update(sessionId) { it.copy(atCap = true) }
                // Reconcile the local count with the hub's cap verdict.
                scheduleRefresh(sessionId)
                ScratchlistCreateResult.AtCap
            } else {
                ScratchlistCreateResult.Failed(error)
            }
        }
    }

    override suspend fun updateEntry(
        sessionId: String,
        entryId: String,
        text: String?,
        attachments: List<ScratchlistAttachment>?,
    ): Boolean {
        val trimmed = text?.let(::clampText)
        if (trimmed == null && attachments == null) return false
        val previous = currentState(sessionId).entries.firstOrNull { it.entryId == entryId }
        if (previous != null) {
            val optimistic = previous.copy(
                text = trimmed ?: previous.text,
                attachments = attachments ?: previous.attachments,
                updatedAt = now(),
            )
            replaceEntry(sessionId, entryId, optimistic)
        }
        return try {
            val response = api.updateScratchlistEntry(
                sessionId,
                entryId,
                ScratchlistEntryUpdateRequest(text = trimmed, attachments = attachments),
            )
            replaceEntry(sessionId, entryId, response.entry)
            true
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (error is ApiError && error.status == 404) {
                // Deleted elsewhere — drop the row and reconcile.
                update(sessionId) { st ->
                    withEntries(st, st.entries.filter { it.entryId != entryId })
                }
                scheduleRefresh(sessionId)
            } else if (previous != null) {
                replaceEntry(sessionId, entryId, previous)
            }
            false
        }
    }

    override suspend fun deleteEntry(sessionId: String, entryId: String): Boolean {
        val entries = currentState(sessionId).entries
        val index = entries.indexOfFirst { it.entryId == entryId }
        val removed = if (index >= 0) entries[index] else null
        if (removed != null) {
            update(sessionId) { st ->
                withEntries(st, st.entries.filter { it.entryId != entryId })
            }
        }
        return try {
            api.deleteScratchlistEntry(sessionId, entryId)
            true
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (error is ApiError && error.status == 404) return true // already gone
            if (removed != null) {
                update(sessionId) { st ->
                    if (st.entries.any { it.entryId == entryId }) return@update st
                    val next = st.entries.toMutableList()
                    next.add(index.coerceIn(0, next.size), removed)
                    withEntries(st, next)
                }
            }
            false
        }
    }

    // --------------------------------------------------------- attachments --

    override suspend fun uploadAttachment(
        sessionId: String,
        filename: String,
        bytes: ByteArray,
        mimeType: String,
    ): ScratchlistUploadResult {
        update(sessionId) { it.copy(uploadsInFlight = it.uploadsInFlight + filename) }
        return try {
            val response = api.uploadScratchlistAttachment(
                sessionId,
                filename = filename,
                contentBase64 = Base64.getEncoder().encodeToString(bytes),
                mimeType = mimeType,
            )
            val attachment = response.attachment
            if (response.success && attachment != null) {
                ScratchlistUploadResult.Uploaded(attachment)
            } else {
                ScratchlistUploadResult.Failed(response.error ?: "Upload failed", response.code)
            }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            val api = error as? ApiError
            ScratchlistUploadResult.Failed(api?.code ?: error.message ?: "Upload failed", api?.code)
        } finally {
            update(sessionId) { it.copy(uploadsInFlight = it.uploadsInFlight - filename) }
        }
    }

    override suspend fun deleteAttachment(
        sessionId: String,
        attachmentId: String,
    ): ScratchlistAttachmentDeleteResult = try {
        api.deleteScratchlistAttachment(sessionId, attachmentId)
        ScratchlistAttachmentDeleteResult.Removed
    } catch (error: Exception) {
        when {
            error is CancellationException -> throw error
            error is ApiError && error.status == 409 &&
                error.code == ScratchlistErrorCodes.ATTACHMENT_IN_USE ->
                ScratchlistAttachmentDeleteResult.InUse
            error is ApiError && error.status == 404 -> ScratchlistAttachmentDeleteResult.Removed
            else -> ScratchlistAttachmentDeleteResult.Failed(error)
        }
    }

    override suspend fun limits(sessionId: String): ScratchlistAttachmentLimits {
        cachedLimits?.let { return it }
        return try {
            api.getScratchlistLimits(sessionId).limits.also { cachedLimits = it }
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            ScratchlistAttachmentLimits.DEFAULT
        }
    }

    // ------------------------------------------------------------ internal --

    /** New entries list + recomputed [ScratchlistSessionState.atCap]. */
    private fun withEntries(
        state: ScratchlistSessionState,
        entries: List<ScratchlistEntry>,
    ): ScratchlistSessionState =
        state.copy(entries = entries, atCap = entries.size >= SCRATCHLIST_MAX_ENTRIES)

    private fun replaceEntry(sessionId: String, entryId: String, entry: ScratchlistEntry) {
        update(sessionId) { st ->
            val index = st.entries.indexOfFirst { it.entryId == entryId }
            if (index < 0) return@update st
            withEntries(st, st.entries.toMutableList().also { it[index] = entry })
        }
    }

    private fun clampText(text: String): String {
        val trimmed = text.trim()
        return if (trimmed.length > SCRATCHLIST_MAX_TEXT_LENGTH) {
            trimmed.take(SCRATCHLIST_MAX_TEXT_LENGTH)
        } else {
            trimmed
        }
    }

    /** CAS update of one session's state. */
    private fun update(
        sessionId: String,
        transform: (ScratchlistSessionState) -> ScratchlistSessionState,
    ) {
        while (true) {
            val previous = states.value
            val current = previous[sessionId] ?: EMPTY_STATE
            val next = transform(current)
            if (next === current) return
            if (states.compareAndSet(previous, previous + (sessionId to next))) return
        }
    }

    private companion object {
        val EMPTY_STATE = ScratchlistSessionState()

        /** Same batch as the list store's invalidation coalescing. */
        const val REFRESH_BATCH_MS: Long = 16
    }
}
