import HapiClient
import SwiftUI

/// Post-pairing home: the session list for the active hub, with the hub
/// switcher (switch / add / settings / sign out), the "+" new-session sheet
/// (A-M3c), the Settings sheet (A-M4e), and the live global-SSE connection
/// dot in the toolbar. Tapping a row pushes the chat (M2f); a successful
/// spawn dismisses the sheet and pushes the new chat the same way.
struct HomeView: View {
    let session: HubSession

    @Environment(AppModel.self) private var model
    @State private var confirmSignOut = false
    @State private var showNewSession = false
    @State private var showSettings = false
    @State private var path: [String] = []

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                if let failedHub = model.authFailureNotice {
                    authFailureBanner(failedHub: failedHub)
                }
                SessionListView(session: session) { sessionId in
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
            .navigationTitle(HubDisplay.host(session.hubUrl))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    connectionIndicator
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNewSession = true
                    } label: {
                        Label("New Session", systemImage: "plus")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    hubMenu
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

    // MARK: - Connection state

    /// Shown only while the stream is NOT healthy: a steady "Live" chip was
    /// pure noise and read as a mystery non-button (device feedback). In the
    /// degraded states the dot + label explain themselves.
    private var connectionDegraded: Bool {
        if case .connected = session.connectionState { return false }
        return true
    }

    @ViewBuilder
    private var connectionIndicator: some View {
        if connectionDegraded {
            HStack(spacing: 6) {
                Circle()
                    .fill(connectionColor)
                    .frame(width: 8, height: 8)
                Text(connectionLabel)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Connection: \(connectionLabel)")
        }
    }

    private var connectionColor: Color {
        switch session.connectionState {
        case .connected: .green
        case .connecting, .backoff: .orange
        case .idle, .suspended: .gray
        }
    }

    private var connectionLabel: String {
        switch session.connectionState {
        case .connected: String(localized: "Live")
        case .connecting: String(localized: "Connecting…")
        case .backoff: String(localized: "Reconnecting…")
        case .suspended: String(localized: "Paused")
        case .idle: String(localized: "Offline")
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
