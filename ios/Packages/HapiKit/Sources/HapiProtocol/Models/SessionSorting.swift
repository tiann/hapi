import Foundation

/// User activity only: output, permissions and liveness never change this key.
public func sessionOrderPrecedes(_ left: SessionSummary, _ right: SessionSummary) -> Bool {
    let leftAt = left.lastUserMessageAt ?? left.createdAt ?? 0
    let rightAt = right.lastUserMessageAt ?? right.createdAt ?? 0
    if leftAt != rightAt { return leftAt > rightAt }
    if (left.createdAt ?? 0) != (right.createdAt ?? 0) { return (left.createdAt ?? 0) > (right.createdAt ?? 0) }
    return left.id < right.id
}

/// Mirrors `compareSessionSummaries` in shared/src/sessionOrder.ts.
public func sessionSummaryPrecedes(_ left: SessionSummary, _ right: SessionSummary) -> Bool {
    if (left.globalPinned == true) != (right.globalPinned == true) { return left.globalPinned == true }
    if (left.pinned == true) != (right.pinned == true) { return left.pinned == true }
    return sessionOrderPrecedes(left, right)
}

public func sortSessionSummaries(_ sessions: [SessionSummary]) -> [SessionSummary] {
    sessions.sorted(by: sessionSummaryPrecedes)
}
