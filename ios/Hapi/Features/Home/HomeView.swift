import HapiClient
import SwiftUI
import UIKit

/// Post-pairing home: the session list for the active hub, with the hub
/// switcher (switch / add / settings / sign out), the "+" new-session sheet
/// (A-M3c), the Settings sheet (A-M4e), and a unified session-filter menu.
/// Degraded connections appear below navigation, not among its actions.
/// iPhone pushes the chat; iPad and foldable iPhones select a stable detail in
/// a native split that collapses to a stack when the window is compact.
/// Spawn, notification and row selection share the same opening path.
struct HomeView: View {
    let session: HubSession

    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var listModel: SessionListModel
    @State private var confirmSignOut = false
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

    /// iPhone Duo outer screen: hub, filter and new session live in the
    /// system's vertical bar, leaving the top bar to the title alone.
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
            ToolbarItem(placement: .topBarLeading) { hubMenu }
            if listModel.showsFilterMenu {
                // Beside the hub menu when the system sidebar toggle shares
                // the trailing edge, so the three icons do not bunch up.
                ToolbarItem(placement: showsSideBySide ? .topBarLeading : .topBarTrailing) {
                    SessionFilterMenu(model: listModel)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNewSession = true } label: {
                    Label("New Session", systemImage: "plus")
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityIdentifier("home.new-session")
            }
        }
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

    // MARK: - Hub switcher

    private var hubMenu: some View {
        Menu {
            Section("Hubs") {
                ForEach(model.hubs, id: \.self) { hub in
                    Button {
                        model.switchHub(to: hub)
                    } label: {
                        if hub == session.hubUrl {
                            Label(HubDisplay.host(hub), systemImage: "checkmark")
                        } else {
                            Text(HubDisplay.host(hub))
                        }
                    }
                }
            }
            Button {
                model.showAddHub = true
            } label: {
                Label("Add Hub…", systemImage: "plus")
            }
            Divider()
            Button {
                showSettings = true
            } label: {
                Label("Settings", systemImage: "gearshape")
            }
            Button(role: .destructive) {
                confirmSignOut = true
            } label: {
                Label("Sign Out…", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } label: {
            Label("Hubs", systemImage: "server.rack")
                .frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityValue(HubDisplay.host(session.hubUrl))
        .accessibilityIdentifier("home.hubs")
        .confirmationDialog(
            "Sign out of \(HubDisplay.host(session.hubUrl))?",
            isPresented: $confirmSignOut,
            titleVisibility: .visible
        ) {
            Button("Sign Out", role: .destructive) { model.signOut(hub: session.hubUrl) }
        } message: {
            Text("Removes the stored access token for this hub. Pair again to reconnect.")
        }
    }

    private func authFailureBanner(failedHub: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text("\(HubDisplay.host(failedHub)) rejected its stored credentials and was signed out. Pair it again from the hub menu.")
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

/// A side-by-side sidebar's bar already holds hub, filter, new session and the
/// system sidebar toggle; at 320pt the inline "Sessions" title only got a
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
