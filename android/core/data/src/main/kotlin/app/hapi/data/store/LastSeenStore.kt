package app.hapi.data.store

import app.hapi.protocol.wire.SessionSummary
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

/** Snapshot payload: watermarks, explicit-unread marks, and baseline scopes. */
@Serializable
data class LastSeenState(
    val lastSeen: Map<String, Long> = emptyMap(),
    val baselines: Set<String> = emptySet(),
    /** `hapi.sessionManualUnread.v1` port: session id → the `updatedAt` marked unread. */
    val manualUnread: Map<String, Long> = emptyMap(),
)

/**
 * Per-session last-seen watermarks — port of `web/src/lib/sessionLastSeen.ts`
 * (localStorage → per-hub JSON snapshot) plus the unread derivation from
 * `web/src/lib/sessionAttention.ts`.
 *
 * The watermark is the session `updatedAt` the operator last had on screen;
 * a session is **unread** when its current `updatedAt` moved past it
 * ([isUnread] — the reference compares `updatedAt` only; message `seq` never
 * reaches the summary). [initializeBaseline] seeds missing watermarks from
 * the first session list so a fresh install does not mark every historical
 * session unread — once per [LastSeenState.baselines] scope, exactly like the
 * web's per-scope baseline flag.
 */
class LastSeenStore(
    scope: CoroutineScope,
    snapshotDir: File? = null,
) {
    private val snapshot: JsonSnapshotStore<LastSeenState>? = snapshotDir?.let { dir ->
        JsonSnapshotStore(
            file = File(dir, "last-seen.json"),
            serializer = LastSeenState.serializer(),
            scope = scope,
        )
    }

    private val _state = MutableStateFlow(snapshot?.load() ?: LastSeenState())
    val state: StateFlow<LastSeenState> = _state.asStateFlow()

    fun lastSeenAt(sessionId: String): Long = _state.value.lastSeen[sessionId] ?: 0

    /** Timestamp the operator explicitly marked unread ([markUnread]), if any. */
    fun manualUnreadAt(sessionId: String): Long? = _state.value.manualUnread[sessionId]

    /** Forces the debounced snapshot to disk (app background / tests). */
    suspend fun flushPersistence() {
        snapshot?.flush()
    }

    /**
     * `markSessionSeen`: monotonic max — a stale screen never rewinds the
     * watermark — and clears an explicit-unread mark once the screen has
     * caught up to it (`nextSeenAt >= manualUnreadAt`, the reference rule).
     */
    fun markSeen(sessionId: String, seenAt: Long) {
        if (sessionId.isEmpty()) return
        updateState { state ->
            val current = state.lastSeen[sessionId] ?: 0
            val next = maxOf(current, seenAt)
            val seenChanged = state.lastSeen[sessionId] != next
            val manual = state.manualUnread[sessionId]
            val manualChanged = manual != null && next >= manual
            if (!seenChanged && !manualChanged) {
                state
            } else {
                state.copy(
                    lastSeen = if (seenChanged) state.lastSeen + (sessionId to next) else state.lastSeen,
                    manualUnread = if (manualChanged) state.manualUnread - sessionId else state.manualUnread,
                )
            }
        }
    }

    /**
     * `initializeSessionLastSeen`: on the first list load for [scopeKey]
     * (e.g. the hub id), seed every session without a watermark at its
     * current `updatedAt`, then never again for that scope.
     */
    fun initializeBaseline(scopeKey: String, sessions: Iterable<SessionSummary>) {
        updateState { state ->
            if (scopeKey in state.baselines) return@updateState state
            val seeded = state.lastSeen.toMutableMap()
            for (session in sessions) {
                seeded.getOrPut(session.id) { session.updatedAt }
            }
            state.copy(lastSeen = seeded, baselines = state.baselines + scopeKey)
        }
    }

    /**
     * `markSessionUnread`: move the watermark just behind the current activity
     * (`updatedAt - 1`, only when it is not already behind) and remember the
     * explicit action so the unread state survives the summary being the
     * screen's own session.
     */
    fun markUnread(sessionId: String, updatedAt: Long) {
        if (sessionId.isEmpty()) return
        updateState { state ->
            val unreadBefore = updatedAt - 1
            val current = state.lastSeen[sessionId]
            val seenChanged = !(current != null && current <= unreadBefore)
            val manualChanged = state.manualUnread[sessionId] != updatedAt
            if (!seenChanged && !manualChanged) {
                state
            } else {
                state.copy(
                    lastSeen = if (seenChanged) state.lastSeen + (sessionId to unreadBefore) else state.lastSeen,
                    manualUnread = if (manualChanged) state.manualUnread + (sessionId to updatedAt) else state.manualUnread,
                )
            }
        }
    }

    /**
     * `markAllSessionsSeen`: stamp every supplied session with unread
     * activity as seen (watermark at its latest `updatedAt`, explicit-unread
     * mark dropped). Returns how many were unread — counted against the
     * pre-call snapshot like the reference's read-then-write, so the CAS
     * retry in [updateState] cannot double-count.
     */
    fun markAllSeen(sessions: Iterable<SessionSummary>): Int {
        val latest = latestSessionUpdates(sessions)
        if (latest.isEmpty()) return 0
        val before = _state.value
        var count = 0
        for ((sessionId, updatedAt) in latest) {
            if (hasUnreadActivity(updatedAt, before.lastSeen[sessionId] ?: 0, before.manualUnread[sessionId])) {
                count += 1
            }
        }
        if (count == 0) return 0
        updateState { state ->
            val nextSeen = state.lastSeen.toMutableMap()
            val nextManual = state.manualUnread.toMutableMap()
            var changed = false
            for ((sessionId, updatedAt) in latest) {
                if (!hasUnreadActivity(updatedAt, nextSeen[sessionId] ?: 0, nextManual[sessionId])) continue
                val stamped = maxOf(nextSeen[sessionId] ?: 0, updatedAt)
                if (nextSeen[sessionId] != stamped) {
                    nextSeen[sessionId] = stamped
                    changed = true
                }
                if (nextManual.remove(sessionId) != null) changed = true
            }
            if (!changed) state else state.copy(lastSeen = nextSeen, manualUnread = nextManual)
        }
        return count
    }

    /** `latestSessionUpdates`: per-id max `updatedAt` (web dedups repeated ids). */
    private fun latestSessionUpdates(sessions: Iterable<SessionSummary>): Map<String, Long> {
        val latest = LinkedHashMap<String, Long>()
        for (session in sessions) {
            if (session.id.isEmpty()) continue
            val current = latest[session.id]
            if (current == null || session.updatedAt > current) latest[session.id] = session.updatedAt
        }
        return latest
    }

    private inline fun updateState(transform: (LastSeenState) -> LastSeenState) {
        while (true) {
            val previous = _state.value
            val next = transform(previous)
            if (next === previous) return
            if (_state.compareAndSet(previous, next)) {
                snapshot?.scheduleWrite(next)
                return
            }
        }
    }

    companion object {
        /** `sessionIsUnread`: activity newer than the operator's watermark. */
        fun isUnread(summary: SessionSummary, lastSeenAt: Long): Boolean =
            summary.updatedAt > lastSeenAt

        /**
         * `hasUnreadActivity`: watermark comparison OR an explicit-unread
         * mark pinned to this exact `updatedAt` (the reference's defensive
         * OR — `markUnread` already parks the watermark behind the activity).
         */
        fun hasUnreadActivity(updatedAt: Long, lastSeenAt: Long, manualUnreadAt: Long?): Boolean =
            updatedAt > lastSeenAt || manualUnreadAt == updatedAt

        /**
         * `getUnreadSessionCount`: unread sessions among [sessions], one
         * snapshot of both maps (bulk lens/toolbar counting). Repeated ids
         * collapse to their max `updatedAt`, like the reference.
         */
        fun unreadSessionCount(
            sessions: Iterable<SessionSummary>,
            lastSeen: Map<String, Long>,
            manualUnread: Map<String, Long>,
        ): Int {
            val latest = LinkedHashMap<String, Long>()
            for (session in sessions) {
                if (session.id.isEmpty()) continue
                val current = latest[session.id]
                if (current == null || session.updatedAt > current) latest[session.id] = session.updatedAt
            }
            var count = 0
            for ((sessionId, updatedAt) in latest) {
                if (hasUnreadActivity(updatedAt, lastSeen[sessionId] ?: 0, manualUnread[sessionId])) count += 1
            }
            return count
        }
    }
}
