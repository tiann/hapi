import { mergeReadState } from '@hapi/protocol'
import type { Session, SessionPatch, SessionSummary } from '@/types/api'

// Pure session-patch application logic, extracted from useSSE.ts so the rules
// are importable without React (unit tests, fixture generation, native-client
// contract references). useSSE re-exports these — hook consumers are unchanged.

// Version-monotonicity gate for structured patches carrying metadata or
// agentState. SSE reconnects + per-query invalidation can leave the cache
// holding state that's NEWER than a buffered older patch about to replay;
// applying that older patch would regress resume / session-id / pending-
// requests state. Mirrors the CLI room handler contract: strictly newer
// only. Exported so the rule is unit-testable in isolation from the hook.
export function isNewerVersionedPatch(patchVersion: number, currentVersion: number): boolean {
    return patchVersion > currentVersion
}

/**
 * True when applying `patch` to `session` would change nothing that renders.
 *
 * Keep-alive patches re-send fields about every ~10s. SessionHeader reads
 * `activeAt` for relative age, but `formatRelativeTime` only changes at
 * minute boundaries (`just now` while delta < 60s). Sub-minute `activeAt`
 * moves are therefore skipped here so the detail cache does not replace the
 * Session object (and re-render SessionChat / HappyThread) six times a
 * minute for an invisible label change. A delta of ≥60s is still
 * render-relevant so the header stays on `just now` for live sessions.
 * The session-list path still uses `isRenderIrrelevantPatch` (useSSE.ts),
 * which ignores `activeAt` entirely.
 */
export function isRenderIrrelevantSessionPatch(session: Session, patch: SessionPatch): boolean {
    const current = session as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(patch)) {
        if (
            key === 'activeAt'
            && typeof value === 'number'
            && Math.abs(value - session.activeAt) < 60_000
        ) {
            continue
        }
        if (current[key] !== value) {
            return false
        }
    }
    return true
}

/**
 * Apply a validated SessionPatch onto a detail Session. Returns null when
 * nothing render-relevant changed (keep prior object identity). Field-by-field
 * only — never wholesale-spread versioned `{ version, value }` wrappers.
 * Exported for unit tests (Copilot mode keep-alive must not be dropped).
 */
export function applySessionDetailPatch(session: Session, patch: SessionPatch): Session | null {
    if (isRenderIrrelevantSessionPatch(session, patch)) {
        return null
    }
    let changed = false
    const nextSession: Session = { ...session }
    const assign = <K extends keyof Session>(key: K, value: Session[K]) => {
        if (nextSession[key] !== value) {
            nextSession[key] = value
            changed = true
        }
    }
    if (patch.contentRevision !== undefined) assign('contentRevision', Math.max(session.contentRevision ?? 0, patch.contentRevision))
    if (patch.readState) assign('readState', mergeReadState(session.readState, patch.readState))
    if (patch.active !== undefined) assign('active', patch.active)
    // Same dual, unordered SSE streams as the list summary (#1717 cold-review
    // round 27): a stale `thinking` patch can arrive here after a fresher one
    // already landed via the other stream. An absent `thinkingAt` (older hub)
    // takes the patch unconditionally, preserving prior behaviour.
    if (patch.thinkingAt === undefined || patch.thinkingAt >= session.thinkingAt) {
        if (patch.thinking !== undefined) assign('thinking', patch.thinking)
        if (patch.thinkingConfirmed !== undefined) assign('thinkingConfirmed', patch.thinkingConfirmed)
        if (patch.thinkingAt !== undefined) assign('thinkingAt', patch.thinkingAt)
    }
    if (patch.activeAt !== undefined) assign('activeAt', patch.activeAt)
    // Monotonic with hub applySessionPatch: a rejected stale
    // metadata/agentState replay must not rewind updatedAt.
    if (patch.updatedAt !== undefined) {
        const nextUpdatedAt = Math.max(nextSession.updatedAt, patch.updatedAt)
        assign('updatedAt', nextUpdatedAt)
    }
    if (patch.lastUserMessageAt !== undefined) {
        assign('lastUserMessageAt', Math.max(nextSession.lastUserMessageAt ?? 0, patch.lastUserMessageAt))
    }
    if (patch.model !== undefined) assign('model', patch.model)
    if (patch.modelReasoningEffort !== undefined) assign('modelReasoningEffort', patch.modelReasoningEffort)
    if (patch.effort !== undefined) assign('effort', patch.effort)
    if (Object.prototype.hasOwnProperty.call(patch, 'serviceTier')) {
        assign('serviceTier', patch.serviceTier ?? null)
    }
    if (patch.permissionMode !== undefined) assign('permissionMode', patch.permissionMode)
    if (patch.collaborationMode !== undefined) assign('collaborationMode', patch.collaborationMode)
    if (patch.copilotAgentMode !== undefined) assign('copilotAgentMode', patch.copilotAgentMode)
    if (patch.backgroundTaskCount !== undefined) assign('backgroundTaskCount', patch.backgroundTaskCount)
    if (patch.backgroundTasks !== undefined) assign('backgroundTasks', patch.backgroundTasks)
    if (patch.derivedToolWork !== undefined) assign('derivedToolWork', patch.derivedToolWork)
    // Version gates: dual SSE can deliver duplicates out of order.
    // Only mark changed when a strictly newer version lands —
    // otherwise keep previous object identity (no redundant render).
    if (patch.todos !== undefined && isNewerVersionedPatch(patch.todos.version, nextSession.todosUpdatedAt ?? 0)) {
        nextSession.todos = patch.todos.value
        nextSession.todosUpdatedAt = patch.todos.version
        changed = true
    }
    if (patch.teamState !== undefined && isNewerVersionedPatch(patch.teamState.version, nextSession.teamStateUpdatedAt ?? 0)) {
        nextSession.teamState = patch.teamState.value ?? undefined
        nextSession.teamStateUpdatedAt = patch.teamState.version
        changed = true
    }
    if (patch.metadata !== undefined && isNewerVersionedPatch(patch.metadata.version, nextSession.metadataVersion)) {
        nextSession.metadata = patch.metadata.value
        nextSession.metadataVersion = patch.metadata.version
        changed = true
    }
    if (patch.agentState !== undefined && isNewerVersionedPatch(patch.agentState.version, nextSession.agentStateVersion)) {
        nextSession.agentState = patch.agentState.value
        nextSession.agentStateVersion = patch.agentState.version
        changed = true
    }
    return changed ? nextSession : null
}

/**
 * Reconcile a (possibly delayed) REST list session against the cached list
 * summary for the same row, preferring whichever side's blocker-relevant
 * fields are actually newer (#1717). Extracted from `useSessions.ts`'s
 * `queryFn` so the rule is unit-testable without rendering the hook.
 *
 * A list GET can be captured BEFORE an SSE-applied clear/dismissal and still
 * land AFTER it (slow network, tab backgrounded, etc.) — the blocker fields
 * each carry their own revision for exactly this, so the newer side wins
 * per field rather than letting whichever response happens to arrive last
 * overwrite a cache the other channel already brought up to date.
 */
export function reconcileDelayedListSession(
    prior: SessionSummary | undefined,
    incoming: SessionSummary
): SessionSummary {
    // A list GET can be captured BEFORE a clear and land after SSE applied
    // it, which would re-block the row from a stale body.
    const priorNotifyAt = prior?.notifyUpdatedAt ?? 0
    const keepPriorNotify = prior !== undefined
        && priorNotifyAt > (incoming.notifyUpdatedAt ?? 0)
    // Pending requests move on `agentStateVersion`, which advances when a
    // prompt is ANSWERED even though the notify revision may not. Governing
    // them by the notify revision let a stale snapshot restore an answered
    // prompt.
    const keepPriorPending = prior !== undefined
        && (prior.agentStateVersion ?? 0) > (incoming.agentStateVersion ?? 0)
    // `pendingRequestRefs` ALSO depends on the dismissal set
    // `computePendingRequestRefs` was given, not only on `agentStateVersion`
    // (#1717 cold-review round 25): a delayed list response captured before
    // a dismissal can omit an overflow request the SSE-applied dismissal
    // correctly kept, even though the underlying requests (and so
    // `agentStateVersion`) never changed — only which of them are dismissed
    // did. `keepPriorNotify` is exactly "the incoming dismissal is stale",
    // the other half of the same picture `agentStateVersion` cannot see, so
    // refs are preserved whenever EITHER signal is stale, even when the rest
    // of the agentState-derived bundle below is still fine to take from the
    // incoming response.
    const keepPriorRefs = prior !== undefined && (keepPriorPending || keepPriorNotify)
    // Neither `thinking` nor `thinkingConfirmed` carries its own revision
    // otherwise, so a list GET captured while the agent was still thinking
    // can land after an SSE idle patch and restore a stale `thinking: true`
    // (#1717 cold-review round 26) — which hides a genuinely unanswered
    // footer, since the attention classifier treats "still thinking" as
    // "nothing to show yet" regardless of how it got that value.
    const priorThinkingAt = prior?.thinkingAt ?? 0
    const keepPriorThinking = prior !== undefined
        && priorThinkingAt > (incoming.thinkingAt ?? 0)
    return {
        ...incoming,
        ...(keepPriorThinking && prior !== undefined
            ? {
                thinking: prior.thinking,
                thinkingConfirmed: prior.thinkingConfirmed,
                thinkingAt: priorThinkingAt
            }
            : {}),
        // The pending-request fields are part of the same blocker picture:
        // keeping the newer footer while taking older pending data brought an
        // answered prompt back into Blocked and re-fired the arrival alert.
        ...(keepPriorNotify && prior !== undefined
            ? {
                lastNotify: prior.lastNotify ?? null,
                blockedAck: prior.blockedAck ?? null,
                notifyUpdatedAt: priorNotifyAt
            }
            : {}),
        ...(keepPriorPending && prior !== undefined
            ? {
                pendingRequestsCount: prior.pendingRequestsCount,
                pendingRequestKinds: prior.pendingRequestKinds,
                pendingRequests: prior.pendingRequests,
                pendingRequestsNewestAt: prior.pendingRequestsNewestAt,
                agentStateVersion: prior.agentStateVersion
            }
            : {}),
        ...(keepPriorRefs && prior !== undefined
            ? { pendingRequestRefs: prior.pendingRequestRefs }
            : {}),
        lastUserMessageAt: Math.max(prior?.lastUserMessageAt ?? 0, incoming.lastUserMessageAt ?? 0) || undefined,
        contentRevision: Math.max(prior?.contentRevision ?? 0, incoming.contentRevision ?? 0),
        readState: mergeReadState(prior?.readState, incoming.readState)
    }
}
