import HapiClient
import SwiftUI

/// Post-pairing home: the session list for the active hub, with the hub
/// switcher (switch / add / settings / sign out), the "+" new-session sheet
/// (A-M3c), the Settings sheet (A-M4e), and a unified session-filter menu.
/// Degraded connections appear below navigation, not among its actions.
/// Tapping a row pushes the chat (M2f); a successful
/// spawn dismisses the sheet and pushes the new chat the same way.
struct HomeView: View {
    let session: HubSession

    @Environment(AppModel.self) private var model
    @State private var listModel: SessionListModel
    @State private var confirmSignOut = false
    @State private var showNewSession = false
    @State private var showSettings = false
    @State private var path: [String] = []

    init(session: HubSession) {
        self.session = session
        _listModel = State(initialValue: SessionListModel(session: session))
    }

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                if let failedHub = model.authFailureNotice {
                    authFailureBanner(failedHub: failedHub)
                }
                SessionConnectionNotice(
                    state: session.connectionState,
                    showsCachedSessions: listModel.isOffline && listModel.hasLoaded
                )
                SessionListView(model: listModel) { sessionId in
                    path.append(sessionId)
                }
            }
            .navigationDestination(for: String.self) { sessionId in
                ChatView(session: session, sessionId: sessionId) { superseding in
                    // Resume returned a different session id (A-M3a): replace
                    // the current chat entry so back still pops to the list.
                    if let last = path.indices.last, path[last] == sessionId {
                        path[last] = superseding
                    } else {
                        path.append(superseding)
                    }
                }
                // A replaced path element must rebuild the screen's @State.
                .id(sessionId)
            }
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    hubMenu
                }
                if listModel.showsFilterMenu {
                    ToolbarItem(placement: .topBarTrailing) {
                        SessionFilterMenu(model: listModel)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNewSession = true
                    } label: {
                        Label("New Session", systemImage: "plus")
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityIdentifier("home.new-session")
                }
            }
            .confirmationDialog(
                "Sign out of \(HubDisplay.host(session.hubUrl))?",
                isPresented: $confirmSignOut,
                titleVisibility: .visible
            ) {
                Button("Sign Out", role: .destructive) {
                    model.signOut(hub: session.hubUrl)
                }
            } message: {
                Text("Removes the stored access token for this hub. Pair again to reconnect.")
            }
        }
        // Notification tap (P3): consume the pending target into this hub's
        // navigation path. `initial: true` covers a tap that cold-started
        // the app before this view existed.
        .onChange(of: model.pendingOpenSessionId, initial: true) { _, sessionId in
            guard let sessionId else { return }
            model.pendingOpenSessionId = nil
            if path.last != sessionId {
                path.append(sessionId)
            }
        }
        .sheet(isPresented: $model.showAddHub) {
            PairingFlowView(context: .addHub)
        }
        .sheet(isPresented: $showNewSession) {
            NewSessionView(session: session) { sessionId in
                // Navigate-replace: drop the sheet, push the fresh chat.
                showNewSession = false
                path.append(sessionId)
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(session: session)
        }
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
