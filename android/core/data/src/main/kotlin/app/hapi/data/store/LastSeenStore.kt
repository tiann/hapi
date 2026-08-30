package app.hapi.data.store

import app.hapi.protocol.wire.Session
import app.hapi.protocol.wire.SessionSummary
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

/** Snapshot payload: watermarks + which scopes already got their baseline. */
@Serializable
data class LastSeenState(
    val lastSeen: Map<String, Long> = emptyMap(),
    val baselines: Set<String> = emptySet(),
    /** Rows skipped because their legacy reply clock was not ready yet. */
    val pendingBaselines: Map<String, Set<String>> = emptyMap(),
)

/**
 * Per-session last-seen watermarks — port of `web/src/lib/sessionLastSeen.ts`
 * (localStorage → per-hub JSON snapshot) plus the unread derivation from
 * `web/src/lib/sessionAttention.ts`.
 *
 * The watermark is the latest visible assistant reply the operator last had
 * on screen, falling back to `updatedAt` for sessions without a visible
 * reply. A session is **unread** when that same activity clock moves past the
 * watermark. [initializeBaseline] seeds missing watermarks from the first
 * session list so a fresh install does not mark every historical session
 * unread — once per [LastSeenState.baselines] scope, exactly like the web's
 * per-scope baseline flag.
 */
class LastSeenStore(
    scope: CoroutineScope,
    snapshotDir: File? = null,
) {
    private val snapshot: JsonSnapshotStore<LastSeenState>? = snapshotDir?.let { dir ->
        JsonSnapshotStore(
            // v2 changes the watermark from raw updatedAt to the reply/activity
            // clock. Do not load v1 values under the new meaning.
            file = File(dir, "last-seen-v2.json"),
            serializer = LastSeenState.serializer(),
            scope = scope,
        )
    }

    private val _state = MutableStateFlow(snapshot?.load() ?: LastSeenState())
    val state: StateFlow<LastSeenState> = _state.asStateFlow()

    fun lastSeenAt(sessionId: String): Long = _state.value.lastSeen[sessionId] ?: 0

    /** Forces the debounced snapshot to disk (app background / tests). */
    suspend fun flushPersistence() {
        snapshot?.flush()
    }

    /** `markSessionSeen`: monotonic max — a stale screen never rewinds the watermark. */
    fun markSeen(sessionId: String, seenAt: Long) {
        if (sessionId.isEmpty()) return
        updateState { state ->
            val current = state.lastSeen[sessionId] ?: 0
            val next = maxOf(current, seenAt)
            if (next == current && state.lastSeen.containsKey(sessionId)) state
            else state.copy(lastSeen = state.lastSeen + (sessionId to next))
        }
    }

    /**
     * `initializeSessionLastSeen`: on the first list load for [scopeKey]
     * (e.g. the hub id), seed every session without a watermark at its
     * current reply/activity clock, then never again for that scope.
     */
    fun initializeBaseline(scopeKey: String, sessions: Iterable<SessionSummary>) {
        updateState { state ->
            val pending = state.pendingBaselines[scopeKey].orEmpty().toMutableSet()
            val seeded = state.lastSeen.toMutableMap()
            var pendingChanged = false
            for (session in sessions) {
                val replyClockReady = session.assistantReplyClockBackfilled != false
                if (scopeKey !in state.baselines) {
                    if (!replyClockReady) {
                        if (pending.add(session.id)) pendingChanged = true
                        continue
                    }
                    if (!seeded.containsKey(session.id)) {
                        seeded[session.id] = seenTimestamp(session)
                    }
                    continue
                }

                if (!replyClockReady || !pending.remove(session.id)) continue
                pendingChanged = true
                if (!seeded.containsKey(session.id)) {
                    seeded[session.id] = seenTimestamp(session)
                }
            }
            if (scopeKey in state.baselines && !pendingChanged) return@updateState state
            val nextPending = state.pendingBaselines.toMutableMap()
            if (pending.isEmpty()) nextPending.remove(scopeKey) else nextPending[scopeKey] = pending
            state.copy(
                lastSeen = seeded,
                baselines = state.baselines + scopeKey,
                pendingBaselines = nextPending,
            )
        }
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
        /** Timestamp shared by list recency, read state, and unread checks. */
        fun seenTimestamp(session: Session): Long =
            session.lastAssistantMessageAt ?: session.updatedAt

        /** Timestamp shared by list recency, read state, and unread checks. */
        fun seenTimestamp(summary: SessionSummary): Long =
            summary.lastAssistantMessageAt ?: summary.updatedAt

        /** `sessionIsUnread`: activity newer than the operator's watermark. */
        fun isUnread(summary: SessionSummary, lastSeenAt: Long): Boolean =
            summary.assistantReplyClockBackfilled != false
                && seenTimestamp(summary) > lastSeenAt
    }
}
