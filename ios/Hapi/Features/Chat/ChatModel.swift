import Foundation
import HapiClient
import HapiProtocol
import Observation

/// Chat top-bar state: title cascade + status dot + meta line.
struct ChatHeaderUI: Equatable {
    var title: String
    /// "Flavor · machine · worktree" meta line; nil when nothing is known.
    var subtitle: String?
    /// Raw `metadata.flavor` — drives the brand icon next to the meta line.
    var flavor: String?
    var active: Bool
    var thinking: Bool
}

/// Presentation state machine for the read-only chat screen (M2f) — the iOS
/// counterpart of the Android `ChatViewModel`'s pipeline half. It combines
/// the message window's UI state with the cached session detail (whose
/// `agentState` carries permission verdicts) and machine labels, runs the
/// reduction pipeline **off the main actor** through ``ChatPipeline``, and
/// publishes render-ready `[VisibleChatBlock]` plus header/loading state.
///
/// Recompute scheduling mirrors the web's render batching (Android's
/// `sample(100ms)`): inputs bump a revision and a single serial loop drains
/// it — the first run starts immediately, later runs coalesce to at most one
/// per ~100 ms, and because exactly one loop runs at a time every publish is
/// computed-from-latest-at-start and strictly ordered (a stale run can never
/// overwrite a newer one — the race the "detached task keyed by revision"
/// design exists to prevent).
///
/// Pipeline memoization (normalize per row instance, `previousGroups` for
/// stable group ids) lives inside ``ChatPipeline``; see its docs.
@MainActor @Observable
final class ChatModel {
    let sessionId: String

    // MARK: Published render state

    private(set) var blocks: [VisibleChatBlock] = []
    private(set) var header: ChatHeaderUI
    /// Workspace root, for path display in tool cards.
    private(set) var basePath: String?
    private(set) var hasMore = false
    private(set) var isLoadingOlder = false
    private(set) var isSyncingTail = true
    /// First sync still running and nothing (snapshot included) to show yet.
    private(set) var isInitialLoading = true
    /// Initial load produced nothing and the last attempt failed.
    private(set) var loadFailed = false
    /// Tail-sync warning — the degraded banner.
    private(set) var warning: String?
    /// Bumps on tail-side content changes (drives the new-messages pill).
    private(set) var tailRevision = 0
    /// Bumps when an older page was prepended (drives scroll re-anchoring).
    private(set) var historyVersion = 0

    /// Transient toast text (interaction failures/notices); auto-dismissed.
    private(set) var notice: String?
    /// Resume handed back a different session id — the view replaces its
    /// navigation entry with this one.
    private(set) var supersededSessionId: String?

    /// Session-pipe connection state (observed through the chat session).
    var connectionState: SSEConnectionState { chat.connectionState }

    // MARK: Wiring

    private let hub: HubSession
    /// Rebuilt on every `start()` after a `stop()` — a `ChatSession` is
    /// single-use (its SSE client cannot restart), and the saved resume
    /// cursor makes the rebuild cheap. This absorbs SwiftUI's
    /// appear/disappear cycles around full-screen presentations.
    private var chat: ChatSession
    /// Interaction engine (A-M3ab): composer, queued bar, permissions,
    /// config. Long-lived alongside this model; `start()`/`stop()` map to its
    /// `activate()`/`deactivate()`.
    let interactor: ChatInteractor
    /// Voice dictation (A-M3f): provider discovery + record/transcribe state
    /// machine (HapiKit) over the app-side `AVAudioRecorder` seam.
    /// Transcripts append to the composer; failures surface as notices.
    let dictation: DictationController
    @ObservationIgnored private let pipeline = ChatPipeline()
    @ObservationIgnored let imageLoader: GeneratedImageLoader
    /// Authed thumbnail/viewer loader for scratchlist attachments (A-M4b).
    @ObservationIgnored let scratchlistAttachments: ScratchlistAttachmentLoader

    /// The hub's scratchlist store, for the toolbar-badge sheet (A-M4b).
    var scratchlist: ScratchlistStore { hub.scratchlist }
    @ObservationIgnored private var noticeTask: Task<Void, Never>?

    @ObservationIgnored private var windowState: MessageWindowState?
    @ObservationIgnored private var detailLoadFailed = false
    @ObservationIgnored private var inputRevision = 0
    @ObservationIgnored private var pipelineTask: Task<Void, Never>?
    @ObservationIgnored private var statesTask: Task<Void, Never>?
    @ObservationIgnored private var olderTask: Task<Void, Never>?
    @ObservationIgnored private var isActive = false
    @ObservationIgnored private var everStarted = false

    init(session: HubSession, sessionId: String) {
        self.hub = session
        self.sessionId = sessionId
        self.chat = session.makeChatSession(sessionId: sessionId)
        self.interactor = session.makeChatInteractor(sessionId: sessionId)
        self.dictation = DictationController(
            api: session.api,
            recorder: AVAudioRecorderDictation()
        )
        self.imageLoader = GeneratedImageLoader(api: session.api, sessionId: sessionId)
        self.scratchlistAttachments = ScratchlistAttachmentLoader(api: session.api, sessionId: sessionId)
        self.header = ChatHeaderUI(
            title: String(sessionId.prefix(8)),
            subtitle: nil,
            flavor: nil,
            active: false,
            thinking: false
        )
    }

    // MARK: - Lifecycle (paired with the screen's appear/disappear)

    func start() {
        guard !isActive else { return }
        isActive = true
        if everStarted {
            // Coming back from a stop (e.g. a full-screen cover fired the
            // screen's disappear): fresh wiring, resumed at the saved cursor.
            chat = hub.makeChatSession(sessionId: sessionId)
        }
        everStarted = true
        interactor.onEvent = { [weak self] event in
            guard let self else { return }
            switch event {
            case .sessionSuperseded(let sessionId):
                self.supersededSessionId = sessionId
            case .notice(let message):
                self.showNotice(message)
            }
        }
        interactor.activate()
        dictation.onEvent = { [weak self] event in
            guard let self else { return }
            switch event {
            case .transcribed(let text):
                self.interactor.appendDictatedText(text)
            case .noProvider:
                self.showNotice(String(localized: "No transcription provider configured on hub"))
            case .error(let message):
                self.showNotice(message)
            }
        }
        // Badge count + SSE-invalidation refetch while the chat is open
        // (the Android ChatViewModel start/stop pairing).
        hub.scratchlist.open(sessionId)
        let chat = chat
        chat.onStoreActivity = { [weak self] in
            self?.scheduleRecompute()
        }
        Task { [weak self] in
            await chat.start()
            guard let self, self.isActive, self.chat === chat else { return }
            guard let controller = chat.windowController else { return }
            self.statesTask = Task { [weak self] in
                let states = await controller.states()
                for await state in states {
                    guard let self, !Task.isCancelled else { return }
                    self.windowState = state
                    self.scheduleRecompute()
                }
            }
            await self.loadDetail()
        }
    }

    func stop() {
        guard isActive else { return }
        isActive = false
        statesTask?.cancel()
        statesTask = nil
        pipelineTask?.cancel()
        pipelineTask = nil
        olderTask?.cancel()
        olderTask = nil
        noticeTask?.cancel()
        noticeTask = nil
        // Discard an in-flight take — the mic must not stay hot off-screen
        // (an upload already in Transcribing runs to completion and still
        // appends). Attachment chips deliberately survive this stop: a
        // full-screen cover (camera, image viewer) bounces through
        // stop/start, and un-sent uploads are cleaned up when the tray
        // deallocates with this model.
        dictation.cancel()
        interactor.deactivate()
        hub.scratchlist.release(sessionId)
        chat.stop()
    }

    private func showNotice(_ message: String) {
        notice = message
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            self?.notice = nil
        }
    }

    // MARK: - Actions

    /// Top sentinel reached: one older page. No-ops while one is in flight
    /// or while a tail sync could race the cursor (Android gate).
    func loadOlder() {
        guard olderTask == nil, let controller = chat.windowController else { return }
        guard let windowState, windowState.hasMore,
              !windowState.isLoadingMore, !windowState.isSyncingTail else { return }
        olderTask = Task { [weak self] in
            _ = await controller.fetchOlder()
            self?.olderTask = nil
        }
    }

    /// Error state → try again (detail + a tail sync past any in-flight run).
    func retry() {
        let controller = chat.windowController
        Task { [weak self] in
            await self?.loadDetail()
            if let controller {
                await controller.syncTail(ensureAfterCurrent: true)
            }
        }
    }

    private func loadDetail() async {
        do {
            _ = try await hub.sessionStore.loadSessionDetail(sessionId)
            detailLoadFailed = false
        } catch is CancellationError {
            return
        } catch {
            detailLoadFailed = true
        }
        scheduleRecompute()
    }

    // MARK: - Pipeline scheduling

    private func scheduleRecompute() {
        inputRevision += 1
        guard pipelineTask == nil else { return }
        pipelineTask = Task { [weak self] in
            await self?.pipelineLoop()
        }
    }

    /// Serial drain loop; see the type comment for the ordering argument.
    /// All state reads/writes happen on the main actor — only the reduction
    /// itself hops onto the pipeline actor.
    private func pipelineLoop() async {
        while !Task.isCancelled {
            let revision = inputRevision
            if let window = windowState {
                let detail = hub.sessionStore.detail(for: sessionId)
                let summary = hub.sessionStore.sessions.first { $0.id == sessionId }
                let machines = hub.machineStore.machines
                let visible = await pipeline.run(
                    messages: window.messages,
                    agentState: detail?.agentState,
                    hasMoreMessages: window.hasMore
                )
                guard !Task.isCancelled else { return }
                apply(visible, window: window, detail: detail, summary: summary, machines: machines)
            }
            // No suspension between this check and parking, so a concurrent
            // scheduleRecompute either lands before it (loop again) or finds
            // pipelineTask nil and starts a fresh loop — never lost.
            if inputRevision == revision {
                pipelineTask = nil
                return
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    private func apply(
        _ visible: [VisibleChatBlock],
        window: MessageWindowState,
        detail: Session?,
        summary: SessionSummary?,
        machines: [Machine]
    ) {
        blocks = visible
        header = Self.buildHeader(
            sessionId: sessionId,
            detail: detail,
            summary: summary,
            machines: machines
        )
        basePath = detail?.metadata?.path ?? summary?.metadata?.path
        hasMore = window.hasMore
        isLoadingOlder = window.isLoadingMore
        isSyncingTail = window.isSyncingTail
        warning = window.warning
        tailRevision = window.tailRevision
        historyVersion = window.historyVersion

        let isEmpty = visible.isEmpty
        // syncGeneration 0 = no tail sync has even begun (the moment between
        // open and syncTail) — still "loading", never a flash of empty state.
        let syncSettled = !window.isSyncingTail && window.syncGeneration > 0
        isInitialLoading = isEmpty && !syncSettled && window.warning == nil
        loadFailed = isEmpty && syncSettled && (window.warning != nil || detailLoadFailed)

        // Watermark = the updatedAt currently on screen, from whichever cache
        // is fresher (summary via the global pipe, detail via this one).
        // markSeen is monotonic, so stale inputs cannot rewind it.
        let updatedAt = max(detail?.updatedAt ?? 0, summary?.updatedAt ?? 0)
        if updatedAt > 0 {
            hub.lastSeenStore.markSeen(sessionId: sessionId, seenAt: updatedAt)
        }
    }

    // MARK: - Header derivation (Android `buildHeader` port)

    private static func buildHeader(
        sessionId: String,
        detail: Session?,
        summary: SessionSummary?,
        machines: [Machine]
    ) -> ChatHeaderUI {
        // Detail first — the fresher source once loaded (this pipe patches
        // it live); a detail without usable metadata falls through to the
        // list summary, then to the id prefix (`getSessionTitle` cascade).
        let title = detail.flatMap(detailTitle)
            ?? summary.map(SessionListModel.sessionTitle)
            ?? String(sessionId.prefix(8))

        let flavor = detail?.metadata?.flavor ?? summary?.metadata?.flavor
        let machineId = detail?.metadata?.machineId ?? summary?.metadata?.machineId
        let machineLabel: String? = machineId.map { id in
            guard let metadata = machines.first(where: { $0.id == id })?.metadata else {
                return String(id.prefix(8))
            }
            if let displayName = metadata.displayName,
               !displayName.trimmingCharacters(in: .whitespaces).isEmpty {
                return displayName
            }
            return metadata.host
        }
        let worktree = (detail?.metadata?.worktree ?? summary?.metadata?.worktree).map { tree in
            tree.name.trimmingCharacters(in: .whitespaces).isEmpty ? tree.branch : tree.name
        }
        let parts: [String] = [
            flavor.map { flavorLabel(forFlavor: $0) },
            machineLabel,
            worktree,
        ].compactMap { $0 }

        return ChatHeaderUI(
            title: title,
            subtitle: parts.isEmpty ? nil : parts.joined(separator: " · "),
            flavor: flavor,
            active: detail?.active ?? summary?.active ?? false,
            thinking: detail?.thinking ?? summary?.thinking ?? false
        )
    }

    /// Detail-side title cascade; nil when the metadata carries nothing usable.
    private static func detailTitle(_ detail: Session) -> String? {
        guard let metadata = detail.metadata else { return nil }
        if let name = metadata.name, !name.isEmpty {
            return name
        }
        if let text = metadata.summary?.text, !text.isEmpty {
            return text
        }
        if let tail = metadata.path.split(separator: "/").last(where: { !$0.isEmpty }) {
            return String(tail)
        }
        return nil
    }
}
