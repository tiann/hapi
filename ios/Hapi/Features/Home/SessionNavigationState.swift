import Observation
import SwiftUI

/// In-memory navigation for one hub's iPad workspace. Window geometry never
/// owns selection: filtering, collapsing and reopening the sidebar must not
/// discard the selected chat or its nested file/process navigation.
@MainActor @Observable
final class SessionNavigationState {
    private(set) var selectedSessionId: String?
    var detailPath = NavigationPath()
    var columnVisibility: NavigationSplitViewVisibility = .all
    var preferredCompactColumn: NavigationSplitViewColumn = .sidebar

    func open(_ sessionId: String) {
        if selectedSessionId != sessionId {
            detailPath = NavigationPath()
            selectedSessionId = sessionId
        }
        // Also works for notifications/new sessions not yet in the list.
        preferredCompactColumn = .detail
    }

    func supersede(_ sessionId: String, with replacement: String) {
        guard selectedSessionId == sessionId else { return }
        open(replacement)
    }

    func remove(_ sessionId: String) {
        guard selectedSessionId == sessionId else { return }
        detailPath = NavigationPath()
        selectedSessionId = nil
        preferredCompactColumn = .sidebar
    }
}
