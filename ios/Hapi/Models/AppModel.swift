import Foundation
import HapiClient
import HapiProtocol
import Observation
import SwiftUI

/// A pairing that awaits user confirmation — from a deep link. Drives the
/// confirm sheet.
struct PendingPairing: Identifiable {
    let id = UUID()
    /// Hub URL as carried by the link (normalized during `pair`).
    let hubUrl: String
    let accessToken: String
}

/// Root application state: which hubs are paired, which one is active, and
/// the live ``HubSession`` for it. Owns the `HubRegistry` + credential store
/// and funnels every state transition (pair, switch, sign out, deep link,
/// scene phase, terminal auth failure) through one place.
@Observable @MainActor
final class AppModel {
    enum AuthState: Equatable {
        case unpaired
        case paired(activeHub: String)
    }

    /// Derived from registry + credentials; every mutation goes through the
    /// methods below so it can never drift.
    private(set) var state: AuthState = .unpaired
    /// Live session for the active hub (`nil` while unpaired).
    private(set) var session: HubSession?
    /// Paired hub origins, in pairing order (mirrors the registry, but
    /// observable so menus update).
    private(set) var hubs: [String] = []

    /// Pairing waiting for confirmation (sheet presentation).
    var pendingPairing: PendingPairing?
    /// Presents the add-hub flow from the home screen. Lives here (not view
    /// state) so a successful pair or an incoming deep link can close it.
    var showAddHub = false
    /// Origin of a hub that terminally rejected its credentials — shown as a
    /// "pair again" banner until dismissed or re-paired.
    var authFailureNotice: String?
    /// Transient informational message (alert), e.g. deep link for an
    /// already-paired hub.
    var infoNotice: String?
    /// Session targeted by a notification tap (Android
    /// `pendingOpenSessionId`): the home screen consumes it into its
    /// navigation path against the active hub.
    var pendingOpenSessionId: String?

    // `let` storage is inert under @Observable (no annotation needed).
    let registry: HubRegistry
    private let credentialStore: any CredentialStoring
    private let performer: any HTTPPerforming
    private let pairingService: HubPairingService
    @ObservationIgnored private var isForeground = false

    init(
        registry: HubRegistry = HubRegistry(),
        credentialStore: any CredentialStoring = KeychainCredentialStore(),
        performer: any HTTPPerforming = URLSessionHTTPPerformer.shared
    ) {
        self.registry = registry
        self.credentialStore = credentialStore
        self.performer = performer
        self.pairingService = HubPairingService(
            registry: registry,
            credentialStore: credentialStore,
            performer: performer
        )
        restore()
        // Push wiring (P3): the coordinator is a process singleton (UIKit
        // delegates outlive any model); it pulls navigation + suppression
        // state through these seams instead of holding the model.
        PushCoordinator.shared.configure(PushCoordinator.Environment(
            registry: registry,
            credentialStore: credentialStore,
            performer: performer,
            openChatSessionId: { [weak self] in self?.session?.openChatSessionId },
            openSession: { [weak self] sessionId in self?.pendingOpenSessionId = sessionId }
        ))
    }

    // MARK: - Cold-start restore

    /// Activates the stored selection — or the first registered hub that
    /// still has credentials (a registry entry whose Keychain record is gone
    /// is skipped rather than presented as paired-but-dead).
    private func restore() {
        hubs = registry.hubs
        let candidates = [registry.activeHub].compactMap { $0 } + hubs
        for hub in candidates where hasCredentials(for: hub) {
            registry.setActiveHub(hub)
            activate(hub: hub)
            return
        }
        state = .unpaired
    }

    // MARK: - Pairing

    /// Full pairing sequence (normalize → `/health` → `/api/auth` → persist,
    /// see ``HubPairingService``); on success the hub becomes active with a
    /// live session. Throws ``PairingFailure`` for the confirm sheet's error
    /// states.
    @discardableResult
    func pair(hubUrl: String, accessToken: String) async throws -> PairedHub {
        let paired = try await pairingService.pair(rawHubUrl: hubUrl, accessToken: accessToken)
        authFailureNotice = nil
        // Close whichever pairing surface was up; the state flip below swaps
        // the root to the home screen.
        pendingPairing = nil
        showAddHub = false
        activate(hub: paired.hubUrl)
        // Android timing: the notification-permission prompt fires only once
        // a hub is actually paired — then this hub registers for push.
        PushCoordinator.shared.hubPaired(paired.hubUrl)
        return paired
    }

    /// Selects another paired hub, rebuilding the session for it.
    func switchHub(to hub: String) {
        guard registry.setActiveHub(hub) else { return }
        if case .paired(let current) = state, current == hub, session != nil {
            return
        }
        activate(hub: hub)
    }

    /// Unpairs a hub: credentials deleted, registry entry dropped. When it
    /// was the active hub, the next registered hub takes over (or the app
    /// falls back to the pairing flow).
    func signOut(hub: String) {
        let wasActive = state == .paired(activeHub: hub)
        if wasActive {
            session?.shutdown()
            session = nil
        }
        // Best-effort push unregister, ordered before the credential wipe
        // below (the coordinator snapshots the record synchronously, so the
        // detached DELETE cannot lose the race).
        PushCoordinator.shared.hubWillSignOut(hub)
        let nextActive = pairingService.unpair(hubUrl: hub)
        hubs = registry.hubs
        guard wasActive else { return }
        if let nextActive {
            activate(hub: nextActive)
        } else {
            state = .unpaired
        }
    }

    // MARK: - Deep links (hapicompanion://bind)

    /// Routes a parsed bind link: already-paired hubs just switch (with a
    /// notice), everything else goes through the confirm sheet — which covers
    /// both the initial pairing and the add-another-hub case.
    /// Returns `false` when the link's hub URL is unusable.
    @discardableResult
    func handleBindLink(_ link: BindLink) -> Bool {
        guard let normalized = HubURLNormalization.normalize(link.hubUrl) else {
            return false
        }
        if registry.hubs.contains(normalized), hasCredentials(for: normalized) {
            // Re-pairing with a *rotated* token still requires an explicit
            // sign-out first; silently replacing stored credentials from any
            // scanned link would be an easy way to hijack a pairing.
            switchHub(to: normalized)
            infoNotice = String(
                format: String(localized: "Already paired with %@ — switched to it."),
                HubDisplay.host(normalized)
            )
            return true
        }
        // The confirm sheet is presented from the root; make room for it.
        showAddHub = false
        pendingPairing = PendingPairing(
            hubUrl: link.hubUrl,
            accessToken: link.accessToken
        )
        return true
    }

    // MARK: - App lifecycle

    /// Forwarded from the scene: foreground starts/resumes the active
    /// session's SSE, background suspends it.
    func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            isForeground = true
            session?.enterForeground()
            // Re-registers every hub when the APNs token arrives — the
            // cheap-upsert healing pass (Android registrar `start()`).
            PushCoordinator.shared.appDidBecomeActive(isPaired: state != .unpaired)
        case .background:
            isForeground = false
            session?.enterBackground()
        case .inactive:
            break // transitional; no connection changes
        @unknown default:
            break
        }
    }

    // MARK: - Internals

    /// Builds (and starts, when foregrounded) the session for `hub`,
    /// replacing any previous one.
    private func activate(hub: String) {
        session?.shutdown()
        session = nil
        guard let newSession = HubSession(
            hubUrl: hub,
            credentialStore: credentialStore,
            performer: performer
        ) else {
            // Unreachable for registry-normalized origins; fail closed.
            state = .unpaired
            return
        }
        newSession.onTerminalAuthFailure = { [weak self] in
            self?.handleTerminalAuthFailure(for: hub)
        }
        session = newSession
        state = .paired(activeHub: hub)
        hubs = registry.hubs
        if isForeground {
            newSession.enterForeground()
        }
    }

    /// The hub rejected the stored access token (`POST /api/auth` → 401):
    /// per the auth contract that is terminal — the token was rotated or
    /// revoked, so the dead credentials are removed and the UI drops to
    /// pairing (or the next hub) with a banner.
    private func handleTerminalAuthFailure(for hub: String) {
        session = nil // the session shut itself down before calling back
        authFailureNotice = hub
        // No JWT left to authenticate a push unregister; just drop the hub
        // from the status row (the hub prunes dead tokens itself).
        PushCoordinator.shared.hubRemoved(hub)
        let nextActive = pairingService.unpair(hubUrl: hub)
        hubs = registry.hubs
        if let nextActive {
            activate(hub: nextActive)
        } else {
            state = .unpaired
        }
    }

    private func hasCredentials(for hub: String) -> Bool {
        (try? credentialStore.credentials(forHub: hub)) != nil
    }
}

/// Presentation helpers shared by the pairing and home screens.
enum HubDisplay {
    /// `https://hub.example.com:8005` → `hub.example.com:8005` (the scheme is
    /// noise in tight UI; the full origin stays available for detail rows).
    static func host(_ origin: String) -> String {
        guard let components = URLComponents(string: origin), let host = components.host else {
            return origin
        }
        if let port = components.port {
            return "\(host):\(port)"
        }
        return host
    }

    /// `tok_9f8abc123:default` → `tok_…ault`; never reveals more than the
    /// edges, and short tokens mask entirely.
    static func maskedToken(_ token: String) -> String {
        guard token.count > 10 else {
            return String(repeating: "•", count: max(4, token.count))
        }
        return "\(token.prefix(4))…\(token.suffix(4))"
    }
}
