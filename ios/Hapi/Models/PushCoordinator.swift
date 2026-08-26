import Foundation
import HapiClient
import Observation
import OSLog
import Security
import UIKit
import UserNotifications

/// `@UIApplicationDelegateAdaptor` bridge: APNs registration callbacks and
/// the notification-center delegate hookup, forwarded to ``PushCoordinator``.
/// The delegate must be installed before `didFinishLaunching` returns so a
/// notification tap that cold-starts the app is delivered to it.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let coordinator = PushCoordinator.shared
        UNUserNotificationCenter.current().delegate = coordinator
        coordinator.registerNotificationCategories()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushCoordinator.shared.handleAPNsToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        PushCoordinator.shared.handleAPNsRegistrationFailure(error)
    }
}

/// Everything push: APNs token lifecycle, per-hub device registration, the
/// end-to-end push key, notification categories/actions, foreground
/// suppression, tap-through navigation, and action handling against the hub
/// REST — the iOS mirror of the Android `DeviceRegistrar` +
/// `PushActionRunner` + `NotificationActionReceiver` stack, collapsed into
/// one main-actor coordinator because iOS has no background-process entry
/// points to split it across.
///
/// Registration triggers (Android parity, minus WorkManager):
///  - app becomes active while paired → re-register everywhere (cheap
///    upsert; heals reinstalls and hub-side pruning),
///  - APNs token minted/rotated → re-register everywhere,
///  - fresh pairing → permission prompt (first time) + register that hub,
///  - sign-out → best-effort `DELETE` from a credentials snapshot taken
///    before `AppModel` wipes the Keychain record.
/// Transient failures are healed by the next trigger (or the Settings
/// re-register button) instead of a background retry queue.
@MainActor
@Observable
final class PushCoordinator: NSObject {
    static let shared = PushCoordinator()

    /// Wiring provided by `AppModel` (the coordinator outlives any single
    /// model — it is a process singleton because UIKit delegates are).
    struct Environment {
        let registry: HubRegistry
        let credentialStore: any CredentialStoring
        let performer: any HTTPPerforming
        /// Session id of the chat currently on screen, for the one
        /// suppression rule (`shouldSuppressPush` on Android).
        let openChatSessionId: @MainActor () -> String?
        /// Tap-through navigation: stash the target session for the home
        /// screen's navigation path (Android `pendingOpenSessionId`).
        let openSession: @MainActor (String) -> Void
    }

    // MARK: - Observable state (Settings row)

    /// Last known notification-permission state.
    private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    /// Hubs whose most recent `POST /api/devices/register` succeeded this
    /// launch.
    private(set) var registeredHubs: Set<String> = []
    /// Human-readable failure of the latest APNs/registration attempt.
    private(set) var lastRegistrationProblem: String?

    /// Paired hub origins (for the Settings "x of y" count). Snapshot, not
    /// observable — refreshed whenever the observable fields change.
    var pairedHubs: [String] { environment?.registry.hubs ?? [] }

    @ObservationIgnored private var environment: Environment?
    @ObservationIgnored private var apnsTokenHex: String?
    @ObservationIgnored private let log = Logger(subsystem: "run.hapi.companion", category: "push")

    // MARK: - Wiring (AppModel)

    func configure(_ environment: Environment) {
        self.environment = environment
    }

    /// Scene became active. While paired: refresh the permission state and —
    /// when notifications are authorized — (re-)request the APNs token; its
    /// arrival re-registers every hub.
    func appDidBecomeActive(isPaired: Bool) {
        Task {
            await self.refreshAuthorizationStatus()
            guard isPaired else { return }
            if self.authorizationStatus == .authorized || self.authorizationStatus == .provisional {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// A hub was just paired: prompt for notification permission now (the
    /// Android timing — never on the pristine first open, right away once a
    /// hub actually exists), then register. If the APNs token is already in
    /// hand the new hub registers immediately; otherwise the token callback
    /// registers everything.
    func hubPaired(_ hubUrl: String) {
        Task {
            let granted = await self.requestAuthorizationIfNeeded()
            guard granted else { return }
            UIApplication.shared.registerForRemoteNotifications()
            if self.apnsTokenHex != nil {
                await self.registerHubs([hubUrl])
            }
        }
    }

    /// Best-effort `DELETE /api/devices/register` for a hub about to be
    /// signed out. Must be called **before** the credentials are wiped: the
    /// record is snapshotted into an in-memory store so the detached DELETE
    /// cannot race the Keychain deletion that follows.
    func hubWillSignOut(_ hubUrl: String) {
        registeredHubs.remove(hubUrl)
        guard let environment,
              let token = apnsTokenHex,
              let url = URL(string: hubUrl),
              let record = try? environment.credentialStore.credentials(forHub: hubUrl) else {
            return
        }
        let snapshot = InMemoryCredentialStore()
        try? snapshot.store(record)
        let performer = environment.performer
        Task.detached {
            let auth = AuthManager(baseURL: url, credentialStore: snapshot, performer: performer)
            let api = APIClient(baseURL: url, authManager: auth, performer: performer)
            // Swallowed by design: the caller wipes the real credentials
            // immediately, so a retry could never authenticate anyway.
            try? await api.unregisterDevice(token: token)
        }
    }

    /// A hub disappeared without a usable JWT (terminal auth failure) — no
    /// unregister is possible; just drop it from the status row.
    func hubRemoved(_ hubUrl: String) {
        registeredHubs.remove(hubUrl)
    }

    /// Settings row: pull the current permission state (it can change in
    /// the system Settings app at any time).
    func refreshStatus() {
        Task { await self.refreshAuthorizationStatus() }
    }

    /// Settings row action: (re-)prompt if never asked, then re-register
    /// every paired hub with a fresh token.
    func reregisterAll() {
        Task {
            let granted = await self.requestAuthorizationIfNeeded()
            guard granted else { return }
            UIApplication.shared.registerForRemoteNotifications()
            if self.apnsTokenHex != nil, let hubs = self.environment?.registry.hubs {
                await self.registerHubs(hubs)
            }
        }
    }

    // MARK: - APNs callbacks (AppDelegate)

    func handleAPNsToken(_ deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        let changed = hex != apnsTokenHex
        apnsTokenHex = hex
        lastRegistrationProblem = nil
        guard let hubs = environment?.registry.hubs, !hubs.isEmpty else { return }
        // New token: everything must re-register. Same token: still run the
        // upsert — this callback doubles as the app-start healing pass.
        if changed {
            registeredHubs.removeAll()
        }
        Task { await self.registerHubs(hubs) }
    }

    func handleAPNsRegistrationFailure(_ error: Error) {
        // Simulators and entitlement-less builds land here; the status row
        // surfaces it instead of dying silently.
        lastRegistrationProblem = error.localizedDescription
        log.warning("APNs registration failed: \(error.localizedDescription, privacy: .public)")
    }

    // MARK: - Permission

    private func refreshAuthorizationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorizationStatus = settings.authorizationStatus
    }

    /// Standard alert+sound+badge prompt (no provisional delivery — HAPI
    /// pushes are actionable, quiet delivery would bury them).
    private func requestAuthorizationIfNeeded() async -> Bool {
        await refreshAuthorizationStatus()
        switch authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .denied:
            return false
        default:
            let granted = (try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            await refreshAuthorizationStatus()
            return granted
        }
    }

    // MARK: - Registration

    private func registerHubs(_ hubs: [String]) async {
        guard let environment, let token = apnsTokenHex else { return }
        let deviceId = PushKeychain.ensureDeviceId()
        guard let pushKey = PushKeychain.ensurePushKey() else {
            lastRegistrationProblem = String(localized: "Could not store the push key.")
            return
        }
        for hub in hubs {
            // Re-check the roster per hub: a sign-out can land mid-loop.
            guard environment.registry.hubs.contains(hub) else { continue }
            guard let url = URL(string: hub) else { continue }
            let auth = AuthManager(
                baseURL: url,
                credentialStore: environment.credentialStore,
                performer: environment.performer
            )
            let api = APIClient(baseURL: url, authManager: auth, performer: environment.performer)
            do {
                try await api.registerDevice(token: token, deviceId: deviceId, pushKey: pushKey.base64)
                registeredHubs.insert(hub)
            } catch {
                registeredHubs.remove(hub)
                log.warning("Device registration failed for a hub: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    // MARK: - Categories & actions

    enum ActionID {
        static let allow = "hapi.action.allow"
        static let deny = "hapi.action.deny"
        static let reply = "hapi.action.reply"
    }

    /// Category identifiers are the contract `type` strings — the same values
    /// `PushPayload.categoryIdentifier` yields and the Notification Service
    /// Extension stamps onto decrypted notifications.
    func registerNotificationCategories() {
        let allow = UNNotificationAction(
            identifier: ActionID.allow,
            title: String(localized: "Allow"),
            options: []
        )
        let deny = UNNotificationAction(
            identifier: ActionID.deny,
            title: String(localized: "Deny"),
            options: [.destructive]
        )
        let reply = UNTextInputNotificationAction(
            identifier: ActionID.reply,
            title: String(localized: "Reply"),
            options: [],
            textInputButtonTitle: String(localized: "Send"),
            textInputPlaceholder: String(localized: "Message")
        )
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(
                identifier: "permission-request",
                actions: [allow, deny],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: "ready",
                actions: [reply],
                intentIdentifiers: [],
                options: []
            ),
            UNNotificationCategory(
                identifier: "task-notification",
                actions: [reply],
                intentIdentifiers: [],
                options: []
            ),
        ])
    }

    // MARK: - Payload extraction

    /// Decrypted field map the Notification Service Extension stores into
    /// `userInfo` (see `HapiNotificationService/NotificationService.swift`).
    static let decryptedUserInfoKey = "hapiDecrypted"

    /// Reads the push payload from a delivered notification: the extension's
    /// pre-decrypted field map when present, else a direct decrypt of the
    /// `hapi.e` envelope (covers the rare NSE timeout/failure delivery).
    private func payload(from userInfo: [AnyHashable: Any]) -> PushPayload? {
        if let fields = userInfo[Self.decryptedUserInfoKey] as? [String: String] {
            return PushPayload.parse(dictionary: fields)
        }
        guard let hapi = userInfo["hapi"] as? [String: Any],
              let envelope = hapi["e"] as? String,
              let keyData = PushKeychain.readPushKey(),
              let plaintext = try? PushEnvelope.decrypt(envelopeBase64: envelope, key: keyData) else {
            return nil
        }
        return PushPayload.parse(plaintext: plaintext)
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension PushCoordinator: UNUserNotificationCenterDelegate {
    /// Foreground presentation. One suppression rule (Android
    /// `shouldSuppressPush`): while the app is foreground **with that very
    /// session's chat open**, the in-app SSE stream is already showing the
    /// event — an OS banner on top would just be noise. Everything else
    /// (other screens, other sessions, local failure notices) presents.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        if let payload = payload(from: notification.request.content.userInfo),
           let openId = environment?.openChatSessionId(),
           openId == payload.sessionId {
            return []
        }
        return [.banner, .list, .sound]
    }

    /// Tap and action handling. Runs inside the delegate's async completion,
    /// which grants background execution for the REST round-trips.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let payload = payload(from: response.notification.request.content.userInfo) else {
            return
        }
        switch response.actionIdentifier {
        case UNNotificationDefaultActionIdentifier:
            environment?.openSession(payload.sessionId)
        case ActionID.allow:
            guard let requestId = payload.requestId else { return }
            let outcome = await actionRunner().approve(
                sessionId: payload.sessionId,
                requestId: requestId
            )
            await reportIfFailed(outcome, payload: payload)
        case ActionID.deny:
            guard let requestId = payload.requestId else { return }
            let outcome = await actionRunner().deny(
                sessionId: payload.sessionId,
                requestId: requestId
            )
            await reportIfFailed(outcome, payload: payload)
        case ActionID.reply:
            let text = (response as? UNTextInputNotificationResponse)?
                .userText.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !text.isEmpty else { return }
            let outcome = await actionRunner().sendMessage(
                sessionId: payload.sessionId,
                text: text,
                localId: UUID().uuidString
            )
            await reportIfFailed(outcome, payload: payload)
        default:
            break // dismiss
        }
    }

    private func actionRunner() -> PushActionRunner {
        PushActionRunner(
            hubs: hubsActiveFirst(),
            credentialStore: environment?.credentialStore ?? InMemoryCredentialStore(),
            performer: environment?.performer ?? URLSessionHTTPPerformer.shared
        )
    }

    /// Paired hub origins with the active hub first — the try-order for
    /// hub-resolving actions (the payload carries no hub URL; for the
    /// overwhelmingly common single-hub setup the first try is the only try).
    private func hubsActiveFirst() -> [String] {
        guard let registry = environment?.registry else { return [] }
        let hubs = registry.hubs
        guard let active = registry.activeHub else { return hubs }
        return [active] + hubs.filter { $0 != active }
    }

    /// The Android workers flip the notification through pending → done /
    /// failed states; iOS dismisses the notification the moment an action is
    /// chosen, so only the failures need a surface — a local notice, because
    /// a silently lost reply is the worst outcome.
    private func reportIfFailed(_ outcome: PushActionOutcome, payload: PushPayload) async {
        let body: String?
        switch outcome {
        case .success:
            body = nil
        case .alreadyHandled:
            body = String(localized: "Already handled elsewhere.")
        case .sessionInactive:
            body = String(localized: "The session is no longer active.")
        case .sessionNotFound:
            body = String(localized: "Session not found on any paired hub.")
        case .failed, .transient:
            body = String(localized: "Could not reach your hub. Open HAPI to respond.")
        }
        guard let body else { return }
        let content = UNMutableNotificationContent()
        content.title = payload.displayTitle
        content.body = body
        content.sound = nil
        try? await UNUserNotificationCenter.current().add(
            UNNotificationRequest(
                identifier: "hapi.action.result.\(payload.sessionId)",
                content: content,
                trigger: nil
            )
        )
    }
}

// MARK: - Hub-resolving action runner

/// Terminal state of one hub-resolving push action.
enum PushActionOutcome {
    case success(hubUrl: String)
    /// A hub recognized the session but the request is gone — decided
    /// elsewhere or expired (404 `Request not found` past the session guard).
    case alreadyHandled(hubUrl: String)
    /// A hub recognized the session but it is inactive (409 `session_inactive`).
    case sessionInactive(hubUrl: String)
    /// No paired hub knows the session. Permanent.
    case sessionNotFound
    /// A hub rejected the call outright (unexpected 4xx). Permanent.
    case failed(hubUrl: String, status: Int)
    /// At least one hub failed transiently and none succeeded.
    case transient
}

/// Executes notification actions (approve / deny / reply) against the right
/// hub — a line-for-line port of the Android `PushActionRunner`
/// (`android/core/data/.../push/PushActionRunner.kt`): try the active hub
/// first, treat 404 `Session not found` / 403 as "not this hub", stop at the
/// first hub that answers authoritatively.
struct PushActionRunner {
    let hubs: [String]
    let credentialStore: any CredentialStoring
    let performer: any HTTPPerforming

    /// `POST /sessions/:id/permissions/:rid/approve` with an empty `{}` body.
    func approve(sessionId: String, requestId: String) async -> PushActionOutcome {
        await resolveAcrossHubs { api in
            try await api.approvePermission(sessionId: sessionId, requestId: requestId)
        }
    }

    /// `POST /sessions/:id/permissions/:rid/deny` with an empty `{}` body.
    func deny(sessionId: String, requestId: String) async -> PushActionOutcome {
        await resolveAcrossHubs { api in
            try await api.denyPermission(sessionId: sessionId, requestId: requestId)
        }
    }

    /// `POST /sessions/:id/messages` `{text, localId}` (notification reply).
    func sendMessage(sessionId: String, text: String, localId: String) async -> PushActionOutcome {
        await resolveAcrossHubs { api in
            try await api.sendMessage(sessionId: sessionId, text: text, localId: localId)
        }
    }

    private func resolveAcrossHubs(
        _ call: (APIClient) async throws -> Void
    ) async -> PushActionOutcome {
        guard !hubs.isEmpty else { return .sessionNotFound }
        var sawTransient = false
        for hub in hubs {
            guard let url = URL(string: hub) else { continue }
            let auth = AuthManager(baseURL: url, credentialStore: credentialStore, performer: performer)
            let api = APIClient(baseURL: url, authManager: auth, performer: performer)
            do {
                try await call(api)
                return .success(hubUrl: hub)
            } catch let error as APIError {
                switch Self.classify(error) {
                case .notThisHub:
                    continue
                case .alreadyHandled:
                    return .alreadyHandled(hubUrl: hub)
                case .sessionInactive:
                    return .sessionInactive(hubUrl: hub)
                case .rejected:
                    return .failed(hubUrl: hub, status: error.status)
                case .transient:
                    sawTransient = true
                }
            } catch is AuthError {
                // This hub's credentials are unusable right now (terminal
                // re-pair case or a failed silent re-auth) — move on.
                continue
            } catch {
                sawTransient = true // transport-level: offline hub, DNS, timeout
            }
        }
        return sawTransient ? .transient : .sessionNotFound
    }

    private enum HubVerdict {
        case notThisHub, alreadyHandled, sessionInactive, rejected, transient
    }

    /// Maps one hub's ``APIError`` to a verdict. The two 404 flavors are told
    /// apart by the hub's error string (surfaced as `APIError.code` pseudo-code
    /// fallback): `Session not found` comes from the session guard — wrong
    /// hub; `Request not found` comes after that guard passed — right hub,
    /// request gone. An unrecognizable 404 body degrades to "not this hub".
    private static func classify(_ error: APIError) -> HubVerdict {
        switch true {
        case error.status == 404 && error.code == "Request not found":
            return .alreadyHandled
        case error.status == 404, error.status == 403:
            return .notThisHub
        case error.status == 409 && error.code == "session_inactive":
            return .sessionInactive
        case error.status == 401, error.status == 408, error.status == 429:
            return .transient
        case error.status >= 500:
            return .transient
        default:
            return .rejected
        }
    }
}

// MARK: - Push Keychain (shared with the Notification Service Extension)

/// Keychain storage for the per-install push identity: the end-to-end
/// `pushKey` and the stable `deviceId`.
///
/// Both targets carry the keychain access group
/// `$(AppIdentifierPrefix)run.hapi.companion.push` as the **first** entry of
/// their `keychain-access-groups` entitlement. `kSecAttrAccessGroup` is
/// deliberately never passed: writes default to the first listed group (so
/// the items land in the shared group without hardcoding the team-id prefix,
/// which is unknowable at compile time), and reads search every accessible
/// group — the same lookup the extension performs.
///
/// `kSecAttrAccessibleAfterFirstUnlock` matches `KeychainCredentialStore`
/// and is required here: the extension must decrypt pushes while the device
/// is locked (any time after the first unlock since boot).
enum PushKeychain {
    static let service = "run.hapi.companion.push"
    static let pushKeyAccount = "pushKey"
    static let deviceIdAccount = "deviceId"

    /// The stored end-to-end key, if any (no generation — the extension-side
    /// read uses the same query shape).
    static func readPushKey() -> Data? {
        read(account: pushKeyAccount)
    }

    /// The per-install key, generated **once** and regenerated only when the
    /// stored value is missing or unusable (a regenerated key simply
    /// re-registers on this same pass).
    static func ensurePushKey() -> PushDeviceKey? {
        if let data = read(account: pushKeyAccount), let key = PushDeviceKey(data: data) {
            return key
        }
        let key = PushDeviceKey.generate()
        guard write(account: pushKeyAccount, data: key.data) else { return nil }
        return key
    }

    /// Stable install id for the hub's `(namespace, deviceId, platform)`
    /// upsert. Falls back to an ephemeral UUID if the Keychain write fails —
    /// registration still works, it just won't coalesce across reinstalls.
    static func ensureDeviceId() -> String {
        if let data = read(account: deviceIdAccount),
           let existing = String(data: data, encoding: .utf8),
           !existing.isEmpty {
            return existing
        }
        let fresh = UUID().uuidString
        _ = write(account: deviceIdAccount, data: Data(fresh.utf8))
        return fresh
    }

    private static func read(account: String) -> Data? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else {
            return nil
        }
        return item as? Data
    }

    private static func write(account: String, data: Data) -> Bool {
        let query = baseQuery(account: account)
        let update: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if updateStatus == errSecSuccess { return true }
        guard updateStatus == errSecItemNotFound else { return false }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    private static func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }
}
