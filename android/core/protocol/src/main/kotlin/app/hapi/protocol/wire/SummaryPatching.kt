package app.hapi.protocol.wire

import app.hapi.protocol.catalog.AgentFlavor
import kotlin.math.max

/**
 * Summary-side patch path — faithful port of the web reference:
 * derivations from `shared/src/sessionSummary.ts` (`computePendingRequests*`,
 * `computeTodoProgress`, `toSessionSummary`) and the list-cache patch rules
 * from `web/src/hooks/useSSE.ts` (`patchSessionSummary`,
 * `isRenderIrrelevantPatch`, `sameSessionSummaryMetadata`,
 * `canApplyVersionedSummaryPatch`).
 *
 * ## `>=` vs the detail path's strict `>` (deliberate, replicated divergence)
 *
 * The detail path (`app.hapi.protocol.patch.applySessionDetailPatch`) gates
 * versioned sub-patches with **strictly greater** versions. The web summary
 * path — replicated here — accepts **greater-or-equal**: re-deriving the
 * summary fields (`todoProgress`, `pendingRequests*`, projected metadata)
 * from an equal-version `value` is idempotent, because the summary stores only
 * derivations of the value, never the value itself. Applying the same version
 * twice recomputes the same numbers; the strict gate matters only where the
 * raw value is cached (a stale equal-version `agentState` replayed into the
 * *detail* cache could resurrect resolved permission requests).
 * `docs/api/client-contract/sse.md#versioned-patch-algorithm` documents both.
 */
object SummaryPatching {

    /**
     * Cap on `pendingRequests` carried in `SessionSummary`
     * (`PENDING_REQUEST_SUMMARY_CAP`). `pendingRequestsCount` stays the
     * authoritative total; the capped slice is per-row hover/badge copy.
     */
    const val PENDING_REQUEST_SUMMARY_CAP: Int = 5

    const val KIND_PERMISSION: String = "permission"
    const val KIND_INPUT: String = "input"

    /** `INPUT_REQUEST_TOOLS` — tools that ask the operator, not for permission. */
    private val INPUT_REQUEST_TOOLS = setOf(
        "AskUserQuestion",
        "ask_user_question",
        "ExitPlanMode",
        "exit_plan_mode",
        "request_user_input",
    )

    private fun classifyKind(tool: String): String =
        if (tool in INPUT_REQUEST_TOOLS) KIND_INPUT else KIND_PERMISSION

    // ------------------------------------------------------- derivations --

    /**
     * `computePendingRequestKinds`: deduplicated kinds; when both are present
     * the canonical order is `[permission, input]`, otherwise insertion order
     * (which for a single kind is just that kind).
     */
    fun computePendingRequestKinds(agentState: AgentState?): List<String> {
        val requests = agentState?.requests ?: return emptyList()
        val kinds = LinkedHashSet<String>()
        for (request in requests.values) {
            kinds.add(classifyKind(request.tool))
        }
        return if (KIND_PERMISSION in kinds && KIND_INPUT in kinds) {
            listOf(KIND_PERMISSION, KIND_INPUT)
        } else {
            kinds.toList()
        }
    }

    /**
     * `computePendingRequests`: oldest-first (by `since`, then id) capped
     * slice. [fallbackSince] (typically the session's `updatedAt`) substitutes
     * for requests stored without `createdAt`.
     */
    fun computePendingRequests(
        agentState: AgentState?,
        fallbackSince: Long,
        cap: Int = PENDING_REQUEST_SUMMARY_CAP,
    ): List<PendingRequest> {
        val requests = agentState?.requests ?: return emptyList()
        val items = requests.map { (id, request) ->
            PendingRequest(
                id = id,
                kind = classifyKind(request.tool),
                tool = request.tool,
                since = request.createdAt ?: fallbackSince,
            )
        }.sortedWith(compareBy({ it.since }, { it.id }))
        return if (cap >= items.size) items else items.take(max(0, cap))
    }

    /** `computePendingRequestsCount` — the authoritative (uncapped) total. */
    fun computePendingRequestsCount(agentState: AgentState?): Int =
        agentState?.requests?.size ?: 0

    /** `computeTodoProgress`: null for absent/empty todos. */
    fun computeTodoProgress(todos: List<TodoItem>?): TodoProgress? {
        if (todos.isNullOrEmpty()) return null
        return TodoProgress(
            completed = todos.count { it.status == "completed" },
            total = todos.size,
        )
    }

    /**
     * `getSummaryAgentSessionId`: with a known flavor, only that flavor's id
     * field counts (trimmed, blank ⇒ null). The legacy fallback chain (raw,
     * untrimmed, `pi` excluded — replicated) applies only when the flavor is
     * missing or unknown.
     */
    private fun summaryAgentSessionId(metadata: SessionMetadata): String? {
        val flavor = metadata.flavor
        if (AgentFlavor.isKnown(flavor)) {
            val flavorSessionId = when (flavor) {
                "claude" -> metadata.claudeSessionId
                "codex" -> metadata.codexSessionId
                "gemini" -> metadata.geminiSessionId
                "opencode" -> metadata.opencodeSessionId
                "grok" -> metadata.grokSessionId
                "agy" -> metadata.agySessionId
                "cursor" -> metadata.cursorSessionId
                "kimi" -> metadata.kimiSessionId
                "copilot" -> metadata.copilotSessionId
                "pi" -> metadata.piSessionId
                else -> null
            }
            return flavorSessionId?.trim()?.takeIf { it.isNotEmpty() }
        }
        return metadata.codexSessionId
            ?: metadata.claudeSessionId
            ?: metadata.geminiSessionId
            ?: metadata.opencodeSessionId
            ?: metadata.grokSessionId
            ?: metadata.agySessionId
            ?: metadata.cursorSessionId
            ?: metadata.kimiSessionId
            ?: metadata.copilotSessionId
    }

    /** `toSessionSummaryMetadata` — list-sized projection of full metadata. */
    fun toSessionSummaryMetadata(metadata: SessionMetadata?): SessionSummaryMetadata? {
        if (metadata == null) return null
        return SessionSummaryMetadata(
            name = metadata.name,
            path = metadata.path,
            machineId = metadata.machineId,
            summary = metadata.summary?.let { SummaryText(it.text) },
            flavor = metadata.flavor,
            worktree = metadata.worktree,
            agentSessionId = summaryAgentSessionId(metadata),
            lifecycleState = metadata.lifecycleState,
            hapiMcpUrl = metadata.hapiMcpUrl,
        )
    }

    /**
     * `toSessionSummary`: project a full [Session] (SSE full-session payload)
     * into a list row. `futureScheduledMessageCount`/`nextScheduledAt` are
     * hub-computed from the message table and NOT derivable from a `Session` —
     * they project to 0/null; the caller preserves the previous row's values
     * (`upsertSessionSummary` in the web reference does exactly that).
     */
    fun toSessionSummary(session: Session): SessionSummary = SessionSummary(
        id = session.id,
        active = session.active,
        thinking = session.thinking,
        activeAt = session.activeAt,
        updatedAt = session.updatedAt,
        pinned = session.pinned ?: false,
        globalPinned = session.globalPinned ?: false,
        metadata = toSessionSummaryMetadata(session.metadata),
        metadataVersion = session.metadataVersion,
        agentStateVersion = session.agentStateVersion,
        todosUpdatedAt = session.todosUpdatedAt ?: 0,
        todoProgress = computeTodoProgress(session.todos),
        pendingRequestsCount = computePendingRequestsCount(session.agentState),
        pendingRequestKinds = computePendingRequestKinds(session.agentState),
        pendingRequests = computePendingRequests(session.agentState, session.updatedAt),
        backgroundTaskCount = session.backgroundTaskCount ?: 0,
        futureScheduledMessageCount = 0,
        nextScheduledAt = null,
        model = session.model,
        modelReasoningEffort = session.modelReasoningEffort,
        effort = session.effort,
    )

    // ------------------------------------------------------- patch rules --

    /**
     * Apply a [SessionPatch] to a list row — the pure core of the web's
     * `patchSessionSummary`. Always returns the patched summary; the caller
     * decides whether to keep the old object via [isRenderIrrelevantPatch]
     * (the keep-alive suppression) and re-sorts.
     *
     * - Flat fields: last-write-wins when present; a present-`null`
     *   `model`/`modelReasoningEffort`/`effort` clears. (The web's
     *   `patch.backgroundTaskCount ?? 0` fallback guards a present-`undefined`
     *   that the strict wire schema cannot produce; absent ⇒ keep.)
     * - `updatedAt`: max-monotonic — stale versioned-patch replays must not
     *   move the list clock backward.
     * - Versioned fields gate against THIS summary's watermarks with `>=`
     *   (see the class doc for why equality is safe here and only here), then
     *   recompute the derived fields. `pendingRequests`' fallback `since` is
     *   the summary's post-patch `updatedAt`, matching the reference.
     * - `teamState` is a summary no-op (not rendered on the list).
     * - `activeTurnStartedAt` / `scratchlistUpdatedAt` / `serviceTier` /
     *   `permissionMode` / `collaborationMode` / `copilotAgentMode` have no
     *   summary counterpart — ignored, like the reference.
     */
    fun applySessionSummaryPatch(current: SessionSummary, patch: SessionPatch): SessionSummary {
        var next = current.copy(
            active = patch.active ?: current.active,
            thinking = patch.thinking ?: current.thinking,
            activeAt = patch.activeAt ?: current.activeAt,
            updatedAt = patch.updatedAt?.let { max(current.updatedAt, it) } ?: current.updatedAt,
            backgroundTaskCount = patch.backgroundTaskCount ?: current.backgroundTaskCount,
            model = when (val model = patch.model) {
                is OptionalField.Present -> model.value
                OptionalField.Absent -> current.model
            },
            modelReasoningEffort = when (val value = patch.modelReasoningEffort) {
                is OptionalField.Present -> value.value
                OptionalField.Absent -> current.modelReasoningEffort
            },
            effort = when (val effort = patch.effort) {
                is OptionalField.Present -> effort.value
                OptionalField.Absent -> current.effort
            },
        )

        // Gate versioned fields against THIS summary's watermarks — not the
        // detail cache (global SSE covers every session; requiring detail
        // would force O(N) list refetches). Compared against `current`, like
        // the reference (`next` carries the same watermark values anyway).
        patch.todos?.let { todos ->
            if (todos.version >= current.todosUpdatedAt) {
                next = next.copy(
                    todoProgress = computeTodoProgress(todos.value),
                    todosUpdatedAt = todos.version,
                )
            }
        }
        patch.agentState?.let { agentState ->
            if (agentState.version >= current.agentStateVersion) {
                next = next.copy(
                    pendingRequestsCount = computePendingRequestsCount(agentState.value),
                    pendingRequestKinds = computePendingRequestKinds(agentState.value),
                    pendingRequests = computePendingRequests(agentState.value, next.updatedAt),
                    agentStateVersion = agentState.version,
                )
            }
        }
        patch.metadata?.let { metadata ->
            if (metadata.version >= current.metadataVersion) {
                next = next.copy(
                    metadata = toSessionSummaryMetadata(metadata.value),
                    metadataVersion = metadata.version,
                )
            }
        }
        return next
    }

    /**
     * `sameSessionSummaryMetadata`: true when the two projections render the
     * same list row. Deliberately partial, like the reference — `hapiMcpUrl`
     * is not compared (nothing on the list renders it; a real metadata change
     * still surfaces through the `metadataVersion` check in
     * [isRenderIrrelevantPatch]).
     */
    fun sameSessionSummaryMetadata(
        current: SessionSummaryMetadata?,
        next: SessionSummaryMetadata?,
    ): Boolean {
        if (current === next) return true
        if (current == null || next == null) return current == null && next == null
        return current.name == next.name
            && current.path == next.path
            && current.machineId == next.machineId
            && current.summary?.text == next.summary?.text
            && current.flavor == next.flavor
            && current.agentSessionId == next.agentSessionId
            && current.lifecycleState == next.lifecycleState
            && current.worktree?.basePath == next.worktree?.basePath
            && current.worktree?.branch == next.worktree?.branch
            && current.worktree?.name == next.worktree?.name
            && current.worktree?.worktreePath == next.worktree?.worktreePath
            && current.worktree?.createdAt == next.worktree?.createdAt
    }

    /**
     * `isRenderIrrelevantPatch`: true when the only difference between the
     * pre- and post-patch summaries is `activeAt` — the CLI keep-alive
     * re-broadcasts a full patch ~every 10 s per active session with only
     * `activeAt` moving, and nothing on the list renders `activeAt`. The
     * store keeps the previous object (and skips the re-sort) in that case.
     *
     * Port notes: `pendingRequests` compares id/kind/tool but NOT `since`
     * (replicated — `since` only affects hover copy through the same
     * requests). `pinned`/`globalPinned` are intentionally absent, matching
     * the reference (patches never carry them; pin flips arrive as full
     * sessions or REST refetches). Kotlin collapses the TS
     * `undefined !== null` distinction for `modelReasoningEffort`; the only
     * effect is suppressing a re-render that stores an equal-rendering value.
     */
    fun isRenderIrrelevantPatch(current: SessionSummary, next: SessionSummary): Boolean {
        return current.active == next.active
            && current.thinking == next.thinking
            && current.updatedAt == next.updatedAt
            && current.backgroundTaskCount == next.backgroundTaskCount
            && current.model == next.model
            && current.modelReasoningEffort == next.modelReasoningEffort
            && current.effort == next.effort
            && current.pendingRequestsCount == next.pendingRequestsCount
            // Structured SSE patches (#897) can move these without touching
            // the keep-alive fields above; omit them and a todos/metadata/
            // agentState patch would be dropped as "activeAt-only" churn.
            && current.todoProgress == next.todoProgress
            && current.pendingRequestKinds == next.pendingRequestKinds
            && current.pendingRequests.size == next.pendingRequests.size
            && current.pendingRequests.indices.all { i ->
                val req = current.pendingRequests[i]
                val nextReq = next.pendingRequests[i]
                req.id == nextReq.id && req.kind == nextReq.kind && req.tool == nextReq.tool
            }
            && sameSessionSummaryMetadata(current.metadata, next.metadata)
            && current.metadataVersion == next.metadataVersion
            && current.agentStateVersion == next.agentStateVersion
            && current.todosUpdatedAt == next.todosUpdatedAt
    }

    /**
     * `canApplyVersionedSummaryPatch` — the old "detail required" gate.
     *
     * The reference keeps it only for unit tests of the pre-watermark rule;
     * the live summary path gates against the summary's own watermarks
     * instead ([applySessionSummaryPatch]). `teamState` never blocks: it is
     * not rendered on the list.
     */
    @Deprecated(
        "Gate against SessionSummary watermarks (applySessionSummaryPatch); " +
            "kept only to pin the legacy rule, mirroring the web reference."
    )
    fun canApplyVersionedSummaryPatch(patch: SessionPatch, detailPresent: Boolean): Boolean {
        if (patch.metadata == null && patch.agentState == null && patch.todos == null) {
            return true
        }
        return detailPresent
    }
}
