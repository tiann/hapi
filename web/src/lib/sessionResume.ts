import { isKnownFlavor } from '@hapi/protocol'
import type { Session } from '@/types/api'

/** Agent thread id used by hub `resolveAgentResumeId`, flavor-specific.
 *  Mirrors hub: cross-flavor ids are ignored to avoid the web layer claiming a
 *  session is resumable when the hub will only honor the current flavor's id.
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
        case 'grok': return metadata.grokSessionId ?? undefined
        case 'cursor': return metadata.cursorSessionId ?? undefined
        case 'kimi': return metadata.kimiSessionId ?? undefined
        case 'pi': return metadata.piSessionId ?? undefined
        default: return metadata.claudeSessionId ?? undefined
    }
}

/**
 * Whether an inactive session can be activated via resume (or fresh spawn on first send).
 * Matches hub: resume with agent id, or fresh spawn when path exists, no agent id, no user messages.
 * Claude with messages but no `claudeSessionId` is allowed because hub
 * `recoverClaudeSessionIdFromMessages` reconstructs the resume id from the
 * stored message log (only the claude path has this recovery fallback).
 *
 * Cursor: definitive `onDisk: false` still blocks. Probe failure / unknown
 * (`undefined`) must NOT be treated as missing data — allow reopen and show
 * honest messaging (#1084).
 */
export function inactiveSessionCanResume(
    session: Session,
    userMessageCount: number,
    cursorChatOnDisk?: boolean,
): boolean {
    if (session.active) {
        return true
    }
    if (!session.metadata?.path) {
        return false
    }
    if (resolveAgentSessionIdFromMetadata(session.metadata)) {
        const flavor = isKnownFlavor(session.metadata.flavor) ? session.metadata.flavor : 'claude'
        if (flavor === 'cursor') {
            return cursorChatOnDisk !== false
        }
        return true
    }
    const flavor = isKnownFlavor(session.metadata.flavor) ? session.metadata.flavor : 'claude'
    if (flavor === 'claude' && userMessageCount > 0) {
        return true
    }
    return userMessageCount === 0
}

export type CursorReopenGateReason = 'missing' | 'checking'

/**
 * UI gate for Cursor reopen. Only definitive `onDisk: false` disables reopen.
 * Probe errors / unknown status allow the attempt (soft-fail) with optional
 * unverified messaging.
 */
export function resolveCursorReopenGate(args: {
    applicable: boolean
    onDisk: boolean | undefined
    error: string | null
    isLoading: boolean
}): { disabledReason: CursorReopenGateReason | null; probeUnverified: boolean } {
    if (!args.applicable) {
        return { disabledReason: null, probeUnverified: false }
    }
    if (args.onDisk === false) {
        return { disabledReason: 'missing', probeUnverified: false }
    }
    if (args.onDisk === true) {
        return { disabledReason: null, probeUnverified: false }
    }
    if (args.error) {
        return { disabledReason: null, probeUnverified: true }
    }
    if (args.isLoading) {
        return { disabledReason: 'checking', probeUnverified: false }
    }
    return { disabledReason: 'checking', probeUnverified: false }
}
