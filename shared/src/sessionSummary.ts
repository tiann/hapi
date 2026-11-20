import type { AgentState, AttachedJob, ExternalRef, Metadata, Session, TodoItem, WorktreeMetadata } from './schemas'
import type { SessionReadState } from './sessionReadState'
import type { ConversationHistoryCapabilities } from './conversationHistory'
import { isKnownFlavor } from './flavors'
import type { SessionBlockedAck, SessionNotifySignal } from './notifyAttention'
import { requestBlockerKey } from './notifyAttention'
import type { AgentFlavor } from './modes'

export type ForkSessionSummary = {
    text: string
    updatedAt: number
}

/** Seed a fork's generated/native title without claiming manual-name ownership. */
export function buildForkSessionSummary(
    metadata: { name?: string; summary?: { text?: string } | null } | null | undefined,
    updatedAt: number = Date.now()
): ForkSessionSummary | undefined {
    const sourceTitle = metadata?.name?.trim() || metadata?.summary?.text?.trim()
    if (!sourceTitle) return undefined

    return {
        text: `Fork: ${sourceTitle}`,
        updatedAt
    }
}

export type PendingRequestKind = 'permission' | 'input'

/**
 * Requests that are a *question for the operator* rather than a permission to
 * act. `CursorCreatePlan` is Cursor's plan-approval prompt — the direct
 * analogue of Claude's `ExitPlanMode`, and the second most common request tool
 * in the wild (16 occurrences on a 683-session fleet) — so omitting it left
 * every Cursor plan review misclassified as a plain permission.
 */
const INPUT_REQUEST_TOOLS = new Set([
    'AskUserQuestion',
    'ask_user_question',
    'CursorAskQuestion',
    'cursor_ask_question',
    'ExitPlanMode',
    'exit_plan_mode',
    'request_user_input',
    'CursorCreatePlan',
    'cursor_create_plan'
])

/** Cap on `pendingRequests` carried in `SessionSummary`. The list is meant for
 *  per-row hover copy ("Approve `Bash`, `Edit` (+1 more)"); deep inspection
 *  should use `Session.agentState.requests`. The `pendingRequestsCount` field
 *  is the authoritative total — `pendingRequests.length` may be smaller. */
export const PENDING_REQUEST_SUMMARY_CAP = 5

/** Cap on `pendingRequestRefs`: how many pending-request identities the
 *  SUMMARY surfaces for preview/dismissal-matching purposes. NOT a ceiling on
 *  how many requests can exist — `AgentState.requests` is `z.record(...)`
 *  with no `.max()`, so an agent can genuinely hold more than this many
 *  simultaneously pending tool/question requests at once; this just bounds
 *  what one list-row payload carries (#1717 cold-review round 22, corrected
 *  round 24 — see `SUPPORTED_LIVE_DISMISSAL_CAP`, which used to be derived
 *  from this value as if it WERE that ceiling and broke at 202 live
 *  dismissals as a result). */
export const PENDING_REQUEST_REFS_CAP = 200

/**
 * How many dismissal keys `SessionBlockedAck.keys` carries at once, full
 * stop — not derived from, or chasing, any other number (#1717 cold-review
 * rounds 22-25). `AgentState.requests` has no enforced limit, so earlier
 * attempts to derive this from "the true number of concurrent requests"
 * (64, then `PENDING_REQUEST_REFS_CAP + 1` = 201) just relocated the N+1
 * failure every time a bigger real case showed up — most recently at 202,
 * then again at 2001 before this constant stopped being advisory.
 * `serialiseAckKeys` now enforces this as a HARD bound: once every
 * resolved/superseded key is already evicted, it evicts the oldest LIVE
 * ones too rather than growing past it, so the wire schema (bounded by the
 * SAME constant) can never reject a snapshot this hub produced. A dismissal
 * on a request that is still pending can, in the pathological case of more
 * than this many simultaneous live dismissals, eventually be evicted — a
 * documented, bounded trade, not a silent one.
 */
export const SUPPORTED_LIVE_DISMISSAL_CAP = 2_000

export type PendingRequest = {
    id: string
    kind: PendingRequestKind
    tool: string
    /** Epoch ms when the request was raised; falls back to the caller-supplied
     *  `fallbackSince` (typically `session.updatedAt`) for older requests
     *  stored without `createdAt`. */
    since: number
}

/** Whether a request asks the user to answer something (a question, a plan)
 *  or to allow a tool. */
export function classifyKind(tool: string): PendingRequestKind {
    return INPUT_REQUEST_TOOLS.has(tool) ? 'input' : 'permission'
}

export type SessionSummaryMetadata = {
    name?: string
    titleLocked?: boolean
    path: string
    machineId?: string
    summary?: { text: string }
    promptTitle?: string
    flavor?: string | null
    worktree?: WorktreeMetadata
    agentSessionId?: string
    codexImportedAt?: number | null
    lifecycleState?: string
    /** Structured contribution links (GitHub PRs, …). tiann/hapi#1160. */
    externalRefs?: ExternalRef[]
    conversationHistory?: ConversationHistoryCapabilities
    /** Loopback MCP URL when session CLI happy server is running (#956). */
    hapiMcpUrl?: string
    lastModelError?: {
        eventId: string
        kind: string
        transient: boolean
        rawSnippet: string
        atTs: number
        priorAssistantClaimsDone: boolean
        bridgedForEventId?: string
        retriedAndFailed?: boolean
        supersededByUserTurn?: boolean
        bridgeable?: boolean
        acknowledgedAt?: number
        notifiedAt?: number
    }
}

export type SessionSummary = {
    contentRevision?: number
    readState?: SessionReadState
    hasConversationContent?: boolean
    id: string
    active: boolean
    thinking: boolean
    /** False only during the hub's optimistic queue-to-delivery grace window
     *  (#1717 cold-review round 22); see `Session.thinkingConfirmed`. */
    thinkingConfirmed?: boolean
    /** Ordering value for `thinking`/`thinkingConfirmed` (#1717 cold-review
     *  round 26); see `Session.thinkingAt`. Neither field carries its own
     *  revision otherwise, so a REST list GET captured while the agent was
     *  still thinking can land after an SSE idle patch and restore a stale
     *  `thinking: true` — which then hides a genuinely unanswered blocker,
     *  since the attention classifier treats "still thinking" as "nothing to
     *  show yet". Optional so an older hub (no column to read it from) can
     *  omit it; absent on either side, the merge takes the incoming value,
     *  matching today's behaviour. */
    thinkingAt?: number
    /** Monotonic hub-issued counter, bumped on every `thinking`/
     *  `thinkingConfirmed` transition (#1717 cold-review round 27); see
     *  `Session.thinkingRevision`. `thinkingAt` is the CLI's clamped
     *  alive-report time, not a hub-issued revision — two transitions
     *  processed within the same clamped-to-"now" millisecond can carry the
     *  SAME `thinkingAt`, which a strict `>` check on it cannot then tell
     *  apart. This field is the actual ordering value; `thinkingAt` is
     *  carried for display only. Optional for the same reason `thinkingAt`
     *  is — absent on either side, the merge takes the incoming value. */
    thinkingRevision?: number
    activeAt: number
    updatedAt: number
    /** Creation time is the stable order key before the first user message. */
    createdAt?: number
    /** Original timestamp of the latest user message; absent before any input. */
    lastUserMessageAt?: number
    pinned?: boolean
    globalPinned?: boolean
    metadata: SessionSummaryMetadata | null
    /** Watermarks for structured SSE patches (PR #897). List cache must gate
     *  without requiring a detail query — otherwise global SSE forces O(N)
     *  /sessions invalidation for every versioned write. */
    metadataVersion: number
    agentStateVersion: number
    todosUpdatedAt: number
    todoProgress: { completed: number; total: number } | null
    pendingRequestsCount: number
    pendingRequestKinds: PendingRequestKind[]
    /** Capped, oldest-first slice of pending tool requests. Use this for tooltip
     *  / per-row UX. The full count (which may exceed the cap) is in
     *  `pendingRequestsCount`. */
    pendingRequests: PendingRequest[]
    /** Newest request time across ALL pending requests, ignoring the cap above.
     *  Optional so an older hub can omit it. Lets a client tell "every prompt
     *  was acknowledged" from "the acknowledged ones are merely the only ones
     *  the capped slice carried". */
    pendingRequestsNewestAt?: number
    /** Every pending request id, uncapped. `pendingRequests` keeps only the
     *  oldest few, so an overflow prompt had no identity and fell back to a
     *  synthetic one — a dismissal then stopped matching the moment the real
     *  request entered the capped slice. Ids are small; the bodies are not. */
    pendingRequestRefs?: Array<{ id: string; kind: PendingRequestKind; since: number }>
    backgroundTaskCount: number
    /**
     * Hub-derived "open tool work exists in the transcript tail" (work-scoped
     * liveness). True when the hub's sweep found a tool call that started but
     * never settled — the autonomous-round case where `thinking` is false and
     * no background task is declared, yet the agent is demonstrably working.
     * Optional because older hubs never send it.
     */
    derivedToolWork?: boolean
    /** Last `AGENT_NOTIFY_SUMMARY` footer. Orthogonal to `pendingRequestKinds`:
     *  pending requests mean "live, waiting on a click", this means "the turn
     *  ended and the agent said it is stuck". See `./notifyAttention`. */
    lastNotify?: SessionNotifySignal | null
    /** Operator's manual "not blocked" watermark + rationale. */
    blockedAck?: SessionBlockedAck | null
    /** Ordering key for the two fields above; see `Session.notifyUpdatedAt`. */
    notifyUpdatedAt?: number
    futureScheduledMessageCount: number
    /** Epoch ms of the soonest uninvoked future scheduled message, or null. */
    nextScheduledAt: number | null
    /**
     * Primary running session-attached job (tiann/hapi#1404), or null.
     * Independent of agent `active` / thinking — work that outlives the agent.
     */
    attachedJob: AttachedJob | null
    /** Watermark for versioned `attachedJob` SSE patches (dual EventSource race). */
    attachedJobUpdatedAt: number
    model: string | null
    modelReasoningEffort?: string | null
    effort: string | null
}

// Re-exported as a standalone derivation so SSE patch handlers can recompute
// summary fields from a structured `agentState` patch without needing the
// full Session in hand.
export function computePendingRequestKinds(agentState: AgentState | null | undefined): PendingRequestKind[] {
    const requests = agentState?.requests
    if (!requests) {
        return []
    }

    const kinds = new Set<PendingRequestKind>()
    for (const request of Object.values(requests)) {
        kinds.add(classifyKind(request.tool))
    }

    return kinds.has('permission') && kinds.has('input')
        ? ['permission', 'input']
        : Array.from(kinds)
}

export function computePendingRequests(
    agentState: AgentState | null | undefined,
    fallbackSince: number,
    cap: number = PENDING_REQUEST_SUMMARY_CAP
): PendingRequest[] {
    const requests = agentState?.requests
    if (!requests) {
        return []
    }

    const items: PendingRequest[] = []
    for (const [id, request] of Object.entries(requests)) {
        items.push({
            id,
            kind: classifyKind(request.tool),
            tool: request.tool,
            since: typeof request.createdAt === 'number' ? request.createdAt : fallbackSince
        })
    }

    items.sort((a, b) => {
        if (a.since !== b.since) return a.since - b.since
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })

    return cap >= items.length ? items : items.slice(0, cap)
}

export function getPendingRequestKinds(session: Session): PendingRequestKind[] {
    return computePendingRequestKinds(session.agentState)
}

export function getPendingRequests(
    session: Session,
    cap: number = PENDING_REQUEST_SUMMARY_CAP
): PendingRequest[] {
    return computePendingRequests(session.agentState, session.updatedAt, cap)
}

export function computePendingRequestsCount(agentState: AgentState | null | undefined): number {
    return agentState?.requests ? Object.keys(agentState.requests).length : 0
}

/**
 * Newest request time across ALL pending requests, uncapped (0 when none).
 *
 * `pendingRequests` is capped at `PENDING_REQUEST_SUMMARY_CAP` and keeps the
 * OLDEST entries, so once the cap is full the carried slice cannot answer
 * "did anything arrive after the operator dismissed this?" — the newer prompt
 * is simply absent. Computed from `agentState` like `pendingRequestsCount`,
 * so it costs no storage and needs no migration.
 */
/**
 * A light descriptor for EVERY pending request, uncapped (#1717).
 *
 * `pendingRequests` keeps only the oldest few, so a session whose previewed
 * prompts have all been dismissed says nothing about the ones behind them.
 * The id alone was not enough either: the chip read its label and age off
 * aggregate fields that describe all prompts at once, so an overflow question
 * could be drawn as a Permission with another prompt's timestamp. Carrying the
 * kind and `since` with the id keeps the chip, the dismissal target and the
 * age all describing the same request. Same order as `pendingRequests`, so the
 * capped list is always this list's prefix — UNLESS truncation had to choose,
 * in which case the smaller list is still guaranteed to be a SUBSET (see
 * below), just not necessarily a strict prefix.
 *
 * `dismissedKeys` lets truncation prefer an UNDISMISSED request over a
 * dismissed one when there are more than `PENDING_REQUEST_REFS_CAP` pending
 * at once (#1717 cold-review round 23). Without it, truncation is purely
 * oldest-first: if the operator dismisses the oldest 200 of 201 pending
 * requests, the 201st — genuinely unanswered — falls off this list entirely,
 * and `getSessionBlockedState` (which only ever sees THIS list, not the full
 * `agentState`) reads the session as clear.
 */
export function computePendingRequestRefs(
    agentState: AgentState | null | undefined,
    fallbackSince: number,
    dismissedKeys?: ReadonlySet<string>
): Array<{ id: string; kind: PendingRequestKind; since: number }> {
    const all = computePendingRequests(agentState, fallbackSince, Number.MAX_SAFE_INTEGER)
    if (all.length <= PENDING_REQUEST_REFS_CAP || !dismissedKeys || dismissedKeys.size === 0) {
        return all.slice(0, PENDING_REQUEST_REFS_CAP).map(({ id, kind, since }) => ({ id, kind, since }))
    }
    const undismissed = all.filter((request) => !dismissedKeys.has(requestBlockerKey(request.id)))
    const dismissed = all.filter((request) => dismissedKeys.has(requestBlockerKey(request.id)))
    const selectedIds = new Set(
        [...undismissed, ...dismissed].slice(0, PENDING_REQUEST_REFS_CAP).map((request) => request.id)
    )
    // `all` is already oldest-first; filtering it (rather than re-sorting the
    // prioritized selection) keeps the returned order chronological.
    return all
        .filter((request) => selectedIds.has(request.id))
        .map(({ id, kind, since }) => ({ id, kind, since }))
}

export function computePendingRequestsNewestAt(
    agentState: AgentState | null | undefined,
    fallbackSince: number
): number {
    const requests = agentState?.requests
    if (!requests) {
        return 0
    }
    let newest = 0
    for (const request of Object.values(requests)) {
        const since = typeof request.createdAt === 'number' ? request.createdAt : fallbackSince
        if (since > newest) newest = since
    }
    return newest
}

export function computeTodoProgress(todos: TodoItem[] | undefined): SessionSummary['todoProgress'] {
    if (!todos?.length) {
        return null
    }
    return {
        completed: todos.filter((todo) => todo.status === 'completed').length,
        total: todos.length
    }
}

const AGENT_SESSION_ID_FIELD_BY_FLAVOR: Partial<Record<AgentFlavor, keyof Metadata>> = {
    claude: 'claudeSessionId',
    codex: 'codexSessionId',
    gemini: 'geminiSessionId',
    opencode: 'opencodeSessionId',
    grok: 'grokSessionId',
    agy: 'agySessionId',
    cursor: 'cursorSessionId',
    kimi: 'kimiSessionId',
    copilot: 'copilotSessionId',
    pi: 'piSessionId',
    dsh: 'dshSessionId'
}

function getSummaryAgentSessionId(metadata: Metadata): string | undefined {
    const flavor = metadata.flavor
    if (isKnownFlavor(flavor)) {
        const flavorField = AGENT_SESSION_ID_FIELD_BY_FLAVOR[flavor]
        if (!flavorField) return undefined
        const flavorSessionId = metadata[flavorField]
        return typeof flavorSessionId === 'string' && flavorSessionId.trim()
            ? flavorSessionId.trim()
            : undefined
    }

    // Legacy fallback only applies when the stored flavor is missing or unknown.
    return metadata.codexSessionId
        ?? metadata.claudeSessionId
        ?? metadata.geminiSessionId
        ?? metadata.opencodeSessionId
        ?? metadata.grokSessionId
        ?? metadata.agySessionId
        ?? metadata.cursorSessionId
        ?? metadata.kimiSessionId
        ?? metadata.copilotSessionId
        ?? metadata.dshSessionId
        ?? undefined
}

export function toSessionSummaryMetadata(metadata: Metadata | null | undefined): SessionSummaryMetadata | null {
    if (!metadata) {
        return null
    }
    return {
        name: metadata.name,
        titleLocked: metadata.titleLocked,
        path: metadata.path,
        machineId: metadata.machineId ?? undefined,
        summary: metadata.summary ? { text: metadata.summary.text } : undefined,
        promptTitle: metadata.promptTitle,
        flavor: metadata.flavor ?? null,
        worktree: metadata.worktree,
        agentSessionId: getSummaryAgentSessionId(metadata),
        codexImportedAt: metadata.codexImportedAt,
        lifecycleState: metadata.lifecycleState,
        externalRefs: metadata.externalRefs,
        conversationHistory: metadata.capabilities?.conversationHistory,
        hapiMcpUrl: metadata.hapiMcpUrl ?? undefined,
        // Omit lastUserMessage — bridge recovery text stays in full session
        // metadata only; list/SSE summaries must not ship up to 32 KB of prompt.
        lastModelError: metadata.lastModelError
            ? (() => {
                const {
                    lastUserMessage: _omitLastUserMessage,
                    ...summaryError
                } = metadata.lastModelError
                return summaryError
            })()
            : undefined
    }
}

export function toSessionSummary(
    session: Session,
    extras?: {
        attachedJob?: AttachedJob | null
        /** Explicit SSE/list watermark; required when attachedJob is null so
         *  a REST refetch does not reset the client gate to 0. */
        attachedJobUpdatedAt?: number
    }
): SessionSummary {
    const attachedJob = extras?.attachedJob ?? null
    return {
        hasConversationContent: session.hasConversationContent ?? false,
        id: session.id,
        active: session.active,
        thinking: session.thinking,
        thinkingConfirmed: session.thinkingConfirmed,
        thinkingAt: session.thinkingAt,
        thinkingRevision: session.thinkingRevision,
        activeAt: session.activeAt,
        updatedAt: session.updatedAt,
        contentRevision: session.contentRevision,
        readState: session.readState,
        createdAt: session.createdAt,
        lastUserMessageAt: session.lastUserMessageAt,
        pinned: session.pinned ?? false,
        globalPinned: session.globalPinned ?? false,
        metadata: toSessionSummaryMetadata(session.metadata),
        metadataVersion: session.metadataVersion,
        agentStateVersion: session.agentStateVersion,
        todosUpdatedAt: session.todosUpdatedAt ?? 0,
        todoProgress: computeTodoProgress(session.todos),
        pendingRequestsCount: computePendingRequestsCount(session.agentState),
        pendingRequestKinds: computePendingRequestKinds(session.agentState),
        pendingRequests: computePendingRequests(session.agentState, session.updatedAt),
        pendingRequestsNewestAt: computePendingRequestsNewestAt(session.agentState, session.updatedAt),
        pendingRequestRefs: computePendingRequestRefs(
            session.agentState,
            session.updatedAt,
            session.blockedAck?.keys ? new Set(session.blockedAck.keys) : undefined
        ),
        backgroundTaskCount: session.backgroundTaskCount ?? 0,
        derivedToolWork: session.derivedToolWork === true,
        lastNotify: session.lastNotify ?? null,
        blockedAck: session.blockedAck ?? null,
        notifyUpdatedAt: session.notifyUpdatedAt ?? 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        attachedJob,
        attachedJobUpdatedAt: extras?.attachedJobUpdatedAt
            ?? attachedJob?.updatedAt
            ?? 0,
        model: session.model,
        modelReasoningEffort: session.modelReasoningEffort,
        effort: session.effort
    }
}
