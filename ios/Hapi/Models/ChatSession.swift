import Foundation
import HapiClient
import HapiProtocol
import Observation

/// Per-open-chat transport wiring (M2f) — the iOS counterpart of the
/// Android `ChatViewModel`'s lifecycle half:
///
/// - opens this session's ``MessageWindowController`` through the hub's
///   registry (snapshot hydration + `activate()`), then kicks a tail sync;
/// - owns the **session-scope** SSE subscription while the chat is on screen
///   (dual-subscription model: `HubSession` keeps the global pipe for the
///   list) and routes its events:
///     - message-stream family → the window controller's ingest hooks,
///     - `session-updated`/lifecycle + `machine-updated` + `toast` → the
///       shared `SyncEventRouter` (detail patching included),
///     - `session-removed` for this session → clears the window,
///     - a `gap` handshake verdict → full REST resync + detail refetch +
///       the window's catch-up tail sync (`ensureAfterCurrent`);
/// - suspends/resumes with the scene phase (forwarded by `HubSession`) and
///   on `stop()` hands its SSE resume cursor back to the hub session, so a
///   reopened chat resumes instead of replaying cold.
///
/// **Ordering.** The window must observe SSE events in arrival order (the
/// Android port funnels them through a single-consumer Channel for this).
/// Here the same guarantee falls out of structure: `SSEClient` yields into
/// one `AsyncStream`, exactly one task consumes it, and every event is
/// `await`ed to completion — including the hop into the window controller's
/// actor — before the next one is pulled. One producer, one consumer, one
/// awaited hop per event: no interleaving is possible.
@MainActor @Observable
final class ChatSession {
    let sessionId: String

    /// Session-pipe connection state, for the chat header/banner.
    private(set) var connectionState: SSEConnectionState = .idle
    /// From this pipe's latest handshake; needed for `POST /api/visibility`
    /// (M3b) — new on every reconnect.
    private(set) var subscriptionId: String?
    /// Set once `start()` opened the window; the chat model observes its
    /// state stream and calls its `fetchOlder`/`syncTail`.
    private(set) var windowController: MessageWindowController?

    /// Fired (on the main actor) after every handled SSE event so the chat
    /// model can re-run its pipeline over the freshly patched stores.
    @ObservationIgnored var onStoreActivity: (@MainActor () -> Void)?

    private let baseURL: URL
    private let authManager: AuthManager
    private let windows: MessageWindowControllers
    private let sessionStore: SessionListStore
    @ObservationIgnored private let router: SyncEventRouter
    @ObservationIgnored private let initialCursor: String?
    @ObservationIgnored private let registerActive: @MainActor (ChatSession) -> Void
    @ObservationIgnored private let unregisterActive: @MainActor (ChatSession) -> Void
    @ObservationIgnored private let saveCursor: @MainActor (String?) -> Void
    /// Fired on every handshake with the fresh subscription id (visibility
    /// reporting).
    @ObservationIgnored private let onHandshake: @MainActor (String?) -> Void

    @ObservationIgnored private var sse: SSEClient?
    @ObservationIgnored private var consumeTask: Task<Void, Never>?
    @ObservationIgnored private var started = false
    @ObservationIgnored private var stopped = false

    init(
        sessionId: String,
        baseURL: URL,
        authManager: AuthManager,
        windows: MessageWindowControllers,
        sessionStore: SessionListStore,
        machineStore: MachineStore,
        initialCursor: String?,
        registerActive: @escaping @MainActor (ChatSession) -> Void,
        unregisterActive: @escaping @MainActor (ChatSession) -> Void = { _ in },
        saveCursor: @escaping @MainActor (String?) -> Void,
        onHandshake: @escaping @MainActor (String?) -> Void = { _ in }
    ) {
        self.sessionId = sessionId
        self.baseURL = baseURL
        self.authManager = authManager
        self.windows = windows
        self.sessionStore = sessionStore
        self.router = SyncEventRouter(sessions: sessionStore, machines: machineStore)
        self.initialCursor = initialCursor
        self.registerActive = registerActive
        self.unregisterActive = unregisterActive
        self.saveCursor = saveCursor
        self.onHandshake = onHandshake
    }

    // MARK: - Lifecycle

    /// Open the window, then subscribe: every routed message event finds the
    /// controller already in place (the Android wiring order). Idempotent.
    func start() async {
        guard !started, !stopped else { return }
        started = true
        registerActive(self)
        let controller = await windows.open(sessionId: sessionId)
        await controller.activate()
        // A stop() can land while the opens above were suspended; do not
        // bring the SSE up for a dead chat.
        guard !stopped else { return }
        windowController = controller
        startSessionSSE()
        // Explicit catch-up on entry (the snapshot may be stale); the SSE
        // handshake's own gap handling covers everything missed after this.
        Task { await controller.syncTail() }
    }

    /// Tears the session pipe down; the engine-side resume cursor is saved
    /// so a reopened chat for this session resumes where it left off.
    /// Idempotent — both the view's disappear and a hub shutdown call it.
    func stop() {
        guard !stopped else { return }
        stopped = true
        // Clears the hub session's open-chat marker (push suppression) —
        // identity-guarded on the other side against register/stop races.
        unregisterActive(self)
        onStoreActivity = nil
        consumeTask?.cancel()
        consumeTask = nil
        connectionState = .idle
        // Nobody observes the detail once the chat closes (mirror of the
        // Android `sessionStore.releaseDetail`).
        sessionStore.releaseDetail(sessionId)
        if let sse {
            self.sse = nil
            let save = saveCursor
            Task {
                let cursor = await sse.lastEventId
                await sse.stop()
                save(cursor)
            }
        }
    }

    /// Scene-phase forwarding (see `HubSession.enterForeground`): resume the
    /// parked retry loop, with the 45 s staleness distrust for a socket that
    /// survived suspension.
    func enterForeground() {
        guard started, !stopped, let sse else { return }
        Task { await sse.resume() }
    }

    func enterBackground() {
        guard let sse else { return }
        Task { await sse.suspend() }
    }

    // MARK: - Session-scope SSE

    private func startSessionSSE() {
        let auth = authManager
        let configuration = SSEClientConfiguration(
            baseUrl: baseURL,
            tokenProvider: {
                // Transient failures park the SSE loop in backoff; the
                // terminal (re-pair required) case is owned by the global
                // pipe in `HubSession`, which tears this session down too.
                try? await auth.validToken()
            },
            scope: .session(sessionId)
        )
        let client = SSEClient(configuration: configuration, pathObserver: NWPathObserver())
        sse = client
        let cursor = initialCursor
        consumeTask = Task { [weak self] in
            // Seed before start (the client ignores seeds after the run
            // loop exists); both calls run sequentially on the client actor.
            if let cursor { await client.seedCursor(cursor) }
            let stream = await client.start()
            for await event in stream {
                guard let self, !Task.isCancelled else { return }
                // Sequential handling — see the ordering note on the type.
                await self.handle(event)
            }
        }
    }

    private func handle(_ event: SSEClientEvent) async {
        switch event {
        case .stateChanged(let state):
            connectionState = state
        case .handshake(let resume, let subscriptionId):
            self.subscriptionId = subscriptionId
            onHandshake(subscriptionId)
            // `.ok` = the replay that follows covers the gap. Anything else
            // (including the verdict-less first connect) cannot prove
            // continuity for this filter set.
            if resume != .ok {
                recoverFromGap()
            }
        case .event(let syncEvent):
            await route(syncEvent)
        }
        onStoreActivity?()
    }

    private func route(_ event: SyncEvent) async {
        switch event {
        case .messageReceived, .messagesConsumed, .messageCancelled,
             .messagesInvalidated, .scheduledMatured:
            // Message-stream family → the open window (the controller
            // re-checks the session id defensively).
            if let controller = windowController {
                await controller.onMessageEvent(event)
            }
        case .sessionRemoved(_, let removedId):
            router.route(event, scope: .session(sessionId))
            if removedId == sessionId {
                // Web `clearMessageWindow` on session-removed.
                await windows.clear(sessionId: sessionId)
            }
        default:
            // `session-updated` (detail patch / full session), lifecycle,
            // `machine-updated`, `toast` — the shared store fan-out.
            router.route(event, scope: .session(sessionId))
        }
    }

    /// `resume: gap` on the session pipe (Android `requestFullResync` with a
    /// session key): list + cached details + machines over REST, make sure
    /// THIS detail exists even if it was never cached, and catch the window
    /// up past any in-flight sync (web `resyncMessages`). Since M3a the
    /// catch-up runs through `reconcileQueuedState()` — it begins with the
    /// same draining tail sync and then verifies optimistic queued rows
    /// against the hub (web queued-state reconciliation after a gap).
    private func recoverFromGap() {
        router.requestFullResync()
        if sessionStore.detail(for: sessionId) == nil {
            let store = sessionStore
            let id = sessionId
            Task { try? await store.loadSessionDetail(id) }
        }
        if let controller = windowController {
            Task {
                do {
                    try await controller.reconcileQueuedState()
                } catch {
                    // The reconcile's REST round trip failed — the tail sync
                    // inside it already ran/flagged; nothing more to do.
                }
            }
        }
    }
}
