import HapiClient
import SwiftUI
import UIKit

/// Passkeys of the active hub's namespace (`GET /api/passkeys`): add one for
/// the shared Web/App RP `auth.hapi.run`, or delete a credential.
@MainActor @Observable
final class PasskeysModel {
    enum LoadState: Equatable {
        case loading
        case loaded
        /// The hub predates passkeys (`404` on the list endpoint).
        case unsupported
        case failed(String?)
    }

    private(set) var passkeys: [PasskeySummary] = []
    private(set) var loadState: LoadState = .loading
    private(set) var isAdding = false
    private(set) var deletingIds: Set<String> = []
    /// Last add/delete failure, shown as an alert.
    var actionError: String?

    private let api: APIClient
    private let authenticator: any PasskeyAuthenticating

    init(api: APIClient, authenticator: any PasskeyAuthenticating = PlatformPasskeyAuthenticator()) {
        self.api = api
        self.authenticator = authenticator
    }

    /// Default name for a new passkey: the device name (`iPhone`, `iPad`,
    /// the Mac's name on Catalyst).
    static var defaultPasskeyName: String {
        let name = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? UIDevice.current.model : name
    }

    func load() async {
        do {
            passkeys = try await api.listPasskeys()
            loadState = .loaded
        } catch is CancellationError {
            // View went away mid-flight.
        } catch let error as APIError where error.status == 404 {
            loadState = .unsupported
        } catch {
            if loadState != .loaded {
                loadState = .failed(error.localizedDescription)
            }
        }
    }

    func add(name: String) async {
        guard !isAdding else { return }
        isAdding = true
        defer { isAdding = false }
        do {
            try await api.registerPasskey(name: name, using: authenticator)
            await load()
        } catch PasskeyError.canceled {
            // Dismissed the system sheet: nothing to report.
        } catch {
            actionError = Self.message(forAddError: error)
        }
    }

    func delete(_ passkey: PasskeySummary) async {
        guard !deletingIds.contains(passkey.id) else { return }
        deletingIds.insert(passkey.id)
        defer { deletingIds.remove(passkey.id) }
        do {
            try await api.deletePasskey(id: passkey.id)
            passkeys.removeAll { $0.id == passkey.id }
        } catch let error as APIError where error.status == 404 {
            // Already gone (deleted elsewhere).
            passkeys.removeAll { $0.id == passkey.id }
        } catch {
            actionError = String(
                format: String(localized: "Could not delete the passkey: %@"),
                error.localizedDescription
            )
        }
    }

    private static func message(forAddError error: Error) -> String {
        switch error {
        case PasskeyError.relyingPartyMismatch(let rpId):
            return String(
                format: String(localized: "The hub requested a passkey for “%@”, but this app only supports auth.hapi.run. Update the hub."),
                rpId
            )
        case PasskeyError.platform(let detail):
            return String(
                format: String(localized: "This device could not create the passkey: %@"),
                detail
            )
        case let apiError as APIError where apiError.status == 409:
            return String(localized: "This passkey is already registered with the hub.")
        case let apiError as APIError:
            return String(
                format: String(localized: "The hub could not register the passkey (HTTP %lld)."),
                Int64(apiError.status)
            )
        default:
            return String(
                format: String(localized: "Could not add the passkey: %@"),
                error.localizedDescription
            )
        }
    }
}

/// Settings → Passkeys for the active hub.
struct PasskeysView: View {
    @State private var model: PasskeysModel
    @State private var showNamePrompt = false
    @State private var newName = ""
    @State private var pendingDelete: PasskeySummary?

    private let hubUrl: String

    init(session: HubSession) {
        _model = State(initialValue: PasskeysModel(api: session.api))
        hubUrl = session.hubUrl
    }

    var body: some View {
        List {
            content
        }
        .navigationTitle("Passkeys")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .refreshable { await model.load() }
        .alert("Name this passkey", isPresented: $showNamePrompt) {
            TextField("Passkey name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Continue") {
                let name = newName
                Task { await model.add(name: name) }
            }
        } message: {
            Text("Shown in the hub's passkey list so you can tell your devices apart.")
        }
        .confirmationDialog(
            deleteTitle,
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { passkey in
            Button("Delete Passkey", role: .destructive) {
                Task { await model.delete(passkey) }
            }
        } message: { _ in
            Text("Devices signed in with this passkey are signed out of the hub. The passkey itself stays in your password manager until you remove it there.")
        }
        .alert(
            "Passkey",
            isPresented: Binding(
                get: { model.actionError != nil },
                set: { if !$0 { model.actionError = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.actionError ?? "")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.loadState {
        case .loading:
            Section {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
            }
        case .unsupported:
            Section {
                Text("This hub does not support passkeys. Update the hub to use them.")
                    .foregroundStyle(.secondary)
            }
        case .failed(let message):
            Section {
                DashboardErrorView(isForbidden: false, message: message) {
                    Task { await model.load() }
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
        case .loaded:
            loadedSections
        }
    }

    @ViewBuilder
    private var loadedSections: some View {
        Section {
            if model.passkeys.isEmpty {
                Text("No passkeys yet.")
                    .foregroundStyle(.secondary)
            }
            ForEach(model.passkeys) { passkey in
                PasskeyRow(passkey: passkey, isDeleting: model.deletingIds.contains(passkey.id))
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button("Delete", role: .destructive) {
                            pendingDelete = passkey
                        }
                    }
                    .contextMenu {
                        Button("Delete Passkey…", systemImage: "trash", role: .destructive) {
                            pendingDelete = passkey
                        }
                    }
            }
        } footer: {
            Text("Sign in to \(HubDisplay.host(hubUrl)) from another device with “Sign in with a Passkey” — no access token needed. Passkeys work in both the web app and this app.")
        }

        Section {
            Button {
                newName = PasskeysModel.defaultPasskeyName
                showNamePrompt = true
            } label: {
                if model.isAdding {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Adding passkey…")
                    }
                } else {
                    Label("Add Passkey", systemImage: "plus")
                }
            }
            .disabled(model.isAdding)
            .accessibilityIdentifier("passkeys.add")
        }
    }

    private var deleteTitle: String {
        guard let pendingDelete else { return "" }
        return String(
            format: String(localized: "Delete “%@”?"),
            PasskeyRow.displayName(pendingDelete)
        )
    }
}

private struct PasskeyRow: View {
    let passkey: PasskeySummary
    let isDeleting: Bool

    static func displayName(_ passkey: PasskeySummary) -> String {
        if let name = passkey.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
            return name
        }
        return String(localized: "Unnamed passkey")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "person.badge.key")
                .foregroundStyle(passkey.valid ? Color.accentColor : Color.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(Self.displayName(passkey))
                        .foregroundStyle(passkey.valid ? Color.primary : Color.secondary)
                    if !passkey.valid {
                        badge(Text("Revoked"), color: .orange)
                    }
                }
                Text("Created \(passkey.createdDate, format: .dateTime.year().month().day())")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let lastUsed = passkey.lastUsedDate {
                    Text("Last used \(lastUsed, format: .relative(presentation: .named))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Never used")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if !passkey.valid {
                    Text("Registered before the hub's access token was rotated; it can no longer sign in.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            Spacer(minLength: 0)
            if isDeleting {
                ProgressView()
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func badge(_ label: Text, color: Color) -> some View {
        label
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: Capsule())
    }
}
