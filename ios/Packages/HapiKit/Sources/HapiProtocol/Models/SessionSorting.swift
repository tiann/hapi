import Foundation

/// Session-list sort key (web `SessionListSort`, `web/src/hooks/useSessionListView.ts`).
public enum SessionListSort: String, CaseIterable, Sendable {
    /// The user's latest prompt, falling back to creation. Agent output never
    /// moves this key.
    case lastMessage = "last-message"
    /// Newest sessions first.
    case created
}

/// Session-list ordering choices: a sort key and whether connected sessions
/// lead each pin tier (web `SessionListView.sort` / `.activeFirst`).
public struct SessionListOrder: Equatable, Hashable, Sendable {
    public var sort: SessionListSort
    public var activeFirst: Bool

    public init(sort: SessionListSort = .lastMessage, activeFirst: Bool = true) {
        self.sort = sort
        self.activeFirst = activeFirst
    }

    /// The list default (web `DEFAULT_SESSION_LIST_VIEW`).
    public static let `default` = SessionListOrder()
    /// The base order every store keeps: user input only, no liveness.
    public static let base = SessionListOrder(sort: .lastMessage, activeFirst: false)

    public var isDefault: Bool { self == .default }
}

/// Mirrors web `getSessionSortKey` (`web/src/lib/sessionListOrder.ts`).
public func sessionSortKey(_ session: SessionSummary, sort: SessionListSort) -> Int {
    switch sort {
    case .created: return session.createdAt ?? 0
    case .lastMessage: return session.lastUserMessageAt ?? session.createdAt ?? 0
    }
}

/// User activity only: output, permissions and liveness never change this key.
public func sessionOrderPrecedes(_ left: SessionSummary, _ right: SessionSummary) -> Bool {
    sessionOrderPrecedes(left, right, sort: .lastMessage)
}

/// The chosen key descending, then creation descending, then id.
public func sessionOrderPrecedes(_ left: SessionSummary, _ right: SessionSummary, sort: SessionListSort) -> Bool {
    let leftAt = sessionSortKey(left, sort: sort)
    let rightAt = sessionSortKey(right, sort: sort)
    if leftAt != rightAt { return leftAt > rightAt }
    if (left.createdAt ?? 0) != (right.createdAt ?? 0) { return (left.createdAt ?? 0) > (right.createdAt ?? 0) }
    return left.id < right.id
}

/// Global pins, project pins, then (with `activeFirst`) connected sessions,
/// then the sort key. Web `createSessionComparator` under the flat native
/// list's pin tiers: manual pins still come first.
public func sessionSummaryPrecedes(_ left: SessionSummary, _ right: SessionSummary, order: SessionListOrder) -> Bool {
    if (left.globalPinned == true) != (right.globalPinned == true) { return left.globalPinned == true }
    if (left.pinned == true) != (right.pinned == true) { return left.pinned == true }
    if order.activeFirst && left.active != right.active { return left.active }
    return sessionOrderPrecedes(left, right, sort: order.sort)
}

/// Mirrors `compareSessionSummaries` in shared/src/sessionOrder.ts.
public func sessionSummaryPrecedes(_ left: SessionSummary, _ right: SessionSummary) -> Bool {
    sessionSummaryPrecedes(left, right, order: .base)
}

public func sortSessionSummaries(_ sessions: [SessionSummary]) -> [SessionSummary] {
    sessions.sorted(by: sessionSummaryPrecedes)
}

public func sortSessionSummaries(_ sessions: [SessionSummary], order: SessionListOrder) -> [SessionSummary] {
    sessions.sorted { sessionSummaryPrecedes($0, $1, order: order) }
}
