package app.hapi.protocol.window

import kotlinx.serialization.Serializable

/**
 * State machine model for one session's message window — the faithful port of
 * the web reference `web/src/lib/message-window-store.ts` (its
 * `InternalState`), per `docs/api/client-contract/pagination.md`. The pure
 * transitions over this state live in [MessageWindowLogic]; the async
 * orchestration (`:core:data` `MessageWindowStore`) drives them.
 */

/** Windowing constants — normative, from the web reference. */
const val VISIBLE_WINDOW_SIZE: Int = 400
const val HISTORY_WINDOW_SIZE: Int = 600
const val OLDER_LOAD_WINDOW_SIZE: Int = 800
const val AGENT_RUN_WINDOW_SIZE: Int = 800
const val PAGE_SIZE: Int = 200

enum class MessageViewMode(val wire: String) {
    /** Following the live bottom; trims from the top. */
    Tail("tail"),

    /** Scrolled back; trims from the bottom and may force a latest reset. */
    History("history"),
}

/**
 * Compound paging position `(at, seq)` where `at = invokedAt ?? createdAt` —
 * both halves always travel together (`pagination.md` "Position key").
 */
data class MessagePosition(val at: Long, val seq: Long) : Comparable<MessagePosition> {
    override fun compareTo(other: MessagePosition): Int =
        if (at != other.at) at.compareTo(other.at) else seq.compareTo(other.seq)
}

/** Outcome of one older-page load (`fetchOlderMessages` in the web). */
sealed interface OlderLoadOutcome {
    data class Applied(
        val historyVersion: Long,
        val hasMore: Boolean,
        val addedRenderableCount: Int,
    ) : OlderLoadOutcome

    data class Stopped(val reason: StopReason) : OlderLoadOutcome

    data class Failed(val error: Throwable) : OlderLoadOutcome

    enum class StopReason(val wire: String) {
        Unavailable("unavailable"),
        Busy("busy"),
        Invalidated("invalidated"),
        EpochReset("epoch-reset"),
        Exhausted("exhausted"),
    }
}

/**
 * The full window state. Field-for-field port of the web `InternalState`
 * (public `MessageWindowState` + internal cursor/generation fields), with the
 * two `(at, seq)` half-pairs folded into nullable [MessagePosition]s — the web
 * only ever reads/writes them pairwise (`readPosition`).
 */
data class MessageWindowState(
    val sessionId: String,
    /** Window rows in position order (queued rows re-merged after each trim). */
    val messages: List<WindowMessage> = emptyList(),
    /** Older history exists (server flag, or rows were trimmed away). */
    val hasMore: Boolean = false,
    /** min/max `seq` over [messages] — derived, kept for UI parity. */
    val oldestSeq: Long? = null,
    val newestSeq: Long? = null,
    /** Cached server epoch; null until the first page (or after invalidation). */
    val epoch: Long? = null,
    val isSyncingTail: Boolean = false,
    val isLoadingMore: Boolean = false,
    val warning: String? = null,
    val viewMode: MessageViewMode = MessageViewMode.Tail,
    /** Bumped whenever the [messages] list instance changes. */
    val messagesVersion: Long = 0,
    /** Bumped per applied older page (scroll-anchoring handle). */
    val historyVersion: Long = 0,
    /** Bumped on tail-side content changes (auto-scroll handle). */
    val tailRevision: Long = 0,
    /** Next `before` request position (web `oldestPositionAt/Seq`). */
    val oldestPosition: MessagePosition? = null,
    /** Next `after` request position (web `newestPositionAt/Seq`). */
    val newestPosition: MessagePosition? = null,
    /** Cursors are unusable — the next tail sync must fetch a fresh latest page. */
    val requiresLatestReset: Boolean = false,
    /** Re-activation with persisted state: fetch the current tail first. */
    val preferLatestOnActivation: Boolean = false,
    /** Invalidates in-flight tail syncs (compare-and-ignore). */
    val syncGeneration: Long = 0,
    /** Invalidates in-flight older-page loads. */
    val olderGeneration: Long = 0,
)

/**
 * Snapshot shape persisted per session (web `PersistedMessageWindowState`,
 * storage key `hapi:message-window:v2:`): messages + cursors + epoch only —
 * transient flags and counters never survive a restart.
 */
@Serializable
data class PersistedMessageWindow(
    val messages: List<WindowMessage> = emptyList(),
    val hasMore: Boolean = false,
    val oldestPositionAt: Long? = null,
    val oldestPositionSeq: Long? = null,
    val newestPositionAt: Long? = null,
    val newestPositionSeq: Long? = null,
    val epoch: Long? = null,
)
