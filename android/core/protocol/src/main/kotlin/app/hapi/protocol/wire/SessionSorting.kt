package app.hapi.protocol.wire

/**
 * The session-list order — exact port of `sortSessionSummaries`
 * (`web/src/hooks/useSSE.ts`; also stated in
 * `docs/api/client-contract/sse.md#keep-alive-noise`):
 *
 * 1. `globalPinned` first (null-safe: absent counts as false);
 * 2. then `pinned`;
 * 3. then `active`;
 * 4. among sessions with equal `active` **when both are active**:
 *    `pendingRequestsCount` descending (the reference's
 *    `left.active && …` guard — inactive ties skip straight to recency);
 * 5. finally `updatedAt` descending.
 *
 * Ties keep their prior relative order: JS `Array.prototype.sort` and
 * Kotlin's `sortedWith` are both stable.
 */
val SessionSummaryComparator: Comparator<SessionSummary> = Comparator { left, right ->
    val leftGlobal = left.globalPinned == true
    val rightGlobal = right.globalPinned == true
    if (leftGlobal != rightGlobal) {
        return@Comparator if (leftGlobal) -1 else 1
    }
    val leftPinned = left.pinned == true
    val rightPinned = right.pinned == true
    if (leftPinned != rightPinned) {
        return@Comparator if (leftPinned) -1 else 1
    }
    if (left.active != right.active) {
        return@Comparator if (left.active) -1 else 1
    }
    if (left.active && left.pendingRequestsCount != right.pendingRequestsCount) {
        return@Comparator right.pendingRequestsCount - left.pendingRequestsCount
    }
    right.updatedAt.compareTo(left.updatedAt)
}

/** Stable sort of a whole list with [SessionSummaryComparator]. */
fun sortSessionSummaries(sessions: List<SessionSummary>): List<SessionSummary> =
    sessions.sortedWith(SessionSummaryComparator)
