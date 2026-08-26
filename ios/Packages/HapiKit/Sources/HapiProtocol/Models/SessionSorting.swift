import Foundation

/// The session-list order — exact port of `sortSessionSummaries`
/// (`web/src/hooks/useSSE.ts`; also stated in
/// `docs/api/client-contract/sse.md#keep-alive-noise`):
///
/// 1. `globalPinned` first (nil-safe: absent counts as false);
/// 2. then `pinned`;
/// 3. then `active`;
/// 4. among sessions with equal `active` **when both are active**:
///    `pendingRequestsCount` descending (the reference's `left.active && …`
///    guard — inactive ties skip straight to recency);
/// 5. finally `updatedAt` descending.
///
/// Returns true only when `left` must sort strictly before `right`, so it is
/// a valid strict-weak-ordering predicate for `sorted(by:)`.
public func sessionSummaryPrecedes(_ left: SessionSummary, _ right: SessionSummary) -> Bool {
    let leftGlobal = left.globalPinned == true
    let rightGlobal = right.globalPinned == true
    if leftGlobal != rightGlobal {
        return leftGlobal
    }
    let leftPinned = left.pinned == true
    let rightPinned = right.pinned == true
    if leftPinned != rightPinned {
        return leftPinned
    }
    if left.active != right.active {
        return left.active
    }
    if left.active && left.pendingRequestsCount != right.pendingRequestsCount {
        return left.pendingRequestsCount > right.pendingRequestsCount
    }
    return left.updatedAt > right.updatedAt
}

/// Sort of a whole list with ``sessionSummaryPrecedes(_:_:)``.
///
/// Ties keep their prior relative order: JS `Array.prototype.sort` and
/// Swift's `sorted(by:)` (guaranteed since Swift 5) are both stable.
public func sortSessionSummaries(_ sessions: [SessionSummary]) -> [SessionSummary] {
    sessions.sorted(by: sessionSummaryPrecedes)
}
