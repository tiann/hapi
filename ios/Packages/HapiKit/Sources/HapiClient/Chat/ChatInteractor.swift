import Foundation
import HapiProtocol
import Observation

/// Per-session chat interaction engine (A-M3ab) — the iOS counterpart of the
/// Android `ChatViewModel`'s interaction half, kept in HapiKit so the whole
/// surface runs under `swift test`:
///
/// - **Composer** (``composer``/``setComposerText(_:)``/``sendMessage(steer:)``):
///   optimistic send (`appendOptimistic` → POST → status settle), queue by
///   default with an explicit long-press steer intent
///   (`messageDelivery.ts` semantics), failed rows retried via
///   ``retryFailedMessage(localId:)`` (steer degrades to queue —
///   `getRetryDeliveryMode`); `session_inactive` (409) auto-resumes once and
///   retries, following a superseding session id with a window seed + draft
///   move + ``ChatInteractionEvent/sessionSuperseded(sessionId:)``. Drafts
///   persist per session via ``ChatDrafts`` (debounced, flushed on
///   ``deactivate()``).
/// - **Attachments** (``attachments``, a ``ComposerAttachments`` tray —
///   A-M3f): picks are prepared app-side (`AttachmentPreparer`, policy in
///   ``AttachmentPolicy``), upload on add, and the Ready set rides
///   `SendMessageRequest.attachments` — the optimistic row carries the
///   metadata so bubbles render thumbnails before the SSE echo. An unsettled
///   chip blocks the send with a notice; attachments-only sends post empty
///   text (wire: text OR attachments). ``appendDictatedText(_:)`` is the
///   dictation hand-off (A-M3f voice).
/// - **Queued bar** (``queuedRows``): uninvoked sends, web sort order
///   (immediate by submission, then scheduled by fire time), with Cancel
///   (optimistic DELETE; an `invoked` answer ingests the authoritative row as
///   sent), Edit (cancel + prefill, newer-draft guard) and Steer — one
///   in-flight queued operation at a time.
/// - **Permissions** (``resolvePermission(requestId:action:)``): flavor-exact
///   approve/deny bodies (`permissionApproveBody`), optimistic
///   ``PermissionRowOverride``s settled by the agentState patch (the
///   published ``permissionOverrides`` prunes rows whose request left
///   `agentState.requests`); hub 404/409 → benign "already handled".
/// - **Config** (``config``/``setPermissionMode(_:)``/``setModel(_:)``/
///   ``setEffort(_:)``/``setCollaborationMode(_:)``/``loadModelOptions()``): catalog pickers with
///   optimistic detail updates, rolled forward to server truth on error;
///   codex model catalog fetched per session.
///
/// `@Observable` computed surfaces (``composer``, ``queuedRows``, ``config``,
/// ``permissionOverrides``) read the observable `SessionListStore` and this
/// class's own observable storage, so SwiftUI tracks them without any push
/// plumbing; the one push input — window state — arrives through the window
/// controller's state stream started by ``activate()``.
@MainActor @Observable
public final class ChatInteractor {
    public let sessionId: String

    /// Composer attachment tray (A-M3f). The screen feeds prepared picks in
    /// and renders `attachments.items`; ``sendMessage(steer:)`` consumes the
    /// Ready set. Lives (and dies) with this interactor — see the tray's own
    /// docs for the discard-on-deallocation semantics.
    public let attachments: ComposerAttachments

    // MARK: Observable storage

    /// Composer text (owned here so drafts and edit-prefill flow through it).
    public private(set) var composerText = ""
    /// A send (or its resume recovery) is in flight.
    public private(set) var isSending = false
    /// Latest window state (feeds ``queuedRows``).
    public private(set) var windowState: MessageWindowState?
    /// Codex model catalog load state (feeds ``config``).
    public private(set) var codexModels: CodexModelsState = .idle
    /// One config POST at a time (compare-and-set, like the Android
    /// `configOpPending`); exposed so the sheet can render a busy state.
    public private(set) var configOpPending = false

    /// Local focus intent, observed by the composer without changing its draft.
    public private(set) var composerFocusRequest = 0
    public private(set) var composerDestination: ComposerDestination = .chat
    public private(set) var scratchlistBusy = false
    public private(set) var scratchlistError: String?
    public private(set) var scratchlistErrorDestination: ComposerDestination?
    public private(set) var scratchlistEntryErrors: [String: String] = [:]
    public private(set) var queuedScratchlistEntries: Set<String> = []
    private var parkAttempt: (text: String, attachments: [ComposerAttachmentSnapshot], id: String)?
    private struct ScratchlistQueueAttempt {
        let entry: ScratchlistEntry
        let localId: String
        let target: String
        let attachments: [AttachmentMetadata]
    }
    private var scratchlistQueueAttempts: [String: ScratchlistQueueAttempt] = [:]
    private var scratchlistSendTarget: String?
    // Screen-owned, not row-local: recycled plan cards retain operation state.
    private var pendingCodexPlanId: String?
    private var implementedCodexPlanIds: Set<String> = []
    private var continuedCodexPlanIds: Set<String> = []
    private var codexPlanErrors: [String: String] = [:]

    private var queuedOpPending = false
    /// Raw override map; the published view prunes settled requests.
    private var overridesStore: [String: PermissionRowOverride] = [:]

    /// One-shot effects: renavigation on supersede, toast notices. Set by the
    /// owning screen model; replaced wholesale on re-activation.
    @ObservationIgnored public var onEvent: (@MainActor (ChatInteractionEvent) -> Void)?

    // MARK: Wiring

    private let api: APIClient
    private let sessionStore: SessionListStore
    private let windows: MessageWindowControllers
    private let drafts: (any ChatDrafts)?
    private let draftSaveDebounce: Duration
    private let now: () -> Int
    /// Web `makeClientSideId('local')` twin; injectable for deterministic tests.
    private let makeLocalId: () -> String

    @ObservationIgnored private var controller: MessageWindowController?
    @ObservationIgnored private var statesTask: Task<Void, Never>?
    @ObservationIgnored private var draftTask: Task<Void, Never>?
    @ObservationIgnored private var isActive = false

    public init(
        sessionId: String,
        api: APIClient,
        sessionStore: SessionListStore,
        windows: MessageWindowControllers,
        drafts: (any ChatDrafts)? = nil,
        draftSaveDebounce: Duration = .milliseconds(300),
        now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
        makeLocalId: @escaping () -> String = { "local-\(UUID().uuidString)" }
    ) {
        self.sessionId = sessionId
        self.api = api
        self.sessionStore = sessionStore
        self.windows = windows
        self.drafts = drafts
        self.draftSaveDebounce = draftSaveDebounce
        self.now = now
        self.makeLocalId = makeLocalId
        self.attachments = ComposerAttachments(api: api, sessionId: sessionId)
    }

    // MARK: - Lifecycle (paired with the screen's appear/disappear)

    /// Opens the window, restores the draft, verifies optimistic queued rows
    /// against the hub (web queued-state reconciliation on chat open), and
    /// starts observing window state for the queued bar. Idempotent.
    public func activate() {
        guard !isActive else { return }
        isActive = true
        statesTask = Task { [weak self] in
            guard let self else { return }
            let controller = await self.windows.open(sessionId: self.sessionId)
            guard self.isActive, !Task.isCancelled else { return }
            self.controller = controller
            self.restoreDraft()
            // Reconcile begins with a draining tail sync, so it also covers
            // the catch-up the Android start() runs first.
            Task { try? await controller.reconcileQueuedState() }
            let states = await controller.states()
            for await state in states {
                guard !Task.isCancelled else { return }
                self.windowState = state
            }
        }
    }

    /// Stops window observation and flushes a pending debounced draft save
    /// (the web analogue is the beforeunload persist). In-flight sends and
    /// queued/config operations run to completion. Idempotent.
    public func deactivate() {
        guard isActive else { return }
        isActive = false
        statesTask?.cancel()
        statesTask = nil
        flushPendingDraft()
    }

    // MARK: - Composer

    /// Composer bar state (steer offered only while a turn is active).
    public var composer: ComposerState {
        let live = currentSessionState()
        return ComposerState(
            text: composerText,
            isSending: isSending,
            canSteer: live.thinking && live.active
        )
    }

    public func setComposerText(_ text: String) {
        composerText = text
        draftTask?.cancel()
        guard let drafts else { return }
        let sessionId = sessionId
        let debounce = draftSaveDebounce
        // Inherits main-actor isolation, so capturing the drafts store is safe.
        draftTask = Task {
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            drafts.save(sessionId: sessionId, text: text)
        }
    }

    /// Submit the composer. Delivery defaults to durable queue; `steer` is
    /// the explicit long-press intent that delivers into the active turn
    /// (`deliveryMode: "steer"` — attachments may ride a steer, only
    /// `scheduledAt` excludes them).
    ///
    /// Ready attachments are consumed into `SendMessageRequest.attachments`;
    /// an unsettled chip (uploading/failed) blocks the send with a notice.
    /// Text may be empty when attachments exist (wire: text OR attachments).
    public func sendMessage(steer: Bool = false) {
        guard !isSending, !scratchlistBusy else { return }
        if composerDestination == .scratchlist {
            parkComposerDraft()
            return
        }
        if attachments.hasUnsettled {
            emit(.notice("Attachments are still uploading — wait, or retry/remove the failed ones"))
            return
        }
        if attachments.hasScratchlistAttachments {
            sendComposerWithScratchlistAttachments(steer: steer)
            return
        }
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachmentMetadata = attachments.consume()
        guard !text.isEmpty || attachmentMetadata != nil else { return }
        composerText = ""
        draftTask?.cancel()
        draftTask = nil
        isSending = true
        let localId = makeLocalId()
        let createdAt = now()
        let deliveryMode: MessageDeliveryMode = steer ? .steer : .queue
        Task { [weak self] in
            guard let self else { return }
            self.drafts?.clear(sessionId: self.sessionId)
            if attachmentMetadata == nil && (text == "/clear" || text == "/new")
                && self.sessionStore.detail(for: self.sessionId)?.metadata?.capabilities?.concurrentClients == true {
                defer { self.isSending = false }
                do {
                    let result = try await self.api.clearConversation(id: self.sessionId)
                    self.sessionStore.scheduleRefresh()
                    self.emit(.sessionSuperseded(sessionId: result.sessionId))
                } catch {
                    self.setComposerText(text)
                    self.emit(.notice(Self.errorMessage(error, fallback: "Failed to create conversation")))
                }
                return
            }
            await self.performSend(
                text: text,
                localId: localId,
                createdAt: createdAt,
                deliveryMode: deliveryMode,
                attachments: attachmentMetadata,
                scheduledAt: nil,
                isRetry: false
            )
        }
    }

    /// Dictation transcript arrived: append with a space separator (web
    /// `appendTranscript`).
    public func appendDictatedText(_ transcript: String) {
        setComposerText(appendTranscript(composerText, transcript: transcript))
    }

    /// Screen-level notices (attachment prep failures, mic permission) ride
    /// the same event channel as interaction failures.
    public func postNotice(_ message: String) {
        emit(.notice(message))
    }

    /// Explicitly discard un-sent attachment uploads (best-effort hub
    /// deletes). The tray's deallocation does the same implicitly when the
    /// chat is left for good; attachments deliberately do not persist in
    /// drafts v1.
    public func discardAttachments() {
        attachments.discardAllDetached()
    }

    /// Tap-to-retry on a failed optimistic row: re-fires the send with the
    /// same localId. A retry cannot prove the original turn is still live —
    /// steer degrades to queue (web `getRetryDeliveryMode`).
    public func retryFailedMessage(localId: String) {
        if let attempt = scratchlistQueueAttempts.values.first(where: { $0.localId == localId }) {
            Task { await queueScratchlistEntry(attempt.entry) }
            return
        }
        guard !isSending else { return }
        isSending = true
        Task { [weak self] in
            guard let self else { return }
            let store = await self.windowController()
            let row = await store.state.messages
                .first { $0.localId == localId && $0.status == .failed }
            guard let row, let payload = Self.sendPayload(of: row) else {
                self.isSending = false
                return
            }
            await self.performSend(
                text: payload.text,
                localId: localId,
                createdAt: row.createdAt,
                deliveryMode: .queue,
                attachments: payload.attachments,
                scheduledAt: row.scheduledAt,
                isRetry: true
            )
        }
    }

    /// `POST /abort` — confirm-free stop of the active turn.
    public func abortSession() {
        Task { [weak self] in
            guard let self else { return }
            do {
                try await self.api.abortSession(id: self.sessionId)
            } catch {
                self.emit(.notice(Self.errorMessage(error, fallback: "Failed to abort")))
            }
        }
    }

    private struct SendPayload {
        let text: String
        let attachments: [AttachmentMetadata]?
    }

    /// Extract text + attachments from an optimistic user row's wire content.
    private static func sendPayload(of row: WindowMessage) -> SendPayload? {
        guard let inner = row.content.objectValue?["content"]?.objectValue,
              let text = inner["text"]?.stringValue else {
            return nil
        }
        var attachments: [AttachmentMetadata]?
        if let raw = inner["attachments"],
           let data = try? HapiJSON.encoder.encode(raw),
           let decoded = try? HapiJSON.decoder.decode([AttachmentMetadata].self, from: data),
           !decoded.isEmpty {
            attachments = decoded
        }
        return SendPayload(text: text, attachments: attachments)
    }

    @discardableResult
    private func performSend(
        text: String,
        localId: String,
        createdAt: Int,
        deliveryMode: MessageDeliveryMode,
        attachments: [AttachmentMetadata]?,
        scheduledAt: Int?,
        isRetry: Bool,
        targetSessionId: String? = nil
    ) async -> String? {
        defer { isSending = false }
        let target = targetSessionId ?? sessionId
        let store = target == sessionId ? await windowController() : await windows.open(sessionId: target)
        if isRetry {
            await store.updateStatus(localId: localId, status: .sending)
        } else {
            await store.appendOptimistic(
                localId: localId,
                text: text,
                attachments: attachments,
                scheduledAt: scheduledAt,
                deliveryMode: deliveryMode.rawValue,
                createdAt: createdAt
            )
        }
        let request = SendMessageRequest(
            text: text,
            localId: localId,
            attachments: attachments,
            scheduledAt: scheduledAt,
            deliveryMode: deliveryMode
        )
        do {
            try await api.sendMessage(sessionId: target, request)
            await store.updateStatus(localId: localId, status: successStatus())
            return target
        } catch let error as APIError where error.status == 409 && error.code == "session_inactive" {
            return await resumeAndRetry(store: store, request: request, localId: localId, fromSessionId: target)
        } catch {
            await store.updateStatus(localId: localId, status: .failed)
            return nil
        }
    }

    /// Queued while a turn is active, sent otherwise (web `onMutate`).
    private func successStatus() -> MessageStatus {
        currentSessionState().thinking ? .queued : .sent
    }

    /// `session_inactive` recovery (web `resolveSessionId` semantics): one
    /// `POST /resume` with the current permission mode, then retry the send
    /// against the id the hub returns. A different id supersedes this
    /// session — seed the new window from this one, migrate the draft,
    /// retarget the optimistic row, and tell the screen to renavigate.
    private func resumeAndRetry(
        store: MessageWindowController,
        request: SendMessageRequest,
        localId: String,
        fromSessionId: String
    ) async -> String? {
        let targetSessionId: String
        do {
            targetSessionId = try await api.resumeSession(
                id: fromSessionId,
                permissionMode: sessionStore.detail(for: fromSessionId)?.permissionMode
            )
        } catch {
            await store.updateStatus(localId: localId, status: .failed)
            emit(.notice("Session is inactive and could not be resumed"))
            return nil
        }

        let optimisticRow = await store.state.messages.first { $0.localId == localId }
        var targetStore = store
        if targetSessionId != fromSessionId {
            await windows.seed(fromSessionId: fromSessionId, toSessionId: targetSessionId)
            targetStore = await windows.open(sessionId: targetSessionId)
            if let optimisticRow {
                // Seeding copies rows across, but make the hand-off explicit:
                // the pending row must live in the target window only.
                await targetStore.appendOptimistic(optimisticRow)
                await store.removeMessage(localIdOrId: localId)
            }
            drafts?.move(fromSessionId: fromSessionId, toSessionId: targetSessionId)
        }

        // Resume succeeded: reflect activity locally, refresh the list row.
        sessionStore.updateDetailLocal(fromSessionId) { $0.active = true }
        sessionStore.scheduleRefresh()
        scratchlistSendTarget = targetSessionId

        var accepted = false
        do {
            try await api.sendMessage(sessionId: targetSessionId, request)
            await targetStore.updateStatus(localId: localId, status: successStatus())
            accepted = true
        } catch {
            await targetStore.updateStatus(localId: localId, status: .failed)
        }
        if targetSessionId != sessionId {
            emit(.sessionSuperseded(sessionId: targetSessionId))
        }
        return accepted ? targetSessionId : nil
    }

    // MARK: - Queued bar

    /// Uninvoked sends, ordered like the web (`sortQueuedMessages`): immediate
    /// first in submission order, then scheduled by fire time.
    public var queuedRows: [QueuedMessageRow] {
        guard let windowState else { return [] }
        let thinking = currentSessionState().thinking
        let queued = windowState.messages.filter { $0.isQueuedForInvocation }
        let sorted = queued.enumerated().sorted { lhs, rhs in
            let lhsScheduled = lhs.element.scheduledAt != nil
            let rhsScheduled = rhs.element.scheduledAt != nil
            if lhsScheduled != rhsScheduled { return rhsScheduled }
            let lhsKey = lhs.element.scheduledAt ?? lhs.element.createdAt
            let rhsKey = rhs.element.scheduledAt ?? rhs.element.createdAt
            if lhsKey != rhsKey { return lhsKey < rhsKey }
            return lhs.offset < rhs.offset
        }.map(\.element)
        return sorted.map { row in
            let preview = Self.queuedPreview(row)
            let canAct = Self.hasServerEcho(row) && !queuedOpPending
            return QueuedMessageRow(
                id: row.id,
                localId: row.localId,
                text: preview.text,
                attachmentNames: preview.attachmentNames,
                scheduledAt: row.scheduledAt,
                canAct: canAct,
                canSteer: canAct && thinking && row.scheduledAt == nil && row.status != .indeterminate,
                indeterminate: row.status == .indeterminate
            )
        }
    }

    /// Cancel one queued message: optimistic removal, `DELETE`; an `invoked`
    /// answer means the agent already consumed it — ingest the authoritative
    /// row as sent (web `useCancelQueuedMessage`). Errors restore the row.
    public func cancelQueuedMessage(_ messageId: String) {
        Task { [weak self] in
            _ = await self?.cancelQueuedInternal(messageId)
        }
    }

    private enum CancelVerdict {
        case cancelled
        case invoked
        case busy
    }

    /// The cancel verdict, or nil on guard/error.
    private func cancelQueuedInternal(_ messageId: String) async -> CancelVerdict? {
        let store = await windowController()
        guard let row = await store.state.messages.first(where: { $0.id == messageId }),
              Self.hasServerEcho(row), !queuedOpPending else {
            return nil
        }
        queuedOpPending = true
        defer { queuedOpPending = false }
        let localId = row.localId ?? row.id
        await store.removeMessage(localIdOrId: localId)
        do {
            switch try await api.cancelMessage(sessionId: sessionId, messageId: messageId) {
            case .cancelled:
                return .cancelled
            case .invoked(let message):
                await store.applyCancelInvoked(localId: localId, message: WindowMessage(wire: message))
                return .invoked
            case .busy:
                await store.appendOptimistic(row.withDeliveryState("indeterminate"))
                try? await store.reconcileQueuedState()
                return .busy
            }
        } catch {
            await store.appendOptimistic(row)
            emit(.notice(Self.errorMessage(error, fallback: "Failed to cancel queued message")))
            return nil
        }
    }

    public func retryIndeterminateMessage(_ messageId: String) {
        guard !queuedOpPending else { return }
        queuedOpPending = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.queuedOpPending = false }
            do {
                let response = try await api.retryIndeterminateMessage(sessionId: sessionId, messageId: messageId)
                if response.status == "invoked", let message = response.message,
                   let localId = message.localId, let invokedAt = message.invokedAt {
                    await (windowController()).markConsumed(localIds: [localId], invokedAt: invokedAt)
                } else if response.status == "retried" || response.status == "already-queued",
                          let localId = response.localId {
                    await (windowController()).markRequeued(localIds: [localId])
                } else if response.status == "not-found" {
                    await (windowController()).removeMessage(localIdOrId: messageId)
                    emit(.notice("Message is no longer available"))
                } else if response.status == "retry-unavailable" {
                    emit(.notice("Delivery is still being resolved"))
                }
            } catch {
                emit(.notice(Self.errorMessage(error, fallback: "Failed to retry message")))
            }
        }
    }

    /// Edit = cancel + prefill composer (kept when the operator typed
    /// meanwhile).
    public func editQueuedMessage(_ messageId: String) {
        Task { [weak self] in
            guard let self else { return }
            let store = await self.windowController()
            guard let row = await store.state.messages.first(where: { $0.id == messageId }) else {
                return
            }
            let preview = Self.queuedPreview(row)
            let editText = preview.text.isEmpty
                ? preview.attachmentNames.joined(separator: ", ")
                : preview.text
            let composerAtEdit = self.composerText
            switch await self.cancelQueuedInternal(messageId) {
            case .cancelled:
                if self.composerText == composerAtEdit {
                    self.setComposerText(editText)
                } else {
                    self.emit(.notice("Message cancelled — kept your current draft"))
                }
            case .invoked:
                self.emit(.notice("Already delivered to the agent"))
            case .busy:
                self.emit(.notice("Delivery outcome is unknown; message remains queued"))
            case nil:
                break
            }
        }
    }

    /// Steer one queued message into the active turn. Non-optimistic: the
    /// `messages-consumed` event settles the row (web `useSteerQueuedMessage`);
    /// an `invoked` answer reconciles a missed consume.
    public func steerQueuedMessage(_ messageId: String) {
        Task { [weak self] in
            guard let self else { return }
            let store = await self.windowController()
            guard let row = await store.state.messages.first(where: { $0.id == messageId }),
                  Self.hasServerEcho(row), row.scheduledAt == nil, !self.queuedOpPending else {
                return
            }
            self.queuedOpPending = true
            defer { self.queuedOpPending = false }
            do {
                switch try await self.api.steerMessage(sessionId: self.sessionId, messageId: messageId) {
                case .failed(let error, _):
                    self.emit(.notice(error))
                case .invoked(let message):
                    if let invokedLocalId = message.localId, let invokedAt = message.invokedAt {
                        await store.markConsumed(localIds: [invokedLocalId], invokedAt: invokedAt)
                    }
                case .steered:
                    break // messages-consumed removes the row.
                }
            } catch {
                self.emit(.notice(Self.errorMessage(error, fallback: "Failed to steer message")))
            }
        }
    }

    private static func hasServerEcho(_ row: WindowMessage) -> Bool {
        row.localId == nil || row.id != row.localId
    }

    private struct QueuedPreview {
        let text: String
        let attachmentNames: [String]
    }

    private static func queuedPreview(_ row: WindowMessage) -> QueuedPreview {
        guard let normalized = normalizeDecryptedMessage(row.asDecryptedMessage),
              case .user(let text, let attachments) = normalized.content else {
            return QueuedPreview(text: "", attachmentNames: [])
        }
        return QueuedPreview(
            text: text.trimmingCharacters(in: .whitespacesAndNewlines),
            attachmentNames: attachments?.map(\.filename) ?? []
        )
    }

    // MARK: - Permissions

    /// Per-request optimistic permission state. A settled request (gone from
    /// `agentState.requests`) drops its override; a missing agentState means
    /// the detail is (re)loading, not that the requests settled — never prune
    /// on absence of evidence.
    public var permissionOverrides: [String: PermissionRowOverride] {
        prunedOverrides()
    }

    /// Raw agent flavor id (`claude`, `codex`, …); drives the permission
    /// button sets.
    public var flavor: String? {
        currentFlavor()
    }

    /// Apply one permission decision. Wire bodies match the web
    /// `PermissionFooter`/`AskUserQuestionFooter`/`RequestUserInputFooter`
    /// exactly; 404/409 from the hub mean the request already settled
    /// elsewhere — surfaced as a benign `alreadyHandled`.
    public func resolvePermission(requestId: String, action: PermissionAction) {
        overridesStore = prunedOverrides()
        guard overridesStore[requestId] == nil else { return }
        overridesStore[requestId] = .resolving
        Task { [weak self] in
            guard let self else { return }
            do {
                switch action {
                case .deny:
                    try await self.api.denyPermission(sessionId: self.sessionId, requestId: requestId)
                case .abort:
                    try await self.api.denyPermission(
                        sessionId: self.sessionId,
                        requestId: requestId,
                        decision: .abort
                    )
                default:
                    try await self.api.approvePermission(
                        sessionId: self.sessionId,
                        requestId: requestId,
                        self.approveBody(requestId: requestId, action: action)
                    )
                }
                // Success: stay `resolving`; the agentState patch clears the
                // pending request and the pruned view drops the override.
            } catch let error as APIError where error.status == 404 || error.status == 409 {
                self.overridesStore[requestId] = .alreadyHandled
                self.emit(.notice("Request was already handled"))
            } catch {
                self.overridesStore.removeValue(forKey: requestId)
                self.emit(.notice(Self.errorMessage(error, fallback: "Request failed")))
            }
        }
    }

    private func approveBody(requestId: String, action: PermissionAction) -> PermissionApproveRequest {
        let request = sessionStore.detail(for: sessionId)?.agentState?.requests?[requestId]
        return permissionApproveBody(
            action: action,
            flavor: currentFlavor(),
            toolName: request?.tool,
            arguments: request?.arguments
        )
    }

    private func prunedOverrides() -> [String: PermissionRowOverride] {
        guard !overridesStore.isEmpty else { return [:] }
        guard let agentState = sessionStore.detail(for: sessionId)?.agentState else {
            return overridesStore
        }
        let pendingIds = agentState.requests.map { Set($0.keys) } ?? []
        return overridesStore.filter { pendingIds.contains($0.key) }
    }

    // MARK: - Session config

    /// Session config sheet model (catalog-driven per flavor).
    public var config: SessionConfigState {
        buildSessionConfigState(
            detail: sessionStore.detail(for: sessionId),
            summary: sessionStore.sessions.first { $0.id == sessionId },
            codexModels: codexModels
        )
    }

    /// `POST /permission-mode` with an optimistic detail flip; server truth
    /// on error.
    public func setPermissionMode(_ mode: PermissionMode) {
        let api = api
        let sessionId = sessionId
        runConfigChange(
            optimistic: { $0.permissionMode = mode },
            call: { try await api.setPermissionMode(sessionId: sessionId, mode: mode) }
        )
    }

    /// Codex `POST /collaboration-mode`; shared terminals can edit too.
    public func setCollaborationMode(_ mode: CodexCollaborationMode) {
        let config = config
        guard config.canChangeCollaborationMode, mode != (config.collaborationMode ?? .default) else { return }
        let api = api
        let sessionId = sessionId
        runConfigChange(
            optimistic: { $0.collaborationMode = mode },
            call: { try await api.setCollaborationMode(sessionId: sessionId, mode: mode) }
        )
    }

    /// `POST /model` — nil clears back to the agent default.
    public func setModel(_ model: String?) {
        let api = api
        let sessionId = sessionId
        runConfigChange(
            optimistic: { $0.model = model },
            call: { try await api.setModel(sessionId: sessionId, model: model.map(ModelSelection.id)) }
        )
    }

    /// Effort switch, flavor-routed: claude → `POST /effort`; codex/opencode
    /// → `POST /model-reasoning-effort`. Nil clears.
    public func setEffort(_ effort: String?) {
        let flavor = currentFlavor()
        let usesReasoningEffort = flavor == "codex" || flavor == "opencode"
        let api = api
        let sessionId = sessionId
        runConfigChange(
            optimistic: { session in
                if usesReasoningEffort {
                    session.modelReasoningEffort = effort
                } else {
                    session.effort = effort
                }
            },
            call: {
                if usesReasoningEffort {
                    try await api.setModelReasoningEffort(
                        sessionId: sessionId,
                        modelReasoningEffort: effort
                    )
                } else {
                    try await api.setEffort(sessionId: sessionId, effort: effort)
                }
            }
        )
    }

    /// Fetch the codex model catalog for the picker (no-op for other flavors).
    public func loadModelOptions() {
        guard currentFlavor() == "codex" else { return }
        switch codexModels {
        case .loading, .loaded:
            return
        case .idle, .failed:
            break
        }
        codexModels = .loading
        Task { [weak self] in
            guard let self else { return }
            do {
                let response = try await self.api.sessionCodexModels(sessionId: self.sessionId)
                if response.success, let models = response.models {
                    self.codexModels = .loaded(models)
                } else {
                    self.emit(.notice(response.error ?? "Failed to load models"))
                    self.codexModels = .failed
                }
            } catch {
                self.emit(.notice(Self.errorMessage(error, fallback: "Failed to load models")))
                self.codexModels = .failed
            }
        }
    }

    private func runConfigChange(
        optimistic: (inout Session) -> Void,
        call: @escaping @Sendable () async throws -> Void
    ) {
        guard !configOpPending else { return }
        configOpPending = true
        sessionStore.updateDetailLocal(sessionId, optimistic)
        Task { [weak self] in
            guard let self else { return }
            defer { self.configOpPending = false }
            do {
                try await call()
            } catch {
                // Roll back by rolling forward to server truth (an SSE patch
                // may have moved other fields since the optimistic write).
                _ = try? await self.sessionStore.loadSessionDetail(self.sessionId)
                self.emit(.notice(Self.errorMessage(error, fallback: "Failed to update session")))
            }
        }
    }

    // MARK: - Codex plan client actions

    public func codexPlanActions(planId: String) -> CodexPlanActionState {
        let detail = sessionStore.detail(for: sessionId)
        let available = detail?.active == true
            && detail?.metadata?.flavor == "codex"
            && detail?.metadata?.capabilities?.concurrentClients == true
            && detail?.agentState?.codexPlanProposalId == planId
            && !implementedCodexPlanIds.contains(planId)
            && !continuedCodexPlanIds.contains(planId)
        return CodexPlanActionState(
            available: available,
            pending: pendingCodexPlanId == planId,
            canAct: available && pendingCodexPlanId == nil && !isSending && !configOpPending
                && detail?.thinking != true,
            error: codexPlanErrors[planId]
        )
    }

    /// One request at a time, with no optimistic message or mode switch.
    /// Refresh even on failure: another client may have consumed the proposal.
    public func implementCodexPlan(planId: String) {
        guard codexPlanActions(planId: planId).canAct else { return }
        pendingCodexPlanId = planId
        codexPlanErrors[planId] = nil
        Task { [weak self] in
            guard let self else { return }
            defer { self.pendingCodexPlanId = nil }
            do {
                try await self.api.implementCodexPlan(sessionId: self.sessionId, planId: planId)
                // Do not re-enable an accepted plan if the detail refresh fails
                // or briefly returns state from before the queue acceptance.
                self.implementedCodexPlanIds.insert(planId)
            } catch {
                let serverMessage = (error as? APIError)?.body.flatMap { body in
                    (try? HapiJSON.decoder.decode(JSONValue.self, from: Data(body.utf8)))?
                        .objectValue?["error"]?.stringValue
                }
                self.codexPlanErrors[planId] = serverMessage
                    ?? Self.errorMessage(error, fallback: "Request failed")
            }
            _ = try? await self.sessionStore.loadSessionDetail(self.sessionId)
        }
    }

    /// Continue planning dismisses this proposal’s actions and focuses the composer; it neither sends
    /// text nor resolves an approval nor changes the collaboration mode.
    public func continueCodexPlan(planId: String) {
        guard codexPlanActions(planId: planId).canAct else { return }
        continuedCodexPlanIds.insert(planId)
        codexPlanErrors[planId] = nil
        composerFocusRequest += 1
    }

    // MARK: - Internals

    private func windowController() async -> MessageWindowController {
        if let controller {
            return controller
        }
        let opened = await windows.open(sessionId: sessionId)
        controller = opened
        return opened
    }

    private func currentFlavor() -> String? {
        sessionStore.detail(for: sessionId)?.metadata?.flavor
            ?? sessionStore.sessions.first { $0.id == sessionId }?.metadata?.flavor
    }

    private struct SessionLiveState {
        let active: Bool
        let thinking: Bool
    }

    private func currentSessionState() -> SessionLiveState {
        if let detail = sessionStore.detail(for: sessionId) {
            return SessionLiveState(active: detail.active, thinking: detail.thinking)
        }
        let summary = sessionStore.sessions.first { $0.id == sessionId }
        return SessionLiveState(
            active: summary?.active ?? false,
            thinking: summary?.thinking ?? false
        )
    }

    private func restoreDraft() {
        guard let drafts, composerText.isEmpty,
              let draft = drafts.load(sessionId: sessionId), !draft.isEmpty else {
            return
        }
        composerText = draft
    }

    /// A debounced draft save cancelled by screen exit would lose the last
    /// keystrokes; persist synchronously instead (UserDefaults-backed).
    private func flushPendingDraft() {
        let pending = draftTask != nil && draftTask?.isCancelled == false
        draftTask?.cancel()
        draftTask = nil
        guard pending, let drafts else { return }
        drafts.save(sessionId: sessionId, text: composerText)
    }

    private func emit(_ event: ChatInteractionEvent) {
        onEvent?(event)
    }

    private static func errorMessage(_ error: any Error, fallback: String) -> String {
        (error as? LocalizedError)?.errorDescription ?? fallback
    }

    // MARK: - Scratchlist (A-M4b)

    /// Per-session scratchlist store; nil ⇒ the scratchlist UI is hidden
    /// (badge 0, park no-op). Injected by `HubSession` after construction —
    /// a settable property rather than an init parameter keeps this addition
    /// purely additive. Tests substitute fakes.
    @ObservationIgnored public var scratchlist: (any SessionScratchlistStoring)?

    /// Entry count for the chat toolbar's scratchlist badge — observable
    /// through the store's own state (the Android `scratchlistCount` twin).
    public var scratchlistCount: Int {
        scratchlist?.state(sessionId).entries.count ?? 0
    }

    /// Scratchlist "To composer": insert `text` into the composer — an empty
    /// composer takes it verbatim, an existing draft keeps its words and the
    /// entry lands on a new line (the entry itself stays on the scratchlist,
    /// like the web's promote-to-composer).
    public func insertComposerText(_ text: String) {
        guard !Self.isBlank(text) else { return }
        let current = composerText
        if Self.isBlank(current) {
            setComposerText(text)
        } else {
            setComposerText(Self.trimmingTrailingWhitespace(current) + "\n" + text)
        }
    }

    public var hasComposerDraft: Bool { !Self.isBlank(composerText) || !attachments.items.isEmpty }

    public func setComposerDestination(_ destination: ComposerDestination) {
        guard !scratchlistBusy, !isSending else { return }
        composerDestination = destination
        scratchlistError = nil
        scratchlistErrorDestination = nil
    }

    public func focusComposer() { composerFocusRequest += 1 }

    public func reportScratchlistError(_ message: String) {
        scratchlistError = message
        scratchlistErrorDestination = nil
    }

    public func retryScratchlistComposerOperation() {
        switch scratchlistErrorDestination {
        case .scratchlist: parkComposerDraft()
        case .chat: sendMessage()
        case nil: scratchlistError = nil
        }
    }

    /// Capture both text and attachment identities; only clear the accepted
    /// snapshot. A retry of the same draft uses the same hub entry id.
    public func parkComposerDraft() {
        guard scratchlist != nil, !scratchlistBusy, !isSending, hasComposerDraft else { return }
        scratchlistBusy = true
        Task {
            defer { scratchlistBusy = false }
            _ = await parkCurrentDraft()
        }
    }

    private func parkCurrentDraft() async -> Bool {
        guard let scratchlist else { return false }
        let text = composerText
        scratchlistError = nil
        guard text.utf16.count <= ScratchlistCaps.maxTextLength else {
            return failPark("Drafts can contain at most 10,000 characters — shorten the text before saving")
        }
        guard !attachments.hasUnsettled else {
            return failPark("Attachments are still uploading — wait, or retry/remove the failed ones")
        }
        let snapshot = attachments.snapshot
        guard !Self.isBlank(text) || !snapshot.isEmpty else { return false }
        if parkAttempt?.text != text || parkAttempt?.attachments != snapshot {
            guard !scratchlist.state(sessionId).atCap else { return failPark("Scratchlist is full (200 entries)") }
            parkAttempt = (text, snapshot, "scratch-\(UUID().uuidString)")
        }
        let id = parkAttempt!.id
        let prepared: ScratchlistTransfer.Parked
        do {
            prepared = try await ScratchlistTransfer.preparePark(api: api, store: scratchlist, sessionId: sessionId, snapshot: snapshot)
        } catch { return failPark(error.localizedDescription) }
        guard composerText == text, attachments.snapshot == snapshot, !attachments.hasUnsettled else {
            await ScratchlistTransfer.cleanupPark(store: scratchlist, sessionId: sessionId, attachments: prepared.uploaded)
            return failPark("Your input changed — review it and try again")
        }
        switch await scratchlist.createEntry(sessionId: sessionId, text: text, attachments: prepared.attachments, entryId: id) {
        case .created(let entry):
            attachments.markScratchlistPersisted(entry.attachments)
            if composerText == text, attachments.snapshot == snapshot, !attachments.hasUnsettled {
                setComposerText("")
                attachments.discard(snapshot)
            }
            parkAttempt = nil
            // A retried POST can return the first accepted set of attachments.
            let canonicalIds = Set(entry.attachments.map(\.id))
            await ScratchlistTransfer.cleanupPark(store: scratchlist, sessionId: sessionId,
                attachments: prepared.uploaded.filter { !canonicalIds.contains($0.id) })
            emit(.notice("Draft parked to scratchlist"))
            return true
        case .atCap:
            await ScratchlistTransfer.cleanupPark(store: scratchlist, sessionId: sessionId, attachments: prepared.uploaded)
            return failPark("Scratchlist is full (200 entries)")
        case .failed:
            await ScratchlistTransfer.cleanupPark(store: scratchlist, sessionId: sessionId, attachments: prepared.uploaded)
            return failPark("Couldn't park the draft — check the hub connection")
        }
    }

    private func failPark(_ message: String) -> Bool {
        scratchlistError = message
        scratchlistErrorDestination = .scratchlist
        emit(.notice(message))
        return false
    }

    /// The caller asks for a choice when there is an existing draft. Restoring
    /// borrowed hub references is local and never resumes or sends a session.
    @discardableResult
    public func restoreScratchlistEntry(_ entry: ScratchlistEntry, choice: ScratchlistRestoreChoice = .append) async -> Bool {
        guard !scratchlistBusy, !isSending, !queuedScratchlistEntries.contains(entry.entryId) else { return false }
        scratchlistBusy = true
        defer { scratchlistBusy = false }
        scratchlistError = nil
        if choice == .parkCurrent, hasComposerDraft {
            guard await parkCurrentDraft() else { return false }
            guard !hasComposerDraft else { return failPark("Your input changed — review it and try again") }
        }
        insertComposerText(entry.text)
        attachments.restoreScratchlist(entry.attachments)
        composerDestination = .chat
        focusComposer()
        return true
    }

    /// Direct queue sends have their own immutable payload; they never consume
    /// the visible composer. Failed retries reuse the exact localId/uploads.
    @discardableResult
    public func queueScratchlistEntry(_ entry: ScratchlistEntry) async -> Bool {
        guard let scratchlist, !scratchlistBusy, !isSending else { return false }
        scratchlistBusy = true
        defer { scratchlistBusy = false }
        scratchlistEntryErrors[entry.entryId] = nil
        if queuedScratchlistEntries.contains(entry.entryId) {
            return await finishScratchlistQueue(entryId: entry.entryId, store: scratchlist)
        }
        do {
            let attempt: ScratchlistQueueAttempt
            let isRetry = scratchlistQueueAttempts[entry.entryId] != nil
            if let previous = scratchlistQueueAttempts[entry.entryId] {
                attempt = previous
            } else {
                let target = try await resolveScratchlistSendTarget(needsUpload: !entry.attachments.isEmpty)
                let staged = try await ScratchlistTransfer.prepareSend(api: api, sourceSessionId: target,
                    targetSessionId: target, snapshot: ScratchlistTransfer.snapshot(entry))
                // Stable across closing/reopening the chat and lost responses:
                // the same saved version cannot be queued twice by a retry.
                attempt = ScratchlistQueueAttempt(entry: entry, localId: "scratchlist-\(entry.entryId)-\(entry.updatedAt)",
                    target: target, attachments: staged)
                scratchlistQueueAttempts[entry.entryId] = attempt
            }
            isSending = true
            let acceptedTarget = await performSend(text: attempt.entry.text, localId: attempt.localId, createdAt: now(),
                deliveryMode: .queue, attachments: attempt.attachments.isEmpty ? nil : attempt.attachments,
                scheduledAt: nil, isRetry: isRetry, targetSessionId: attempt.target)
            guard let acceptedTarget else {
                scratchlistEntryErrors[entry.entryId] = "Couldn't queue the draft — retry"
                return false
            }
            scratchlistSendTarget = acceptedTarget
            queuedScratchlistEntries.insert(entry.entryId)
            let removed = await finishScratchlistQueue(entryId: entry.entryId, store: scratchlist)
            composerDestination = .chat
            emit(.notice(removed ? "Draft added to the send queue" : "Already queued — couldn't remove the draft. Retry removal only."))
            navigateAfterScratchlistSend()
            return removed
        } catch {
            scratchlistEntryErrors[entry.entryId] = "Couldn't prepare the attachments — retry or remove the failed files"
            return false
        }
    }

    private func finishScratchlistQueue(entryId: String, store: any SessionScratchlistStoring) async -> Bool {
        let removed = await store.deleteEntry(sessionId: scratchlistSendTarget ?? sessionId, entryId: entryId)
        if removed {
            scratchlistQueueAttempts[entryId] = nil
            queuedScratchlistEntries.remove(entryId)
            scratchlistEntryErrors[entryId] = nil
        } else {
            scratchlistEntryErrors[entryId] = "Already queued — couldn't remove the draft. Retry removal only."
        }
        return removed
    }

    private func resolveScratchlistSendTarget(needsUpload: Bool) async throws -> String {
        if let scratchlistSendTarget { return scratchlistSendTarget }
        guard needsUpload, !currentSessionState().active else { return sessionId }
        let target = try await api.resumeSession(id: sessionId, permissionMode: sessionStore.detail(for: sessionId)?.permissionMode)
        scratchlistSendTarget = target
        sessionStore.updateDetailLocal(sessionId) { $0.active = true }
        sessionStore.scheduleRefresh()
        if target != sessionId {
            await windows.seed(fromSessionId: sessionId, toSessionId: target)
            drafts?.move(fromSessionId: sessionId, toSessionId: target)
        }
        return target
    }

    private func navigateAfterScratchlistSend() {
        if let target = scratchlistSendTarget, target != sessionId { emit(.sessionSuperseded(sessionId: target)) }
    }

    private func sendComposerWithScratchlistAttachments(steer: Bool) {
        let text = composerText
        let snapshot = attachments.snapshot
        isSending = true
        Task {
            defer { isSending = false }
            do {
                let target = try await resolveScratchlistSendTarget(needsUpload: true)
                let staged = try await ScratchlistTransfer.prepareSend(api: api, sourceSessionId: target,
                    targetSessionId: target, snapshot: snapshot)
                guard composerText == text, attachments.snapshot == snapshot, !attachments.hasUnsettled else {
                    for (source, staged) in zip(snapshot, staged) {
                        if case .scratchlist = source.source { _ = try? await api.deleteUpload(sessionId: target, path: staged.path) }
                    }
                    scratchlistError = "Your input changed — review it and try again"
                    scratchlistErrorDestination = .chat
                    return
                }
                setComposerText("")
                attachments.consumePrepared(snapshot)
                _ = await performSend(text: text, localId: makeLocalId(), createdAt: now(), deliveryMode: steer ? .steer : .queue,
                    attachments: staged, scheduledAt: nil, isRetry: false, targetSessionId: target)
                navigateAfterScratchlistSend()
            } catch {
                scratchlistError = "Couldn't prepare the attachments — retry or remove the failed files"
                scratchlistErrorDestination = .chat
            }
        }
    }

    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private static func trimmingTrailingWhitespace(_ text: String) -> String {
        guard let last = text.lastIndex(where: { !$0.isWhitespace }) else { return "" }
        return String(text[...last])
    }
}
