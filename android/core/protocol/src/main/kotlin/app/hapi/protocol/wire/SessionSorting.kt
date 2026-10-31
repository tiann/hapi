package app.hapi.protocol.wire

/** Mirrors shared/src/sessionOrder.ts. Output and liveness do not affect order. */
val SessionOrderComparator: Comparator<SessionSummary> =
    compareByDescending<SessionSummary> { it.lastUserMessageAt ?: it.createdAt ?: 0L }
        .thenByDescending { it.createdAt ?: 0L }
        .thenBy { it.id }

val SessionSummaryComparator: Comparator<SessionSummary> =
    compareByDescending<SessionSummary> { it.globalPinned == true }
        .thenByDescending { it.pinned == true }
        .then(SessionOrderComparator)

fun sortSessionSummaries(sessions: List<SessionSummary>): List<SessionSummary> =
    sessions.sortedWith(SessionSummaryComparator)
