package app.hapi.protocol.wire

/** Session-list sort key (web `SessionListSort`, `web/src/hooks/useSessionListView.ts`). */
enum class SessionListSort(val storageKey: String) {
    /** The user's latest prompt, falling back to creation. Agent output never moves it. */
    LastMessage("last-message"),

    /** Newest sessions first. */
    Created("created");

    companion object {
        /** Unknown/corrupt stored values (e.g. web's dropped "activity") degrade to [LastMessage]. */
        fun fromStorageKey(raw: String?): SessionListSort = entries.firstOrNull { it.storageKey == raw } ?: LastMessage
    }
}

/**
 * Session-list ordering choices: a sort key and whether connected sessions
 * lead each pin tier (web `SessionListView.sort` / `.activeFirst`).
 */
data class SessionListOrder(
    val sort: SessionListSort = SessionListSort.LastMessage,
    val activeFirst: Boolean = true,
) {
    val isDefault: Boolean get() = this == Default

    companion object {
        /** The list default (web `DEFAULT_SESSION_LIST_VIEW`). */
        val Default = SessionListOrder()

        /** The base order every store keeps: user input only, no liveness. */
        val Base = SessionListOrder(SessionListSort.LastMessage, activeFirst = false)
    }
}

/** Mirrors web `getSessionSortKey` (`web/src/lib/sessionListOrder.ts`). */
fun sessionSortKey(session: SessionSummary, sort: SessionListSort): Long = when (sort) {
    SessionListSort.Created -> session.createdAt ?: 0L
    SessionListSort.LastMessage -> session.lastUserMessageAt ?: session.createdAt ?: 0L
}

/** The chosen key descending, then creation descending, then id. */
fun sessionOrderComparator(sort: SessionListSort): Comparator<SessionSummary> =
    compareByDescending<SessionSummary> { sessionSortKey(it, sort) }
        .thenByDescending { it.createdAt ?: 0L }
        .thenBy { it.id }

/**
 * Global pins, project pins, then (with `activeFirst`) connected sessions,
 * then the sort key. Web `createSessionComparator` under the flat native
 * list's pin tiers: manual pins still come first.
 */
fun sessionSummaryComparator(order: SessionListOrder): Comparator<SessionSummary> {
    val pins = compareByDescending<SessionSummary> { it.globalPinned == true }
        .thenByDescending { it.pinned == true }
    val live = if (order.activeFirst) pins.thenByDescending { it.active } else pins
    return live.then(sessionOrderComparator(order.sort))
}

/** Mirrors shared/src/sessionOrder.ts. Output and liveness do not affect order. */
val SessionOrderComparator: Comparator<SessionSummary> = sessionOrderComparator(SessionListSort.LastMessage)

val SessionSummaryComparator: Comparator<SessionSummary> = sessionSummaryComparator(SessionListOrder.Base)

fun sortSessionSummaries(sessions: List<SessionSummary>): List<SessionSummary> =
    sessions.sortedWith(SessionSummaryComparator)

fun sortSessionSummaries(sessions: List<SessionSummary>, order: SessionListOrder): List<SessionSummary> =
    sessions.sortedWith(sessionSummaryComparator(order))
