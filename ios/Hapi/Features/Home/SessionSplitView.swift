import SwiftUI

/// Keep the same split/stack hierarchy across size-class changes. SwiftUI
/// moves the detail controller when collapsing instead of creating a second
/// ChatView (and a second interactor/SSE subscription).
struct SessionSplitView<Sidebar: View, Detail: View>: View {
    let navigation: SessionNavigationState
    let onNewSession: () -> Void
    @ViewBuilder var sidebar: () -> Sidebar
    @ViewBuilder var detail: (String) -> Detail

    var body: some View {
        @Bindable var navigation = navigation
        NavigationSplitView(
            columnVisibility: $navigation.columnVisibility,
            preferredCompactColumn: $navigation.preferredCompactColumn
        ) {
            sidebar()
                .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 360)
        } detail: {
            NavigationStack(path: $navigation.detailPath) {
                if let sessionId = navigation.selectedSessionId {
                    detail(sessionId)
                } else {
                    ContentUnavailableView {
                        Label("Select a session", systemImage: "bubble.left.and.bubble.right")
                    } description: {
                        Text("Choose a session from the sidebar, or start a new one.")
                    } actions: {
                        Button("New Session", action: onNewSession)
                            .buttonStyle(.borderedProminent)
                    }
                    .accessibilityIdentifier("home.no-selection")
                }
            }
            // Switching sessions clears *all* destinations, including the
            // existing Boolean/item-based file and tool presentations.
            // No width, size class or column visibility participates in ID.
            .id(navigation.selectedSessionId)
        }
        .navigationSplitViewStyle(.balanced)
    }
}
