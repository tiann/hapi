import Foundation

/// Summary-side patch path — faithful port of the web reference:
/// derivations from `shared/src/sessionSummary.ts` (`computePendingRequests*`,
/// `computeTodoProgress`, `toSessionSummary`) and the list-cache patch rules
/// from `web/src/hooks/useSSE.ts` (`patchSessionSummary`,
/// `isRenderIrrelevantPatch`, `sameSessionSummaryMetadata`,
/// `canApplyVersionedSummaryPatch`). Mirrors the Android reference port
/// (`app.hapi.protocol.wire.SummaryPatching`) case for case.
///
/// ## `>=` vs the detail path's strict `>` (deliberate, replicated divergence)
///
/// The detail path (`applySessionDetailPatch(session:patch:)`) gates versioned
/// sub-patches with **strictly greater** versions. The web summary path —
/// replicated here — accepts **greater-or-equal**: re-deriving the summary
/// fields (`todoProgress`, `pendingRequests*`, projected metadata) from an
/// equal-version `value` is idempotent, because the summary stores only
/// derivations of the value, never the value itself. Applying the same version
/// twice recomputes the same numbers; the strict gate matters only where the
/// raw value is cached (a stale equal-version `agentState` replayed into the
/// *detail* cache could resurrect resolved permission requests).
/// `docs/api/client-contract/sse.md#versioned-patch-algorithm` documents both.
public enum SummaryPatching {

    /// Cap on `pendingRequests` carried in `SessionSummary`
    /// (`PENDING_REQUEST_SUMMARY_CAP`). `pendingRequestsCount` stays the
    /// authoritative total; the capped slice is per-row hover/badge copy.
    public static let pendingRequestSummaryCap = SessionSummary.pendingRequestSummaryCap

    /// `INPUT_REQUEST_TOOLS` — tools that ask the operator, not for permission.
    private static let inputRequestTools: Set<String> = [
        "AskUserQuestion",
        "ask_user_question",
        "ExitPlanMode",
        "exit_plan_mode",
        "request_user_input",
    ]

    private static func classifyKind(tool: String) -> PendingRequestKind {
        inputRequestTools.contains(tool) ? .input : .permission
    }

    // MARK: - Derivations (shared/src/sessionSummary.ts)

    /// `computePendingRequestKinds`: deduplicated kinds; when both are present
    /// the canonical order is `[permission, input]`. (The TS version keeps
    /// Set-insertion order otherwise, which for a single deduplicated kind is
    /// just that kind — so an explicit two-flag scan is order-equivalent and
    /// sidesteps Swift's unordered `Dictionary`/`Set` iteration.)
    public static func computePendingRequestKinds(_ agentState: AgentState?) -> [PendingRequestKind] {
        guard let requests = agentState?.requests else { return [] }
        var hasPermission = false
        var hasInput = false
        for request in requests.values {
            switch classifyKind(tool: request.tool) {
            case .permission: hasPermission = true
            case .input: hasInput = true
            }
        }
        switch (hasPermission, hasInput) {
        case (true, true): return [.permission, .input]
        case (true, false): return [.permission]
        case (false, true): return [.input]
        case (false, false): return []
        }
    }

    /// `computePendingRequests`: oldest-first (by `since`, then id) capped
    /// slice. `fallbackSince` (typically the session's `updatedAt`)
    /// substitutes for requests stored without `createdAt`. The (since, id)
    /// sort is total for unique ids, so Swift's unordered `Dictionary`
    /// iteration cannot change the result.
    public static func computePendingRequests(
        _ agentState: AgentState?,
        fallbackSince: Int,
        cap: Int = pendingRequestSummaryCap
    ) -> [PendingRequest] {
        guard let requests = agentState?.requests else { return [] }
        var items = requests.map { id, request in
            PendingRequest(
                id: id,
                kind: classifyKind(tool: request.tool),
                tool: request.tool,
                since: request.createdAt ?? fallbackSince
            )
        }
        items.sort { lhs, rhs in
            if lhs.since != rhs.since { return lhs.since < rhs.since }
            return lhs.id < rhs.id
        }
        return cap >= items.count ? items : Array(items.prefix(max(0, cap)))
    }

    /// `computePendingRequestsCount` — the authoritative (uncapped) total.
    public static func computePendingRequestsCount(_ agentState: AgentState?) -> Int {
        agentState?.requests?.count ?? 0
    }

    /// `computeTodoProgress`: `nil` for absent/empty todos.
    public static func computeTodoProgress(_ todos: [TodoItem]?) -> TodoProgress? {
        guard let todos, !todos.isEmpty else { return nil }
        return TodoProgress(
            completed: todos.lazy.filter { $0.status == .completed }.count,
            total: todos.count
        )
    }

    /// `getSummaryAgentSessionId`: with a known flavor, only that flavor's id
    /// field counts (trimmed, blank ⇒ nil). The legacy fallback chain (raw,
    /// untrimmed, `pi` excluded — replicated) applies only when the flavor is
    /// missing or unknown.
    private static func summaryAgentSessionId(_ metadata: SessionMetadata) -> String? {
        if let flavor = metadata.flavor, AgentFlavor(rawValue: flavor).isKnown {
            let flavorSessionId: String?
            switch AgentFlavor(rawValue: flavor) {
            case .claude: flavorSessionId = metadata.claudeSessionId
            case .codex: flavorSessionId = metadata.codexSessionId
            case .dsh: flavorSessionId = nil
            case .gemini: flavorSessionId = metadata.geminiSessionId
            case .opencode: flavorSessionId = metadata.opencodeSessionId
            case .grok: flavorSessionId = metadata.grokSessionId
            case .agy: flavorSessionId = metadata.agySessionId
            case .cursor: flavorSessionId = metadata.cursorSessionId
            case .kimi: flavorSessionId = metadata.kimiSessionId
            case .copilot: flavorSessionId = metadata.copilotSessionId
            case .pi: flavorSessionId = metadata.piSessionId
            case .other: flavorSessionId = nil
            }
            let trimmed = flavorSessionId?.trimmingCharacters(in: .whitespacesAndNewlines)
            return (trimmed?.isEmpty == false) ? trimmed : nil
        }
        // First non-nil, raw/untrimmed — written as a loop because the
        // 9-deep `??` chain exceeded the Swift 6 type-checker budget.
        let legacyFallbacks: [String?] = [
            metadata.codexSessionId,
            metadata.claudeSessionId,
            metadata.geminiSessionId,
            metadata.opencodeSessionId,
            metadata.grokSessionId,
            metadata.agySessionId,
            metadata.cursorSessionId,
            metadata.kimiSessionId,
            metadata.copilotSessionId,
        ]
        return legacyFallbacks.compactMap { $0 }.first
    }

    /// `toSessionSummaryMetadata` — list-sized projection of full metadata.
    public static func toSessionSummaryMetadata(_ metadata: SessionMetadata?) -> SessionSummaryMetadata? {
        guard let metadata else { return nil }
        return SessionSummaryMetadata(
            name: metadata.name,
            path: metadata.path,
            machineId: metadata.machineId,
            summary: metadata.summary.map { SessionSummaryMetadata.Summary(text: $0.text) },
            flavor: metadata.flavor,
            worktree: metadata.worktree,
            agentSessionId: summaryAgentSessionId(metadata),
            lifecycleState: metadata.lifecycleState,
            hapiMcpUrl: metadata.hapiMcpUrl
        )
    }

    /// `toSessionSummary`: project a full `Session` (SSE full-session payload)
    /// into a list row. `futureScheduledMessageCount`/`nextScheduledAt` are
    /// hub-computed from the message table and NOT derivable from a `Session`
    /// — they project to 0/nil; the caller preserves the previous row's values
    /// (`upsertSessionSummary` in the web reference does exactly that).
    public static func toSessionSummary(_ session: Session) -> SessionSummary {
        SessionSummary(
            id: session.id,
            active: session.active,
            thinking: session.thinking,
            activeAt: session.activeAt,
            updatedAt: session.updatedAt,
            pinned: session.pinned ?? false,
            globalPinned: session.globalPinned ?? false,
            metadata: toSessionSummaryMetadata(session.metadata),
            metadataVersion: session.metadataVersion,
            agentStateVersion: session.agentStateVersion,
            todosUpdatedAt: session.todosUpdatedAt ?? 0,
            todoProgress: computeTodoProgress(session.todos),
            pendingRequestsCount: computePendingRequestsCount(session.agentState),
            pendingRequestKinds: computePendingRequestKinds(session.agentState),
            pendingRequests: computePendingRequests(session.agentState, fallbackSince: session.updatedAt),
            backgroundTaskCount: session.backgroundTaskCount ?? 0,
            futureScheduledMessageCount: 0,
            nextScheduledAt: nil,
            model: session.model,
            modelReasoningEffort: session.modelReasoningEffort,
            effort: session.effort
        )
    }

    // MARK: - Patch rules (web/src/hooks/useSSE.ts)

    /// Apply a `SessionPatch` to a list row — the pure core of the web's
    /// `patchSessionSummary`. Always returns the patched summary; the caller
    /// decides whether to keep the old row via
    /// ``isRenderIrrelevantPatch(current:next:)`` (the keep-alive
    /// suppression) and re-sorts.
    ///
    /// - Flat fields: last-write-wins when present; a present-`null`
    ///   `model`/`modelReasoningEffort`/`effort` clears. (The web's
    ///   `patch.backgroundTaskCount ?? 0` fallback guards a present-
    ///   `undefined` that the strict wire schema cannot produce; absent ⇒
    ///   keep, exactly what `Int?` encodes.)
    /// - `updatedAt`: max-monotonic — stale versioned-patch replays must not
    ///   move the list clock backward.
    /// - Versioned fields gate against THIS summary's watermarks with `>=`
    ///   (see the type doc for why equality is safe here and only here), then
    ///   recompute the derived fields. `pendingRequests`' fallback `since` is
    ///   the summary's post-patch `updatedAt`, matching the reference.
    /// - `teamState` is a summary no-op (not rendered on the list).
    /// - `activeTurnStartedAt` / `scratchlistUpdatedAt` / `serviceTier` /
    ///   `permissionMode` / `collaborationMode` / `copilotAgentMode` have no
    ///   summary counterpart — ignored, like the reference.
    public static func applySessionSummaryPatch(
        _ current: SessionSummary,
        _ patch: SessionPatch
    ) -> SessionSummary {
        var next = current
        next.active = patch.active ?? current.active
        next.thinking = patch.thinking ?? current.thinking
        next.activeAt = patch.activeAt ?? current.activeAt
        next.updatedAt = patch.updatedAt.map { max(current.updatedAt, $0) } ?? current.updatedAt
        next.backgroundTaskCount = patch.backgroundTaskCount ?? current.backgroundTaskCount
        if let field = patch.model { next.model = field.wireValue }
        if let field = patch.modelReasoningEffort { next.modelReasoningEffort = field.wireValue }
        if let field = patch.effort { next.effort = field.wireValue }

        // Gate versioned fields against THIS summary's watermarks — not the
        // detail cache (global SSE covers every session; requiring detail
        // would force O(N) list refetches). Compared against `current`, like
        // the reference (`next` carries the same watermark values anyway).
        if let todos = patch.todos, todos.version >= current.todosUpdatedAt {
            next.todoProgress = computeTodoProgress(todos.value)
            next.todosUpdatedAt = todos.version
        }
        if let agentState = patch.agentState, agentState.version >= current.agentStateVersion {
            next.pendingRequestsCount = computePendingRequestsCount(agentState.value)
            next.pendingRequestKinds = computePendingRequestKinds(agentState.value)
            next.pendingRequests = computePendingRequests(agentState.value, fallbackSince: next.updatedAt)
            next.agentStateVersion = agentState.version
        }
        if let metadata = patch.metadata, metadata.version >= current.metadataVersion {
            next.metadata = toSessionSummaryMetadata(metadata.value)
            next.metadataVersion = metadata.version
        }
        return next
    }

    /// `sameSessionSummaryMetadata`: true when the two projections render the
    /// same list row. Deliberately partial, like the reference — `hapiMcpUrl`
    /// is not compared (nothing on the list renders it; a real metadata
    /// change still surfaces through the `metadataVersion` check in
    /// ``isRenderIrrelevantPatch(current:next:)``).
    public static func sameSessionSummaryMetadata(
        _ current: SessionSummaryMetadata?,
        _ next: SessionSummaryMetadata?
    ) -> Bool {
        guard let current, let next else { return current == nil && next == nil }
        if current.name != next.name { return false }
        if current.path != next.path { return false }
        if current.machineId != next.machineId { return false }
        if current.summary?.text != next.summary?.text { return false }
        if current.flavor != next.flavor { return false }
        if current.agentSessionId != next.agentSessionId { return false }
        if current.lifecycleState != next.lifecycleState { return false }
        if current.worktree?.basePath != next.worktree?.basePath { return false }
        if current.worktree?.branch != next.worktree?.branch { return false }
        if current.worktree?.name != next.worktree?.name { return false }
        if current.worktree?.worktreePath != next.worktree?.worktreePath { return false }
        if current.worktree?.createdAt != next.worktree?.createdAt { return false }
        return true
    }

    /// `isRenderIrrelevantPatch`: true when the only difference between the
    /// pre- and post-patch summaries is `activeAt` — the CLI keep-alive
    /// re-broadcasts a full patch ~every 10 s per active session with only
    /// `activeAt` moving, and nothing on the list renders `activeAt`. The
    /// store keeps the previous row (and skips the re-sort) in that case.
    ///
    /// Port notes: `pendingRequests` compares id/kind/tool but NOT `since`
    /// (replicated — `since` only affects hover copy through the same
    /// requests). `pinned`/`globalPinned` are intentionally absent, matching
    /// the reference (patches never carry them; pin flips arrive as full
    /// sessions or REST refetches). Swift's `String?` collapses the TS
    /// `undefined !== null` distinction for `modelReasoningEffort`; the only
    /// effect is suppressing a re-render that stores an equal-rendering value.
    public static func isRenderIrrelevantPatch(current: SessionSummary, next: SessionSummary) -> Bool {
        if current.active != next.active { return false }
        if current.thinking != next.thinking { return false }
        if current.updatedAt != next.updatedAt { return false }
        if current.backgroundTaskCount != next.backgroundTaskCount { return false }
        if current.model != next.model { return false }
        if current.modelReasoningEffort != next.modelReasoningEffort { return false }
        if current.effort != next.effort { return false }
        if current.pendingRequestsCount != next.pendingRequestsCount { return false }
        // Structured SSE patches (#897) can move these without touching the
        // keep-alive fields above; omit them and a todos/metadata/agentState
        // patch would be dropped as "activeAt-only" churn.
        if current.todoProgress != next.todoProgress { return false }
        if current.pendingRequestKinds != next.pendingRequestKinds { return false }
        if current.pendingRequests.count != next.pendingRequests.count { return false }
        for (lhs, rhs) in zip(current.pendingRequests, next.pendingRequests) {
            if lhs.id != rhs.id || lhs.kind != rhs.kind || lhs.tool != rhs.tool { return false }
        }
        if !sameSessionSummaryMetadata(current.metadata, next.metadata) { return false }
        if current.metadataVersion != next.metadataVersion { return false }
        if current.agentStateVersion != next.agentStateVersion { return false }
        if current.todosUpdatedAt != next.todosUpdatedAt { return false }
        return true
    }

    /// `canApplyVersionedSummaryPatch` — the old "detail required" gate.
    ///
    /// The reference keeps it only for unit tests of the pre-watermark rule;
    /// the live summary path gates against the summary's own watermarks
    /// instead (``applySessionSummaryPatch(_:_:)``). `teamState` never
    /// blocks: it is not rendered on the list.
    @available(
        *, deprecated,
        message: "Gate against SessionSummary watermarks (applySessionSummaryPatch); kept only to pin the legacy rule, mirroring the web reference."
    )
    public static func canApplyVersionedSummaryPatch(patch: SessionPatch, detailPresent: Bool) -> Bool {
        if patch.metadata == nil && patch.agentState == nil && patch.todos == nil {
            return true
        }
        return detailPresent
    }
}
