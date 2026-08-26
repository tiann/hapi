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
///   ``setEffort(_:)``/``loadModelOptions()``): catalog pickers with
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
        guard !isSending else { return }
        if attachments.hasUnsettled {
            emit(.notice("Attachments are still uploading — wait, or retry/remove the failed ones"))
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

    private func performSend(
        text: String,
        localId: String,
        createdAt: Int,
        deliveryMode: MessageDeliveryMode,
        attachments: [AttachmentMetadata]?,
        scheduledAt: Int?,
        isRetry: Bool
    ) async {
        defer { isSending = false }
        let store = await windowController()
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
            try await api.sendMessage(sessionId: sessionId, request)
            await store.updateStatus(localId: localId, status: successStatus())
        } catch let error as APIError where error.status == 409 && error.code == "session_inactive" {
            await resumeAndRetry(store: store, request: request, localId: localId)
        } catch {
            await store.updateStatus(localId: localId, status: .failed)
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
        localId: String
    ) async {
        let targetSessionId: String
        do {
            targetSessionId = try await api.resumeSession(
                id: sessionId,
                permissionMode: sessionStore.detail(for: sessionId)?.permissionMode
            )
        } catch {
            await store.updateStatus(localId: localId, status: .failed)
            emit(.notice("Session is inactive and could not be resumed"))
            return
        }

        let optimisticRow = await store.state.messages.first { $0.localId == localId }
        var targetStore = store
        if targetSessionId != sessionId {
            await windows.seed(fromSessionId: sessionId, toSessionId: targetSessionId)
            targetStore = await windows.open(sessionId: targetSessionId)
            if let optimisticRow {
                // Seeding copies rows across, but make the hand-off explicit:
                // the pending row must live in the target window only.
                await targetStore.appendOptimistic(optimisticRow)
                await store.removeMessage(localIdOrId: localId)
            }
            drafts?.move(fromSessionId: sessionId, toSessionId: targetSessionId)
        }

        // Resume succeeded: reflect activity locally, refresh the list row.
        sessionStore.updateDetailLocal(sessionId) { $0.active = true }
        sessionStore.scheduleRefresh()

        do {
            try await api.sendMessage(sessionId: targetSessionId, request)
            await targetStore.updateStatus(localId: localId, status: successStatus())
        } catch {
            await targetStore.updateStatus(localId: localId, status: .failed)
        }
        if targetSessionId != sessionId {
            emit(.sessionSuperseded(sessionId: targetSessionId))
        }
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

    /// Scratchlist "Park current draft": the composer draft becomes a
    /// scratchlist entry and the composer clears (store-optimistic; the
    /// composer clears only after the hub accepts, so a failed park cannot
    /// lose the draft).
    public func parkComposerDraft() {
        guard let scratchlist else { return }
        let text = composerText
        guard !Self.isBlank(text) else { return }
        Task { [weak self] in
            guard let self else { return }
            switch await scratchlist.createEntry(sessionId: self.sessionId, text: text) {
            case .created:
                // Clear only when the draft is still what we parked (the
                // operator may have kept typing while the POST ran).
                if self.composerText == text {
                    self.setComposerText("")
                }
                self.emit(.notice("Draft parked to scratchlist"))
            case .atCap:
                self.emit(.notice("Scratchlist is full (200 entries)"))
            case .failed:
                self.emit(.notice("Couldn't park the draft — check the hub connection"))
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
