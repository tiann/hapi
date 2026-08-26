import Foundation
import HapiClient
import HapiProtocol
import Observation

/// Everything the app holds for the currently active hub: the typed REST
/// client, its auth manager, the **global** SSE subscription
/// (`scope: .global` — one per app session; per-chat `.session` subscriptions
/// are vended per open chat via ``makeChatSession(sessionId:)``), the M2a
/// stores it feeds (session list, machines, last-seen watermarks), and the
/// M2f message-window registry.
///
/// Lifecycle is driven by `AppModel` from `scenePhase`: the SSE connection
/// starts on the first foreground, suspends in background (flushing the
/// store snapshots), and resumes (with the 45 s staleness check) on return.
/// `AppModel` builds a fresh instance per hub switch and calls `shutdown()`
/// on the old one — a `HubSession` never outlives its hub selection.
@MainActor @Observable
final class HubSession {
    /// Normalized hub origin (registry / credential key).
    let hubUrl: String
    let baseURL: URL
    let authManager: AuthManager
    let api: APIClient

    /// Session list + detail cache, snapshot-backed per hub.
    let sessionStore: SessionListStore
    /// Online machines (labels for list rows + the machine filter).
    let machineStore: MachineStore
    /// Unread watermarks, snapshot-backed per hub.
    let lastSeenStore: LastSeenStore
    /// Per-session message window registry (M2f), snapshot-backed per hub.
    let windows: MessageWindowControllers
    /// Per-session scratchlist cache (A-M4b), fed the `scratchlistUpdatedAt`
    /// invalidation signal from the session-patch application below.
    let scratchlist: ScratchlistStore
    /// `POST /api/visibility` reporter (M3b): fed every pipe's handshake
    /// subscription id, flipped with the scene phase.
    let visibility: VisibilityReporter

    /// Global SSE connection state, for the UI's connection dot.
    private(set) var connectionState: SSEConnectionState = .idle
    /// Verdict of the latest SSE handshake (`ok` = replay covered the gap).
    private(set) var lastResumeVerdict: ResumeVerdict?
    /// From the latest handshake; needed for `POST /api/visibility` (M3b).
    private(set) var subscriptionId: String?
    /// Session id of the chat currently on screen, or nil. Feeds the push
    /// foreground-suppression rule (Android `openChatSessionId`): a push for
    /// the chat the user is looking at is pure noise.
    private(set) var openChatSessionId: String?

    /// Fired once when the hub terminally rejects the stored credentials
    /// (access token rotated/revoked). `AppModel` reacts by dropping the hub
    /// back to pairing with a banner.
    @ObservationIgnored var onTerminalAuthFailure: (@MainActor () -> Void)?

    @ObservationIgnored private let router: SyncEventRouter
    @ObservationIgnored private var sse: SSEClient?
    @ObservationIgnored private var consumeTask: Task<Void, Never>?
    @ObservationIgnored private var reportedAuthFailure = false
    @ObservationIgnored private var isShutDown = false

    /// The chat currently on screen (at most one in this UI), forwarded the
    /// scene-phase transitions so its session-scope SSE parks in background.
    @ObservationIgnored private weak var activeChat: ChatSession?
    /// Session-pipe resume cursors surviving chat close/reopen within this
    /// hub session (the Android engine keeps its per-key cursor the same
    /// way). Keyed by session id; never reused across hubs because the whole
    /// `HubSession` — cursors included — dies on hub switch.
    @ObservationIgnored private var chatCursors: [String: String] = [:]

    init?(
        hubUrl: String,
        credentialStore: any CredentialStoring,
        performer: any HTTPPerforming = URLSessionHTTPPerformer.shared
    ) {
        guard let baseURL = URL(string: hubUrl) else { return nil }
        self.hubUrl = hubUrl
        self.baseURL = baseURL
        let authManager = AuthManager(
            baseURL: baseURL,
            credentialStore: credentialStore,
            performer: performer
        )
        self.authManager = authManager
        let api = APIClient(baseURL: baseURL, authManager: authManager, performer: performer)
        self.api = api

        // Per-hub snapshot directory: cold starts render the last known list
        // instantly, then SSE/REST reconcile.
        let snapshotDirectory = SnapshotLocations.directory(forHub: hubUrl)
        let sessionStore = SessionListStore(api: api, snapshotDirectory: snapshotDirectory)
        let machineStore = MachineStore(api: api, snapshotDirectory: snapshotDirectory)
        self.sessionStore = sessionStore
        self.machineStore = machineStore
        self.lastSeenStore = LastSeenStore(snapshotDirectory: snapshotDirectory)
        self.windows = MessageWindowControllers(
            provider: api,
            snapshots: WindowSnapshotStore(
                directory: snapshotDirectory.appendingPathComponent("windows", isDirectory: true)
            )
        )
        let scratchlist = ScratchlistStore(api: api)
        self.scratchlist = scratchlist
        // `scratchlistUpdatedAt` on a session patch (either SSE pipe — both
        // route through this store) is a bare refetch trigger for that
        // session's scratchlist (A-M4b).
        sessionStore.onScratchlistInvalidation = { sessionId in
            scratchlist.handleInvalidation(sessionId: sessionId)
        }
        self.visibility = VisibilityReporter(setVisibility: { subscriptionId, visibility in
            try await api.setVisibility(subscriptionId: subscriptionId, visibility: visibility)
        })
        self.router = SyncEventRouter(sessions: sessionStore, machines: machineStore)
    }

    // MARK: - Per-chat sessions (M2f)

    /// Builds the per-session wiring for an opened chat: window controller
    /// access, the session-scope SSE pipe, and event routing into the shared
    /// stores. The caller (ChatModel) drives `start()`/`stop()` with the
    /// screen's lifetime; this hub session only forwards scene-phase
    /// transitions and remembers the SSE resume cursor across reopens.
    func makeChatSession(sessionId: String) -> ChatSession {
        ChatSession(
            sessionId: sessionId,
            baseURL: baseURL,
            authManager: authManager,
            windows: windows,
            sessionStore: sessionStore,
            machineStore: machineStore,
            initialCursor: chatCursors[sessionId],
            registerActive: { [weak self] chat in
                self?.activeChat = chat
                self?.openChatSessionId = chat.sessionId
            },
            unregisterActive: { [weak self] chat in
                // Guarded by identity: a superseding chat may register before
                // the replaced screen's teardown lands (SwiftUI ordering).
                guard let self, self.activeChat === chat else { return }
                self.activeChat = nil
                self.openChatSessionId = nil
            },
            saveCursor: { [weak self] cursor in
                if let cursor {
                    self?.chatCursors[sessionId] = cursor
                }
            },
            onHandshake: { [weak self] subscriptionId in
                self?.visibility.onHandshake(
                    key: "session:\(sessionId)",
                    subscriptionId: subscriptionId
                )
            }
        )
    }

    /// Builds the interaction engine for an opened chat (A-M3ab): composer
    /// sends, queued-bar operations, permission decisions, and the config
    /// sheet — all against this hub's client, stores, and window registry.
    /// Drafts persist per hub + session in `UserDefaults`.
    func makeChatInteractor(sessionId: String) -> ChatInteractor {
        let interactor = ChatInteractor(
            sessionId: sessionId,
            api: api,
            sessionStore: sessionStore,
            windows: windows,
            drafts: UserDefaultsChatDrafts(scope: hubUrl)
        )
        // Scratchlist seams (A-M4b): toolbar badge count + park/insert.
        interactor.scratchlist = scratchlist
        return interactor
    }

    // MARK: - Lifecycle (driven by AppModel from scenePhase)

    /// First call starts the global SSE subscription; later calls resume a
    /// suspended one (which distrusts sockets silent for 45 s or more).
    func enterForeground() {
        guard !isShutDown, !reportedAuthFailure else { return }
        if let sse {
            Task { await sse.resume() }
        } else {
            startGlobalSSE()
        }
        activeChat?.enterForeground()
        visibility.setForeground(true)
    }

    /// Parks the SSE retry loop; a live connection is left to the OS. Also
    /// forces the debounced store snapshots to disk — background is the last
    /// reliable moment before a possible process kill.
    func enterBackground() {
        if let sse {
            Task { await sse.suspend() }
        }
        activeChat?.enterBackground()
        visibility.setForeground(false)
        let sessionStore = sessionStore
        let machineStore = machineStore
        let lastSeenStore = lastSeenStore
        Task {
            await sessionStore.flushPersistence()
            await machineStore.flushPersistence()
            await lastSeenStore.flushPersistence()
        }
    }

    /// Tears everything down. The session is unusable afterwards.
    func shutdown() {
        isShutDown = true
        onTerminalAuthFailure = nil
        // Hub switch can outrun the chat view's disappear; stop is idempotent.
        activeChat?.stop()
        activeChat = nil
        consumeTask?.cancel()
        consumeTask = nil
        if let sse {
            self.sse = nil
            Task { await sse.stop() }
        }
        connectionState = .idle
    }

    // MARK: - Global SSE

    private func startGlobalSSE() {
        let auth = authManager
        let configuration = SSEClientConfiguration(
            baseUrl: baseURL,
            tokenProvider: { [weak self] in
                do {
                    return try await auth.validToken()
                } catch AuthError.reauthenticationRequired {
                    // Terminal: only re-pairing recovers. Surface once on the
                    // main actor; returning nil parks the SSE loop in backoff
                    // until AppModel shuts this session down.
                    let session = self // weak capture, may already be gone
                    Task { @MainActor in
                        session?.handleTerminalAuthFailure()
                    }
                    return nil
                } catch {
                    // Transient (offline, hub restarting): the SSE loop backs
                    // off and asks again.
                    return nil
                }
            },
            scope: .global
        )
        let client = SSEClient(configuration: configuration, pathObserver: NWPathObserver())
        sse = client
        consumeTask = Task { [weak self] in
            let stream = await client.start()
            for await event in stream {
                guard let self, !Task.isCancelled else { return }
                self.handle(event)
            }
        }
    }

    private func handle(_ event: SSEClientEvent) {
        switch event {
        case .stateChanged(let state):
            connectionState = state
        case .handshake(let resume, let subscriptionId):
            lastResumeVerdict = resume
            self.subscriptionId = subscriptionId
            visibility.onHandshake(key: "global", subscriptionId: subscriptionId)
            // `.ok` = the replay that follows covers every missed event, so
            // the REST resync is skipped; `.gap` triggers the full refetch
            // (session list + cached details + machines).
            router.handleHandshake(resume: resume)
        case .event(let syncEvent):
            router.route(syncEvent, scope: .global)
        }
    }

    private func handleTerminalAuthFailure() {
        guard !reportedAuthFailure, !isShutDown else { return }
        reportedAuthFailure = true
        let callback = onTerminalAuthFailure
        shutdown()
        callback?()
    }
}
