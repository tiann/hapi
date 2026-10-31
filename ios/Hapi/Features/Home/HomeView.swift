import HapiClient
import SwiftUI
import UIKit

/// Post-pairing home: the session list for the active hub, with the "+"
/// new-session sheet (A-M3c), the Settings sheet (A-M4e, which also switches,
/// adds and signs out of hubs), and a unified session-filter menu.
/// Degraded connections appear below navigation, not among its actions.
/// iPhone pushes the chat; iPad and foldable iPhones select a stable detail in
/// a native split that collapses to a stack when the window is compact.
/// Spawn, notification and row selection share the same opening path.
struct HomeView: View {
    let session: HubSession

    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var listModel: SessionListModel
    @State private var showNewSession = false
    @State private var showSettings = false
    @State private var path: [String] = []
    @State private var tabletNavigation = SessionNavigationState()

    private var usesSplitNavigation: Bool {
        UIDevice.current.userInterfaceIdiom == .pad || FoldableDevice.shared.hasHinge
    }

    /// The sidebar is visible next to the chat (not collapsed into a stack).
    private var showsSideBySide: Bool {
        usesSplitNavigation && horizontalSizeClass == .regular
    }

    /// iPhone Duo outer screen: the system moves toolbar actions into its
    /// vertical bar, leaving the top bar to the title alone.
    private var isFoldedOuterScreen: Bool {
        FoldableDevice.shared.hasHinge && horizontalSizeClass == .compact
    }

    init(session: HubSession) {
        self.session = session
        _listModel = State(initialValue: SessionListModel(session: session))
    }

    var body: some View {
        @Bindable var model = model
        Group {
            if usesSplitNavigation {
                SessionSplitView(navigation: tabletNavigation, onNewSession: { showNewSession = true }) {
                    sessionList
                } detail: { sessionId in
                    chat(sessionId)
                }
            } else {
                NavigationStack(path: $path) {
                    sessionList
                        .navigationDestination(for: String.self) { sessionId in
                            chat(sessionId)
                        }
                }
            }
        }
        .background(HingeProbe())
        // The hinge is reported after the first render; carry a chat that was
        // already pushed (e.g. a cold-start notification) into the split.
        .onChange(of: usesSplitNavigation) { _, split in
            guard split else { return }
            if let sessionId = path.last { openSession(sessionId) }
            path = []
        }
        // Notification tap (P3): consume the pending target into this hub's
        // navigation path. `initial: true` covers a tap that cold-started
        // the app before this view existed.
        .onChange(of: model.pendingOpenSessionId, initial: true) { _, sessionId in
            guard let sessionId else { return }
            model.pendingOpenSessionId = nil
            openSession(sessionId)
        }
        .onChange(of: session.sessionRemoval) { _, removal in
            guard let removal else { return }
            if usesSplitNavigation {
                tabletNavigation.remove(removal.sessionId)
            } else if let index = path.firstIndex(of: removal.sessionId) {
                // Deleted or archived elsewhere: leave the emptied chat.
                path.removeSubrange(index...)
            }
        }
        .sheet(isPresented: $model.showAddHub) {
            PairingFlowView(context: .addHub)
        }
        .sheet(isPresented: $showNewSession) {
            NewSessionView(session: session) { sessionId in
                // Navigate-replace: drop the sheet, push the fresh chat.
                showNewSession = false
                openSession(sessionId)
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(session: session)
        }
    }

    private var sessionList: some View {
        VStack(spacing: 0) {
            if let failedHub = model.authFailureNotice {
                authFailureBanner(failedHub: failedHub)
            }
            SessionConnectionNotice(
                state: session.connectionState,
                showsCachedSessions: listModel.isOffline && listModel.hasLoaded
            )
            SessionListView(model: listModel, selection: usesSplitNavigation ? Binding(
                get: { tabletNavigation.selectedSessionId },
                // Native list deselection (e.g. a filter hides the row) is
                // not an authoritative removal and must not close the chat.
                set: { if let id = $0 { openSession(id) } }
            ) : nil, onOpenSession: openSession)
        }
        .searchable(text: $listModel.searchQuery, prompt: Text("Search sessions"))
        .onChange(of: tabletNavigation.selectedSessionId, initial: true) { _, sessionId in
            listModel.selectedSessionId = sessionId
        }
        .navigationTitle("Sessions")
        .navigationBarTitleDisplayMode(.inline)
        .modifier(SidebarTitleRemoval(isSidebar: showsSideBySide || isFoldedOuterScreen))
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { settingsButton }
            if listModel.showsFilterMenu {
                // Beside Settings when the system sidebar toggle shares the
                // trailing edge, so the icons do not bunch up.
                ToolbarItem(placement: showsSideBySide ? .topBarLeading : .topBarTrailing) {
                    SessionFilterMenu(model: listModel)
                }
            }
            if !showsNewSessionBesideSearch {
                ToolbarItem(placement: .topBarTrailing) { newSessionButton }
            }
        }
        .modifier(NewSessionBesideSearch(isEnabled: showsNewSessionBesideSearch) { newSessionButton })
    }

    /// iOS 26 bottom search bar, as in Messages: New Session sits beside the
    /// field. A side-by-side sidebar keeps search at its top, and older
    /// systems keep search under the title.
    private var showsNewSessionBesideSearch: Bool {
        guard #available(iOS 26.0, *) else { return false }
        return !showsSideBySide
    }

    private var newSessionButton: some View {
        Button { showNewSession = true } label: {
            Label("New Session", systemImage: "plus")
                .frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityIdentifier("home.new-session")
    }

    private var settingsButton: some View {
        Button { showSettings = true } label: {
            Label("Settings", systemImage: "gearshape")
                .frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityIdentifier("home.settings")
    }

    private func openSession(_ sessionId: String) {
        if usesSplitNavigation {
            listModel.onSessionOpened(sessionId)
            tabletNavigation.open(sessionId)
        } else if path.last != sessionId {
            path.append(sessionId)
        }
    }

    private func chat(_ sessionId: String) -> some View {
        ChatView(session: session, sessionId: sessionId) { superseding in
            if usesSplitNavigation {
                tabletNavigation.supersede(sessionId, with: superseding)
            } else if let last = path.indices.last, path[last] == sessionId {
                path[last] = superseding
            }
            // A late response from a chat already left must not steal focus.
        }
        .id(sessionId)
    }

    private func authFailureBanner(failedHub: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text("\(HubDisplay.host(failedHub)) rejected its stored credentials and was signed out. Pair it again from Settings.")
                .font(.footnote)
            Spacer(minLength: 0)
            Button {
                model.authFailureNotice = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.footnote.bold())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }
}

/// A side-by-side sidebar's bar already holds settings, filter, new session and
/// the system sidebar toggle; at 320pt the inline "Sessions" title only got a
/// truncated sliver. The title stays set for VoiceOver and collapsed stacks.
private struct SidebarTitleRemoval: ViewModifier {
    let isSidebar: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.toolbar(removing: isSidebar ? .title : nil)
        } else {
            content
        }
    }
}

/// Places the system search field in the bottom bar with New Session on its
/// trailing side. The OS branch is static and the toggle lives inside the
/// toolbar, so resizing never replaces the session list's identity.
private struct NewSessionBesideSearch<NewSessionButton: View>: ViewModifier {
    let isEnabled: Bool
    @ViewBuilder var newSessionButton: () -> NewSessionButton

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.toolbar {
                if isEnabled {
                    DefaultToolbarItem(kind: .search, placement: .bottomBar)
                    ToolbarSpacer(.fixed, placement: .bottomBar)
                    ToolbarItem(placement: .bottomBar) { newSessionButton() }
                }
            }
        } else {
            content
        }
    }
}

/// One status line; a failed list refresh takes precedence over SSE status.
struct SessionConnectionNotice: View {
    let state: SSEConnectionState
    let showsCachedSessions: Bool

    var message: String? {
        if showsCachedSessions { return String(localized: "Offline — showing cached sessions") }
        switch state {
        case .connected: return nil
        case .connecting: return String(localized: "Connecting…")
        case .backoff: return String(localized: "Reconnecting…")
        case .suspended: return String(localized: "Paused")
        case .idle: return String(localized: "Offline")
        }
    }

    var body: some View {
        if let message {
            Label(message, systemImage: "wifi.exclamationmark")
                .font(.footnote)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .background(.orange.opacity(0.15))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("home.connection-notice")
        }
    }
}
