import Foundation
import HapiProtocol
import Observation

/// Session-list sort key and Active first, app-wide over `UserDefaults` (web
/// keeps them in `localStorage`, `useSessionListView.ts`). Defaults are stored
/// as absent keys, so a changed default reaches users who never chose.
/// Row-hiding filters stay transient on the home model; only ordering
/// persists. `shared` keeps every window's list in step.
@MainActor @Observable
public final class SessionListOrderPrefs {
    public static let shared = SessionListOrderPrefs()

    public private(set) var order: SessionListOrder

    // `let` storage is inert under @Observable (no annotation needed).
    private let defaults: UserDefaults?

    public static let sortKey = "sessionList.sort"
    public static let activeFirstKey = "sessionList.activeFirst"

    /// `nil` defaults keep choices in memory only (previews and tests).
    public init(defaults: UserDefaults? = .standard) {
        self.defaults = defaults
        let sort = defaults?.string(forKey: Self.sortKey).flatMap(SessionListSort.init(rawValue:))
        let activeFirst = defaults.flatMap { defaults in
            defaults.object(forKey: Self.activeFirstKey) == nil ? nil : defaults.bool(forKey: Self.activeFirstKey)
        }
        self.order = SessionListOrder(
            sort: sort ?? SessionListOrder.default.sort,
            activeFirst: activeFirst ?? SessionListOrder.default.activeFirst
        )
    }

    public func setSort(_ sort: SessionListSort) {
        order.sort = sort
        if sort == SessionListOrder.default.sort {
            defaults?.removeObject(forKey: Self.sortKey)
        } else {
            defaults?.set(sort.rawValue, forKey: Self.sortKey)
        }
    }

    public func setActiveFirst(_ activeFirst: Bool) {
        order.activeFirst = activeFirst
        if activeFirst == SessionListOrder.default.activeFirst {
            defaults?.removeObject(forKey: Self.activeFirstKey)
        } else {
            defaults?.set(activeFirst, forKey: Self.activeFirstKey)
        }
    }

    public func reset() {
        setSort(SessionListOrder.default.sort)
        setActiveFirst(SessionListOrder.default.activeFirst)
    }
}
