import { isKnownFlavor } from '@hapi/protocol'
import type { Session } from '@/types/api'

/** Agent thread id used by hub `resolveAgentResumeId`, flavor-specific.
 *  Mirrors hub: cross-flavor ids are ignored to avoid the web layer claiming a
 *  session is resumable when the hub will only honor the current flavor's id. */
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
    return userMessageCount === 0
}
