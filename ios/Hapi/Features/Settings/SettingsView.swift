import HapiClient
import HapiProtocol
import SwiftUI
import UIKit
import UserNotifications

/// Settings-home state (A-M4e): the owner gate for the usage/storage entries
/// and the About hub probe. Appearance/language live in their prefs stores;
/// this model only carries what needs async loading. Android reference:
/// `feature/settings/SettingsViewModel.kt`.
@MainActor @Observable
final class SettingsModel {
    enum HubInfoState {
        case loading
        case loaded(HubHealthResponse)
        case failed(String?)
    }

    /// True when the active hub's JWT namespace is `OwnerGate.ownerNamespace`.
    /// Starts false (fail closed) until the gate resolves.
    private(set) var isOwner = false
    private(set) var hubInfo: HubInfoState = .loading

    var hubUrl: String { session.hubUrl }

    private let session: HubSession
    private var started = false

    init(session: HubSession) {
        self.session = session
    }

    func start() {
        guard !started else { return }
        started = true
        Task { await self.loadOwnerGate() }
        Task { await self.loadHubInfo() }
    }

    func retryHubInfo() {
        hubInfo = .loading
        Task { await self.loadHubInfo() }
    }

    /// Reads the current JWT (loading the persisted one, refreshing when
    /// stale) and peeks its `ns` claim — the Android `currentJwt()` +
    /// `isOwnerNamespace` shape. Any failure leaves the gate closed.
    private func loadOwnerGate() async {
        let jwt = try? await session.authManager.validToken()
        isOwner = OwnerGate.isOwnerNamespace(jwt: jwt)
    }

    private func loadHubInfo() async {
        do {
            hubInfo = .loaded(try await session.api.health())
        } catch is CancellationError {
            // View dismissed mid-flight; nothing to show.
        } catch {
            hubInfo = .failed(error.localizedDescription)
        }
    }
}

/// Settings home (A-M4e), presented as a sheet off the home toolbar menu:
/// Appearance (theme mode), Language (persist-only until M5), the owner-only
/// Usage/Storage entries, and About (app/protocol versions + hub health).
struct SettingsView: View {
    @State private var model: SettingsModel
    @State private var languagePrefs: LanguagePrefs
    @Environment(ThemePrefs.self) private var themePrefs
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    private let session: HubSession

    init(session: HubSession) {
        _model = State(initialValue: SettingsModel(session: session))
        _languagePrefs = State(initialValue: LanguagePrefs())
        self.session = session
    }

    var body: some View {
        NavigationStack {
            List {
                appearanceSection
                languageSection
                notificationsSection
                if model.isOwner {
                    insightsSection
                }
                aboutSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
            .task {
                model.start()
                PushCoordinator.shared.refreshStatus()
            }
        }
        // The sheet is its own presentation; re-apply the explicit override
        // so it does not fall back to the system scheme.
        .preferredColorScheme(themePrefs.mode.preferredColorScheme)
    }

    // MARK: - Sections

    private var appearanceSection: some View {
        Section("Appearance") {
            Picker("Theme", selection: themeBinding) {
                ForEach(ThemeMode.allCases, id: \.self) { mode in
                    Text(mode.label).tag(mode)
                }
            }
        }
    }

    private var themeBinding: Binding<ThemeMode> {
        Binding(
            get: { themePrefs.mode },
            set: { themePrefs.setMode($0) }
        )
    }

    private var languageSection: some View {
        Section {
            Picker("App language", selection: languageBinding) {
                ForEach(AppLanguage.allCases, id: \.self) { language in
                    Text(Self.pickerLabel(for: language)).tag(language)
                }
            }
        } header: {
            Text("Language")
        } footer: {
            Text("Applies after the app is relaunched.")
        }
    }

    /// Explicit languages show their native names (package data); the
    /// follow-system row is UI copy localized here (the package stays
    /// language-free).
    private static func pickerLabel(for language: AppLanguage) -> String {
        language == .system ? String(localized: "Follow system") : language.displayName
    }

    /// SwiftUI has no supported in-place locale swap without replumbing every
    /// scene, so an explicit pick writes the standard `AppleLanguages`
    /// override (applied by the OS on next launch) and "Follow system"
    /// removes it — the footer says a relaunch is needed.
    private var languageBinding: Binding<AppLanguage> {
        Binding(
            get: { languagePrefs.language },
            set: { language in
                languagePrefs.setLanguage(language)
                switch language {
                case .system:
                    UserDefaults.standard.removeObject(forKey: "AppleLanguages")
                case .english:
                    UserDefaults.standard.set(["en"], forKey: "AppleLanguages")
                case .simplifiedChinese:
                    UserDefaults.standard.set(["zh-Hans"], forKey: "AppleLanguages")
                }
            }
        )
    }

    /// Push status (P3): permission state, how many paired hubs currently
    /// hold this install's device registration, and a manual re-register
    /// escape hatch (iOS has no background retry queue — the next app start
    /// or token rotation heals registrations too).
    private var notificationsSection: some View {
        let push = PushCoordinator.shared
        return Section {
            LabeledContent("Push notifications", value: permissionLabel(push.authorizationStatus))
            if push.authorizationStatus == .denied {
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        openURL(url)
                    }
                } label: {
                    Text("Enable in system settings…")
                        .font(.callout)
                }
            } else {
                LabeledContent(
                    "Registered hubs",
                    value: "\(push.registeredHubs.count) / \(push.pairedHubs.count)"
                )
                Button("Re-register push") {
                    PushCoordinator.shared.reregisterAll()
                }
            }
        } header: {
            Text("Notifications")
        } footer: {
            if let problem = push.lastRegistrationProblem {
                Text(problem)
            } else {
                Text("Pushes are end-to-end encrypted; only this device can read them.")
            }
        }
    }

    private func permissionLabel(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .authorized, .provisional, .ephemeral:
            String(localized: "Enabled")
        case .denied:
            String(localized: "Denied")
        default:
            String(localized: "Not requested")
        }
    }

    /// Owner-only dashboards — hidden unless the JWT namespace is `default`
    /// (the endpoints 403 for everyone else anyway; this just avoids
    /// dead-end rows).
    private var insightsSection: some View {
        Section("Insights") {
            NavigationLink {
                UsageView(api: session.api)
            } label: {
                detailRow(title: "Usage", detail: "Token usage across agents and models")
            }
            NavigationLink {
                StorageView(api: session.api)
            } label: {
                detailRow(title: "Storage", detail: "Hub database size on disk")
            }
        }
    }

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("App version", value: appVersion)
            LabeledContent("Protocol version", value: String(ProtocolVersion.supported))
            hubRow
        }
    }

    private var hubRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            LabeledContent("Hub", value: HubDisplay.host(model.hubUrl))
            Text(model.hubUrl)
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            switch model.hubInfo {
            case .loading:
                Text("Checking hub…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case .loaded(let health):
                Text("Status: \(health.status) · protocol v\(health.protocolVersion)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case .failed:
                Button {
                    model.retryHubInfo()
                } label: {
                    Text("Hub unreachable — tap to retry.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func detailRow(title: LocalizedStringKey, detail: LocalizedStringKey) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var appVersion: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return short ?? "—"
    }
}

// MARK: - Shared dashboard states

/// Shared owner-gate/error body for both dashboards (usage + storage).
/// 403 means the hub rejected a non-owner namespace — explain, don't retry.
struct DashboardErrorView: View {
    let isForbidden: Bool
    let message: String?
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(isForbidden
                ? String(localized: "This dashboard is only available to the hub owner (default namespace).")
                : String(localized: "Could not load this dashboard."))
                .font(.subheadline)
            if !isForbidden, let message, !message.isEmpty {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !isForbidden {
                Button("Retry", action: onRetry)
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// Rounded card container shared by the dashboard screens.
struct DashboardCard<Content: View>: View {
    let title: LocalizedStringKey?
    let content: Content

    init(title: LocalizedStringKey? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title {
                Text(title)
                    .font(.subheadline.weight(.semibold))
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}
