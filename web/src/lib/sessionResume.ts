import { isKnownFlavor } from '@hapi/protocol'
import type { Session } from '@/types/api'

/** Agent thread id used by hub `resolveAgentResumeId`, flavor-specific.
 *  Mirrors hub: cross-flavor ids are ignored to avoid the web layer claiming a
 *  session is resumable when the hub will only honor the current flavor's id.
 *  Note: pi is intentionally absent — Pi session resume is currently out of
 *  scope (see spec.md "Out of Scope"). The hub has no `piSessionId` path and
 *  the runner never persists one, so claiming the web can resume would
 *  produce a runtime "resume_unavailable" from the hub. Re-add `case 'pi'`
 *  (and a `piSessionId` field on MetadataSchema) when back-end resume ships.
 */
export function resolveAgentSessionIdFromMetadata(
    metadata: Session['metadata'] | null | undefined,
): string | undefined {
    if (!metadata) {
        return undefined
    }
    const flavor = isKnownFlavor(metadata.flavor) ? metadata.flavor : 'claude'
    switch (flavor) {
        case 'codex': return metadata.codexSessionId ?? undefined
        case 'gemini': return metadata.geminiSessionId ?? undefined
        case 'opencode': return metadata.opencodeSessionId ?? undefined
        case 'cursor': return metadata.cursorSessionId ?? undefined
        case 'kimi': return metadata.kimiSessionId ?? undefined
        default: return metadata.claudeSessionId ?? undefined
    }
}

/**
 * Whether an inactive session can be activated via resume (or fresh spawn on first send).
 * Matches hub: resume with agent id, or fresh spawn when path exists, no agent id, no user messages.
 * Claude with messages but no `claudeSessionId` is allowed because hub
 * `recoverClaudeSessionIdFromMessages` reconstructs the resume id from the
 * stored message log (only the claude path has this recovery fallback).
 * Note: pi is intentionally excluded — Pi session resume is currently out of
 * scope (see spec.md "Out of Scope"). A Pi session with messages but no
 * stored agent id cannot be resumed because the hub has no recovery path
 * for Pi. Re-add the `flavor === 'pi'` branch when back-end resume ships.
 */
export function inactiveSessionCanResume(
    session: Session,
    userMessageCount: number,
): boolean {
    if (session.active) {
        return true
    }
    if (!session.metadata?.path) {
        return false
    }
    if (resolveAgentSessionIdFromMetadata(session.metadata)) {
        return true
    }
    const flavor = isKnownFlavor(session.metadata.flavor) ? session.metadata.flavor : 'claude'
    if (flavor === 'claude' && userMessageCount > 0) {
        return true
    }
    return userMessageCount === 0
}
