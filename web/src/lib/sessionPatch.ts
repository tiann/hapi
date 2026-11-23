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
    // already landed via the other stream. Ordered by `thinkingRevision`
    // (monotonic, hub-issued), not `thinkingAt` (CLI-reported, clamped —
    // two transitions can land in the same clamped-to-"now" millisecond and
    // carry an identical value). An absent `thinkingRevision` (older hub)
    // takes the patch unconditionally, preserving prior behaviour.
    //
    // `thinkingRevision` lives only in the hub's in-memory cache (#1717 bot
    // review) — a restart resets every session's counter to 0, but an open
    // tab keeps whatever higher value it cached from the PREVIOUS process.
    // A reported 0 can therefore never actually be stale: it is either a
    // session that has never been bumped (nothing fresher exists to lose
    // to) or a post-restart reset (the cached higher value describes a
    // process that no longer exists). Either way it must win outright,
    // exactly like the absent case just above.
    //
    // That exception alone only covers the instant nothing has ticked yet
    // after a restart — if some OTHER session's activity bumps the new
    // process's counter to a small positive number before this patch
    // lands, the comparison above is none the wiser (#1717 cold-review
    // round 30). `hubGeneration` closes that gap directly: a patch from a
    // DIFFERENT process than the one this cached session describes makes
    // every cached revision stale, not just a reported 0.
    const differentHubGeneration = patch.hubGeneration !== undefined
        && session.hubGeneration !== undefined
        && patch.hubGeneration !== session.hubGeneration
    if (
        differentHubGeneration
        || patch.thinkingRevision === undefined
        || patch.thinkingRevision === 0
        || patch.thinkingRevision >= (session.thinkingRevision ?? 0)
    ) {
        if (patch.thinking !== undefined) assign('thinking', patch.thinking)
        if (patch.thinkingConfirmed !== undefined) assign('thinkingConfirmed', patch.thinkingConfirmed)
        if (patch.thinkingAt !== undefined) assign('thinkingAt', patch.thinkingAt)
        if (patch.thinkingRevision !== undefined) assign('thinkingRevision', patch.thinkingRevision)
    }
    if (patch.hubGeneration !== undefined) assign('hubGeneration', patch.hubGeneration)
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
    // the other half of the same picture `agentStateVersion` cannot see.
    //
    // But that only holds while the underlying request SET itself has not
    // moved on. Gating refs on EITHER signal alone (#1717 cold-review, bot
    // review) kept PRIOR's refs even when incoming's `agentStateVersion` was
    // STRICTLY newer — describing a request the newer agentState had already
    // replaced, while the rest of the bundle below correctly took the fresh
    // one. `agentStateVersion` not having gone backwards is the precondition;
    // staleness in either signal is only a reason to prefer prior's refs
    // once that precondition holds.
    const priorAgentStateNotOlder = (prior?.agentStateVersion ?? 0) >= (incoming.agentStateVersion ?? 0)
    const keepPriorRefs = prior !== undefined
        && priorAgentStateNotOlder
        && (keepPriorPending || keepPriorNotify)
    // Neither `thinking` nor `thinkingConfirmed` carries its own revision
    // otherwise, so a list GET captured while the agent was still thinking
    // can land after an SSE idle patch and restore a stale `thinking: true`
    // (#1717 cold-review round 26) — which hides a genuinely unanswered
    // footer, since the attention classifier treats "still thinking" as
    // "nothing to show yet" regardless of how it got that value. Ordered by
    // `thinkingRevision`, a monotonic hub-issued counter, NOT `thinkingAt`
    // (#1717 cold-review round 27): `thinkingAt` is the CLI's own clamped
    // alive-report time, and two transitions processed within the same
    // clamped-to-"now" millisecond can carry the identical value — a strict
    // `>` check on it cannot then tell which one actually happened last, so
    // the idle transition could leave the cached ordering value unchanged
    // while the flags it is supposed to protect did change.
    const priorThinkingRevision = prior?.thinkingRevision ?? 0
    const incomingThinkingRevision = incoming.thinkingRevision ?? 0
    // `thinkingRevision` lives only in the hub's in-memory cache (#1717 bot
    // review) — a restart resets every session's counter to 0, but the
    // cached PRIOR summary keeps whatever higher value it saw from the
    // previous process. A reported 0 can never actually be stale (nothing
    // fresher exists for a never-bumped session to lose to; a post-restart
    // reset means the higher cached value describes a process that no
    // longer exists), so it must win outright rather than lose this
    // comparison.
    //
    // That exception only covers the instant nothing has ticked yet: if
    // some OTHER session's activity bumps the hub's counter to a small
    // positive number before this tab's first post-restart list GET lands,
    // the comparison above is none the wiser and the stale pre-restart
    // value still wins (#1717 cold-review round 29).
    //
    // Compared directly against PRIOR's own `hubGeneration` here, not via a
    // connection-level "last seen" ref the caller threads through (#1717
    // cold-review round 31) — a ref's lifetime is the HOOK INSTANCE's,
    // while the cached row's lifetime is the QueryClient's, which outlives
    // an unmount/remount. A ref that resets on remount while a stale
    // pre-restart row is still cached reads as "no restart" when there
    // plainly was one. `prior` carries where it came from and never
    // outlives the data it describes, so reading the generation off it
    // directly is the only comparison that can't desync from the cache.
    const differentHubGeneration = prior?.hubGeneration !== undefined
        && incoming.hubGeneration !== undefined
        && prior.hubGeneration !== incoming.hubGeneration
    const keepPriorThinking = prior !== undefined
        && !differentHubGeneration
        && incomingThinkingRevision !== 0
        && priorThinkingRevision > incomingThinkingRevision
    return {
        ...incoming,
        ...(keepPriorThinking && prior !== undefined
            ? {
                thinking: prior.thinking,
                thinkingConfirmed: prior.thinkingConfirmed,
                thinkingAt: prior.thinkingAt,
                thinkingRevision: priorThinkingRevision
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
