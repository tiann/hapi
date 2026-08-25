import type { Session, SessionPatch } from '@/types/api'

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
    if (patch.active !== undefined) assign('active', patch.active)
    if (patch.thinking !== undefined) assign('thinking', patch.thinking)
    if (patch.activeAt !== undefined) assign('activeAt', patch.activeAt)
    // Monotonic with hub applySessionPatch: a rejected stale
    // metadata/agentState replay must not rewind updatedAt.
    if (patch.updatedAt !== undefined) {
        const nextUpdatedAt = Math.max(nextSession.updatedAt, patch.updatedAt)
        assign('updatedAt', nextUpdatedAt)
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
